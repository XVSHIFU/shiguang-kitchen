"""Per-account personalizations used as context by the kitchen assistant."""
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

from app.models import AgentPreferences

TONES = {"practical": "清楚实用", "warm": "温和自然", "concise": "简洁直接"}


PERSONAS = {
    "weeknight": ("快手掌勺", "concise", "优先给出省时、少洗锅的做法，先说怎么做，再给必要细节。"),
    "flavor": ("风味向导", "warm", "介绍菜的风味和来路，提供家用厨具能实现的调整。"),
    "pantry": ("备餐参谋", "practical", "优先用现有和临期食材，说明可替换、需补买和可提前准备的部分。"),
}


class PreferencesIn(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True, extra="forbid")

    version: int = Field(ge=0)
    name: str = Field(default="", max_length=24)
    tone: Literal["practical", "warm", "concise"] = "practical"
    persona: Literal["custom", "weeknight", "flavor", "pantry"] = "custom"
    style: str = Field(default="", max_length=500)
    memory: str = Field(default="", max_length=2000)


def read_preferences(db, user_id: str) -> dict:
    row = db.get(AgentPreferences, user_id)
    if row is None:
        return PreferencesIn(version=0).model_dump()
    return {field: getattr(row, field) for field in PreferencesIn.model_fields}



def reply_personalization(prefs: dict) -> dict:
    name, tone, style = PERSONAS.get(prefs["persona"], (prefs["name"], prefs["tone"], prefs["style"]))
    return {"管家名称": name, "回答语气": TONES[tone], "做事风格": style, "用户保存的主记忆": prefs["memory"]}
