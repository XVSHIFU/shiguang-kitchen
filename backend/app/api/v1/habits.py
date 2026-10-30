"""Habits + weekly reports. Missing days are `missing`, never filled with 0."""
import csv
import io
import json
import os
import xml.etree.ElementTree as ET
from datetime import date, datetime, timedelta
from decimal import Decimal

from fastapi import APIRouter, Depends, File, UploadFile
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.application import services
from app.application.weekly_reports import get_or_generate_report, lock_report_writes
from app.core.deps import get_current_user
from app.core.errors import ApiError, ok
from app.db import get_db
from app.models import HabitRecord, Report, User

router = APIRouter(tags=["habits", "reports"])


class HabitIn(BaseModel):
    kind: str
    date: date
    value: float
    unit: str | None = None


class HabitPatch(BaseModel):
    value: float | None = None
    unit: str | None = None


class ReportGenIn(BaseModel):
    week_start: date


def _habit_dict(r: HabitRecord) -> dict:
    return {"id": r.id, "kind": r.kind, "date": r.local_date.isoformat(),
            "value": float(r.value), "unit": r.unit}


_IMPORT_MAX_BYTES = 10 * 1024 * 1024
_IMPORT_KINDS = {"water": "ml", "sleep": "h", "steps": "steps", "weight": "kg"}
# Within one file, steps/sleep/water accumulate to the day's total; weight
# keeps the last sample of the day. Upsert then overwrites the stored
# (date, kind) record with that imported day-total (water included).
_IMPORT_SUM_KINDS = {"water", "sleep", "steps"}

_APPLE_STEPS = "HKQuantityTypeIdentifierStepCount"
_APPLE_SLEEP = "HKCategoryTypeIdentifierSleepAnalysis"
_APPLE_SLEEP_ASLEEP = "HKCategoryValueSleepAnalysisAsleep"
_APPLE_WEIGHT = "HKQuantityTypeIdentifierBodyMass"


def _parse_apple_dt(raw: str) -> datetime:
    raw = raw.strip()
    for fmt in ("%Y-%m-%d %H:%M:%S %z", "%Y-%m-%d %H:%M:%S"):
        try:
            return datetime.strptime(raw, fmt)
        except ValueError:
            continue
    return datetime.fromisoformat(raw)


def _parse_apple_xml(stream, aggregated: dict, failed: list) -> int:
    """Stream-parse export.xml with iterparse (never loads the whole file).

    Returns the number of ignored samples (other types / non-asleep sleep).
    `aggregated` maps (date, kind) -> float; `failed` collects per-record errors.
    """
    skipped = 0
    idx = 0
    try:
        context = ET.iterparse(stream, events=("end",))
        for _event, elem in context:
            if elem.tag != "Record":
                elem.clear()
                continue
            idx += 1
            try:
                rtype = elem.get("type")
                if rtype == _APPLE_STEPS:
                    day = date.fromisoformat(elem.get("startDate", "")[:10])
                    key = (day, "steps")
                    aggregated[key] = aggregated.get(key, 0.0) + float(elem.get("value"))
                elif rtype == _APPLE_SLEEP:
                    if elem.get("value") != _APPLE_SLEEP_ASLEEP:
                        skipped += 1
                    else:
                        start = _parse_apple_dt(elem.get("startDate", ""))
                        end = _parse_apple_dt(elem.get("endDate", ""))
                        hours = (end - start).total_seconds() / 3600.0
                        if hours < 0:
                            raise ValueError("睡眠样本 endDate 早于 startDate")
                        day = start.date()
                        key = (day, "sleep")
                        aggregated[key] = aggregated.get(key, 0.0) + hours
                elif rtype == _APPLE_WEIGHT:
                    day = date.fromisoformat(elem.get("startDate", "")[:10])
                    aggregated[(day, "weight")] = float(elem.get("value"))
                else:
                    skipped += 1
            except (ValueError, TypeError, AttributeError) as e:
                failed.append({"line": idx, "reason": f"样本解析失败：{e}"})
            finally:
                elem.clear()
    except ET.ParseError as e:
        raise ApiError(422, "VALIDATION_ERROR", f"export.xml 解析失败：{e}")
    return skipped


