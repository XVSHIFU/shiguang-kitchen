"""Celery app + tasks. Redis is the broker; if Redis is unavailable the
task ledger (DB `tasks` table) stays the source of truth and ordinary CRUD
is unaffected. Run with --pool=solo or CELERY_EAGER=true for smoke tests
without Redis. Worker/beat entry: celery -A app.tasks.celery_app worker/beat
"""
from datetime import date, datetime, timedelta
from decimal import Decimal

from celery import Celery

from app.core import config
from app.db import SessionLocal


def _expiring_items(db, user_id: str, days: int) -> list[dict]:
    """Batches with remaining stock (or unknown qty) expiring in [today, today+days],
    sorted by days_left ascending. Expired batches (days_left < 0) are excluded."""
    from app.models import Food, PantryBatch

    today = date.today()
    rows = db.query(PantryBatch).filter(PantryBatch.user_id == user_id).all()
    foods = {f.id: f.name for f in db.query(Food).all()}
    out = []
    for b in rows:
        if not b.expires_on:
            continue
        days_left = (b.expires_on - today).days
        if days_left < 0 or days_left > days:
            continue
        if b.quantity_status == "known" and b.remaining_amount is not None and Decimal(str(b.remaining_amount)) <= 0:
            continue
        out.append({
            "batch_id": b.id, "food_id": b.food_id,
            "food_name": foods.get(b.food_id, b.food_id),
            "remaining": float(b.remaining_amount) if b.remaining_amount is not None else None,
            "unit": b.base_unit, "expires_on": b.expires_on.isoformat(),
            "days_left": days_left, "location": b.location,
        })
    out.sort(key=lambda item: (item["days_left"], item["expires_on"]))
    return out


def notify_expiring(db, user, days: int) -> list[dict]:
    """Expiring batches for a user + deduped expiry notifications.

    Returns the same list the GET /pantry/expiring endpoint serves.
    Notification rule: one notification per user, per batch, per day —
    same text already sent today (read or unread) is skipped. No
    notification for expired batches. Users whose AutomationPolicy for
    task_kind="expiry" is off get no notification; a missing policy
    defaults to sending (seed default is observe, and expiry reminders
    are meant to actually notify — only off suppresses them).
    """
    from app.models import AutomationPolicy, Notification

    user_id = user.id if hasattr(user, "id") else str(user)
    items = _expiring_items(db, user_id, days)
    policy = db.query(AutomationPolicy).filter(
        AutomationPolicy.user_id == user_id, AutomationPolicy.task_kind == "expiry").first()
    if policy is not None and policy.mode == "off":
        return items
    today = date.today()
    existing_texts = set()
    for n in db.query(Notification).filter(
            Notification.user_id == user_id, Notification.kind == "expiry").all():
        if n.created_at is not None and n.created_at.date() == today:
            existing_texts.add(n.text)
    added = False
    for item in items:
        text = (f"临期提醒：{item['food_name']} 将在 {item['days_left']} 天后到期"
                f"（{item['expires_on']}）")
        if text in existing_texts:
            continue
        db.add(Notification(user_id=user_id, kind="expiry", text=text, link="#/pantry"))
        existing_texts.add(text)
        added = True
    if added:
        db.commit()
    return items

celery_app = Celery(
    "ai_life_agent",
    broker=config.CELERY_BROKER_URL,
    backend=config.CELERY_RESULT_BACKEND,
)
celery_app.conf.update(
    task_always_eager=config.CELERY_EAGER,
    task_acks_late=True,
    task_serializer="json",
    result_serializer="json",
    accept_content=["json"],
    beat_schedule={
        "expiry-scan": {"task": "app.tasks.expiry_scan", "schedule": {"crontab": {"hour": 8, "minute": 0}}},
    },
)


@celery_app.task(name="app.tasks.weekly_report", bind=True, max_retries=3)
def weekly_report(self, user_id: str, week_start: str | None = None):
    from app.application.weekly_reports import REPORT_TIMEZONE, generate_automatic_report, latest_due_week

    start = date.fromisoformat(week_start) if week_start else latest_due_week(datetime.now(REPORT_TIMEZONE))
    start -= timedelta(days=start.weekday())
    with SessionLocal() as db:
        return generate_automatic_report(db, user_id, start)


@celery_app.task(name="app.tasks.expiry_scan", bind=True, max_retries=3)
def expiry_scan(self, user_id: str):
    """Expiry scan: writes one deduped notification per expiring batch
    (see notify_expiring). Policy off suppresses notifications; a missing
    policy defaults to sending. Never auto-discards stock."""
    from app.models import User

    db = SessionLocal()
    try:
        user = db.query(User).filter(User.id == user_id).first()
        if user is None:
            return {"status": "skipped", "reason": "user not found"}
        items = notify_expiring(db, user, config.EXPIRY_WARN_DAYS)
        return {"status": "completed", "expiring": len(items)}
    finally:
        db.close()


@celery_app.task(name="app.tasks.dispatch_outbox", bind=True)
def dispatch_outbox(self):
    """Mark unpublished outbox events as published (no external broker in
    the smoke setup; real dispatch would publish to Redis here)."""
    from app.models import OutboxEvent
    from datetime import datetime, timezone

    db = SessionLocal()
    try:
        rows = db.query(OutboxEvent).filter(OutboxEvent.published_at.is_(None)).limit(100).all()
        for r in rows:
            r.published_at = datetime.now(timezone.utc)
        db.commit()
        return {"published": len(rows)}
    finally:
        db.close()
