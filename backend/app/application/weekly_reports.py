"""Shared weekly report generation for the API and scheduled runs."""
import hashlib
import json
from datetime import date, datetime, time, timedelta
from uuid import NAMESPACE_URL, uuid5
from zoneinfo import ZoneInfo

from sqlalchemy import text
from sqlalchemy.orm import Session

from app.application import services
from app.models import AutomationPolicy, Notification, Report, ReportMetric, User


REPORT_TIMEZONE = ZoneInfo("Asia/Shanghai")
REPORT_HOUR = 20


def latest_due_week(now: datetime) -> date:
    local_now = now.astimezone(REPORT_TIMEZONE)
    sunday = local_now.date() - timedelta(days=(local_now.weekday() + 1) % 7)
    if local_now < datetime.combine(sunday, time(REPORT_HOUR), REPORT_TIMEZONE):
        sunday -= timedelta(days=7)
    return sunday - timedelta(days=6)


def lock_report_writes(db: Session, user_id: str):
    if db.get_bind().dialect.name == "sqlite":
        # SQLite needs a write lock before reading the report or its inputs.
        db.execute(text("BEGIN IMMEDIATE"))
    else:
        db.query(User.id).filter_by(id=user_id).with_for_update().one_or_none()


def get_or_generate_report(db: Session, user: User, start: date, *, through: date | None = None):
    metrics = services.compute_report_metrics(db, user, start, through=through)
    input_hash = hashlib.sha256(json.dumps(metrics, sort_keys=True).encode()).hexdigest()
    existing = db.query(Report).filter_by(
        user_id=user.id, type="weekly", period_start=start, input_hash=input_hash, status="fresh",
    ).first()
    if existing:
        return existing, False
    report = Report(
        user_id=user.id, type="weekly", period_start=start, period_end=start + timedelta(days=6),
        metrics_json=metrics, interpretation_md=services.report_text(metrics), status="fresh",
        input_hash=input_hash,
    )
    db.add(report)
    db.flush()
    for code, value in metrics.items():
        if isinstance(value, (int, float)):
            db.add(ReportMetric(
                report_id=report.id, metric_code=code, value=value,
                observed_days=metrics["record_days"], missing_days=metrics["missing_days"],
            ))
    return report, True


def generate_automatic_report(db: Session, user_id: str, start: date) -> dict:
    lock_report_writes(db, user_id)
    user = db.get(User, user_id)
    policy = db.query(AutomationPolicy).filter_by(user_id=user_id, task_kind="weekly_report")
    if db.get_bind().dialect.name != "sqlite":
        policy = policy.with_for_update()
    policy = policy.one_or_none()
    if user is None or user.status != "active" or policy is None or policy.mode != "auto":
        return {"status": "skipped"}
    notice_id = uuid5(NAMESPACE_URL, f"shiguang:weekly-report:{user_id}:{start.isoformat()}").hex
    if db.get(Notification, notice_id):
        return {"status": "completed", "duplicated": True}
    end = start + timedelta(days=6)
    report, _ = get_or_generate_report(db, user, start, through=end)
    db.add(Notification(
        id=notice_id, user_id=user_id, kind="report", link=f"#/reports?week={start.isoformat()}",
        text=f"每周周报已生成（{start:%m/%d}–{end:%m/%d}）",
    ))
    db.commit()
    return {"status": "completed", "report_id": report.id}