def _parse_import_csv(stream, aggregated: dict, failed: list) -> int:
    """CSV with header date,kind,value. Returns skipped (blank rows)."""
    text = io.TextIOWrapper(stream, encoding="utf-8-sig", newline="")
    reader = csv.DictReader(text)
    if reader.fieldnames is None or not {"date", "kind", "value"} <= {h.strip() for h in reader.fieldnames if h}:
        raise ApiError(422, "VALIDATION_ERROR", "CSV 表头必须是 date,kind,value")
    skipped = 0
    for row in reader:
        line = reader.line_num
        raw_date = (row.get("date") or "").strip()
        kind = (row.get("kind") or "").strip()
        raw_value = (row.get("value") or "").strip()
        if not raw_date and not kind and not raw_value:
            skipped += 1
            continue
        try:
            day = date.fromisoformat(raw_date)
            if kind not in _IMPORT_KINDS:
                raise ValueError(f"kind 不支持：{kind or '(空)'}，仅支持 water/sleep/steps/weight")
            value = float(raw_value)
        except (ValueError, TypeError) as e:
            failed.append({"line": line, "reason": str(e)})
            continue
        key = (day, kind)
        if kind in _IMPORT_SUM_KINDS:
            aggregated[key] = aggregated.get(key, 0.0) + value
        else:
            aggregated[key] = value
    return skipped


@router.post("/habits/import")
def import_habits(file: UploadFile = File(...), db: Session = Depends(get_db),
                  user: User = Depends(get_current_user)):
    """Import health data: Apple Health export.xml or CSV (date,kind,value).

    Multipart field ``file``, max 10 MB. Dedup/overwrite by (date, kind):
    an existing record for that day+kind is overwritten with the imported
    day-total (water too — the imported value is the day's total, not an
    increment), never duplicated. One bad row is recorded in ``failed``
    and never aborts the import. ``source`` is set to "import".
    """
    stream = file.file
    stream.seek(0, os.SEEK_END)
    if stream.tell() > _IMPORT_MAX_BYTES:
        raise ApiError(422, "VALIDATION_ERROR", "文件超过 10MB 限制")
    stream.seek(0)
    head = stream.read(512)
    stream.seek(0)
    name = (file.filename or "").lower()
    is_xml = name.endswith(".xml") or head.lstrip().startswith(b"<?xml") or b"<HealthData" in head[:512]
    is_csv = name.endswith(".csv") or head.lstrip().startswith(b"date,kind,value")
    if not is_xml and not is_csv:
        raise ApiError(422, "VALIDATION_ERROR", "不支持的文件类型：仅支持 Apple 健康 export.xml 或 CSV（date,kind,value）")
    aggregated: dict[tuple[date, str], float] = {}
    failed: list[dict] = []
    skipped = _parse_apple_xml(stream, aggregated, failed) if is_xml else _parse_import_csv(stream, aggregated, failed)
    imported = 0
    for (day, kind), value in sorted(aggregated.items()):
        unit = _IMPORT_KINDS[kind]
        existing = db.query(HabitRecord).filter(
            HabitRecord.user_id == user.id, HabitRecord.kind == kind,
            HabitRecord.local_date == day).order_by(HabitRecord.created_at).all()
        if existing:
            keep = existing[0]
            keep.value = Decimal(str(value))
            keep.unit = unit
            keep.source = "import"
            for extra in existing[1:]:
                db.delete(extra)
        else:
            db.add(HabitRecord(user_id=user.id, kind=kind, local_date=day,
                               value=Decimal(str(value)), unit=unit, source="import"))
        services.mark_reports_stale(db, user, day)
        imported += 1
    db.commit()
    return ok({"imported": imported, "skipped": skipped, "failed": failed})


