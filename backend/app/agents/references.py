"""Validate chat references against runs belonging to the current account."""
import re
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy.orm import Session

from app.core.errors import ApiError
from app.models import AgentRun
from app.rag.bm25 import _public_indexes

REFERENCE_MARKER = "\n\n**相关参考**\n"
REFERENCE = re.compile(r"^- \[(.+) · (程序员做饭指南|CookLikeHOC · 原文)\]\(<(https://github\.com/[^>]+)>\)$")


class QuoteIn(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True, extra="forbid")

    source_run_id: str = Field(min_length=1, max_length=32)
    kind: Literal["message", "selection", "reference"] = "selection"
    text: str = Field(min_length=1, max_length=1600)
    url: str | None = Field(default=None, max_length=650)


def reply_references(run: AgentRun) -> dict[str, str]:
    text = (run.result_json or {}).get("text", "")
    _, marker, tail = text.rpartition(REFERENCE_MARKER)
    if not marker:
        return {}
    references = {}
    for line in tail.strip().splitlines():
        match = REFERENCE.fullmatch(line)
        if not match:
            return {}
        title, source, url = match.groups()
        prefix = "Anduin2017/HowToCook" if source == "程序员做饭指南" else "Gar-b-age/CookLikeHOC"
        if url.startswith(f"https://github.com/{prefix}/blob/"):
            references[url] = title
    return references


def read_quote(db: Session, user_id: str, thread_ids: set[str], quote: QuoteIn) -> dict:
    run = db.query(AgentRun).filter_by(id=quote.source_run_id, user_id=user_id).first()
    if run is None or run.thread_id not in thread_ids:
        raise ApiError(404, "REFERENCE_NOT_FOUND", "找不到引用的消息")
    value = quote.model_dump(exclude_none=True)
    if quote.kind == "reference":
        title = reply_references(run).get(quote.url or "")
        if not title:
            raise ApiError(404, "REFERENCE_NOT_FOUND", "找不到这份参考菜谱")
        value["text"] = title
    else:
        value.pop("url", None)
    return value


def cooking_guide(run: AgentRun, url: str) -> dict:
    title = reply_references(run).get(url)
    if not title:
        raise ApiError(404, "REFERENCE_NOT_FOUND", "找不到这份参考菜谱")
    doc = next((item for item in _public_indexes()["how"].docs if item.get("source") == url), None)
    steps = []
    if doc:
        in_steps = False
        for line in doc["content"].splitlines():
            if line.startswith("#"):
                if in_steps:
                    break
                in_steps = line.lstrip("# ").strip() in {"操作", "步骤", "做法", "制作步骤", "烹饪步骤"}
            elif in_steps:
                step = re.match(r"^\s*(?:[-*]|\d+[.、])\s+(.+)", line)
                if step:
                    steps.append(step[1].strip("* "))
    return {"title": title, "steps": steps[:30], "url": url}