@router.get("/habits/records")
def list_habits(kind: str | None = None, date_from: date | None = None, date_to: date | None = None,
                db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    q = db.query(HabitRecord).filter(HabitRecord.user_id == user.id)
    if kind:
        q = q.filter(HabitRecord.kind == kind)
    if date_from:
        q = q.filter(HabitRecord.local_date >= date_from)
    if date_to:
        q = q.filter(HabitRecord.local_date <= date_to)
    return ok([_habit_dict(r) for r in q.order_by(HabitRecord.local_date).all()])


@router.post("/habits/records")
def create_habit(body: HabitIn, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    if body.kind not in ("water", "sleep", "steps", "weight", "custom"):
        raise ApiError(422, "VALIDATION_ERROR", "kind 不合法")
    r = HabitRecord(user_id=user.id, kind=body.kind, local_date=body.date, value=body.value, unit=body.unit)
    db.add(r)
    services.mark_reports_stale(db, user, body.date)
    db.commit()
    return ok(_habit_dict(r), status=201)


@router.patch("/habits/records/{rid}")
def patch_habit(rid: str, body: HabitPatch, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    r = db.query(HabitRecord).filter(HabitRecord.id == rid, HabitRecord.user_id == user.id).first()
    if r is None:
        raise ApiError(404, "NOT_FOUND", "习惯记录不存在")
    if body.value is not None:
        r.value = body.value
    if body.unit is not None:
        r.unit = body.unit
    services.mark_reports_stale(db, user, r.local_date)
    db.commit()
    return ok(_habit_dict(r))


@router.delete("/habits/records/{rid}")
def delete_habit(rid: str, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    r = db.query(HabitRecord).filter(HabitRecord.id == rid, HabitRecord.user_id == user.id).first()
    if r is None:
        raise ApiError(404, "NOT_FOUND", "习惯记录不存在")
    services.mark_reports_stale(db, user, r.local_date)
    db.delete(r)
    db.commit()
    return ok({})


@router.get("/habits/summary")
def habit_summary(date_from: date | None = None, date_to: date | None = None,
                  db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    to = date_to or services.today()
    frm = date_from or (to - timedelta(days=6))
    rows = db.query(HabitRecord).filter(HabitRecord.user_id == user.id,
                                        HabitRecord.local_date >= frm, HabitRecord.local_date <= to).all()
    days = (to - frm).days + 1
    by_kind: dict[str, dict] = {}
    for r in rows:
        by_kind.setdefault(r.kind, {"total": 0.0, "count": 0, "days": set()})
        by_kind[r.kind]["total"] += float(r.value)
        by_kind[r.kind]["count"] += 1
        by_kind[r.kind]["days"].add(r.local_date.isoformat())
    summary = {k: {"total": round(v["total"], 1), "count": v["count"],
                   "avg_per_recorded_day": round(v["total"] / len(v["days"]), 1) if v["days"] else None,
                   "recorded_days": len(v["days"]), "missing_days": days - len(v["days"])}
               for k, v in by_kind.items()}
    return ok({"from": frm.isoformat(), "to": to.isoformat(), "days": days, "summary": summary})


def _report_dict(rp: Report) -> dict:
    return {"id": rp.id, "type": rp.type, "week_start": rp.period_start.isoformat(),
            "period_end": rp.period_end.isoformat(), "status": rp.status,
            "metrics": rp.metrics_json or {}, "text": rp.interpretation_md or "",
            "generated_at": rp.generated_at.isoformat() if rp.generated_at else None}


@router.get("/reports")
def list_reports(db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    rows = db.query(Report).filter(Report.user_id == user.id).order_by(Report.period_start.desc()).all()
    return ok([_report_dict(r) for r in rows])


@router.post("/reports/generate")
def generate_report(body: ReportGenIn, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    week_start = body.week_start - timedelta(days=body.week_start.weekday())  # normalize to Monday
    lock_report_writes(db, user.id)
    report, created = get_or_generate_report(db, user, week_start)
    if not created:
        return ok({"report": _report_dict(report), "duplicated": True})
    db.commit()
    return ok({"report": _report_dict(report)}, status=201)



@router.get("/reports/{rid}")
def get_report(rid: str, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    rp = db.query(Report).filter(Report.id == rid, Report.user_id == user.id).first()
    if rp is None:
        raise ApiError(404, "NOT_FOUND", "报告不存在")
    return ok(_report_dict(rp))


@router.get("/reports/{rid}/export")
def export_report(rid: str, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    rp = db.query(Report).filter(Report.id == rid, Report.user_id == user.id).first()
    if rp is None:
        raise ApiError(404, "NOT_FOUND", "报告不存在")
    md = f"# 周报 {rp.period_start.isoformat()} ~ {rp.period_end.isoformat()}\n\n{rp.interpretation_md or ''}\n\n```json\n{json.dumps(rp.metrics_json, ensure_ascii=False, indent=2)}\n```\n"
    return ok({"markdown": md, "report_id": rp.id})
