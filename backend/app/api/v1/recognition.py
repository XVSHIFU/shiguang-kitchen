"""拍照识别：图片 -> 候选食材 / 菜谱，只出候选，不写任何库存/记餐数据。

路由注册（由协调员在 main.py 集成时加一行）：
    from app.api.v1 import recognition as recognition_router
    app.include_router(recognition_router.router, prefix="/api/v1")
"""
import base64
import json
import re
import unicodedata

import httpx
from fastapi import APIRouter, Depends, File, Form, UploadFile
from sqlalchemy.orm import Session

from app.agents import llm
from app.core.deps import get_current_user
from app.core.errors import ApiError, ok
from app.db import get_db
from app.models import Food, Recipe, User

router = APIRouter(tags=["recognition"])

MAX_IMAGE_BYTES = 5 * 1024 * 1024
ALLOWED_EXTS = {".jpg", ".jpeg", ".png", ".webp", ".gif", ".bmp", ".heic", ".heif"}
EXT_TO_MEDIA_TYPE = {
    ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png",
    ".webp": "image/webp", ".gif": "image/gif", ".bmp": "image/bmp",
    ".heic": "image/heic", ".heif": "image/heif",
}
ALLOWED_UNITS = ("g", "ml", "piece")

# 别名 -> 食物库标准名（标准名本身也直接命中）。不在库中的标准名
# （如 白菜）映射后仍查不到，food_id 为 null，由前端行内改选。
ALIASES = {
    "西红柿": "番茄",
    "马铃薯": "土豆",
    "蛋": "鸡蛋",
    "青菜": "小白菜",
    "红萝卜": "胡萝卜",
    "青瓜": "黄瓜",
    "牛腩": "牛肉",
    "三文鱼刺身": "三文鱼",
    "米饭": "大米",
    "米": "大米",
    "大白菜": "白菜",
    "鸡腿": "鸡腿肉",
    "猪肉": "猪瘦肉",
    "面条": "挂面",
    "面包": "吐司",
    "油": "食用油",
    "酱油": "生抽",
    "蒜": "大蒜",
    "葱": "小葱",
    "鲜奶": "牛奶",
    "燕麦": "燕麦片",
    "虾": "虾仁",
    "意大利面": "意面",
    "松花蛋": "皮蛋",
}


def _normalize(name: str) -> str:
    """去空格/大小写、全角转半角，便于别名与库名比对。"""
    s = unicodedata.normalize("NFKC", name or "")
    return re.sub(r"\s+", "", s).lower()


def _food_index(db: Session) -> dict[str, Food]:
    return {_normalize(f.name): f for f in db.query(Food).all()}


def _map_food(name: str, index: dict[str, Food]) -> Food | None:
    canonical = ALIASES.get(_normalize(name), _normalize(name))
    return index.get(canonical)


def _to_number(v):
    if isinstance(v, bool):
        return None
    if isinstance(v, (int, float)):
        return v
    if isinstance(v, str):
        try:
            return float(v) if "." in v else int(v)
        except ValueError:
            return None
    return None


def _confidence(v) -> str:
    return "high" if v == "high" else "low"


def _extract_json(text: str):
    """先整体解析；失败则提取文本中第一个 {...} JSON 块再试。"""
    if not text:
        return None
    try:
        data = json.loads(text)
        return data if isinstance(data, dict) else None
    except (json.JSONDecodeError, ValueError):
        pass
    for pattern in (r"\{.*\}", r"\{.*?\}"):
        m = re.search(pattern, text, re.S)
        if m:
            try:
                data = json.loads(m.group(0))
                if isinstance(data, dict):
                    return data
            except (json.JSONDecodeError, ValueError):
                continue
    return None


def _pantry_prompt(food_vocab: str) -> str:
    return (
        "识别图中所有食材，只返回 JSON，不要输出任何其他文字。\n"
        f"候选食物（优先从中选，名称用候选名）：{food_vocab}。\n"
        "返回格式：{\"candidates\": [{\"name\": \"食物名\", \"qty\": 数字或null, "
        "\"unit\": \"g\"|\"ml\"|\"piece\", \"confidence\": \"high\"|\"low\", "
        "\"expires_days\": 数字或null, \"note\": \"简短说明\"}]}。\n"
        "qty 为图中可估计的数量（克/毫升/个数），无法判断时填 null，不要猜测数字；"
        "expires_days 为估计剩余保质天数，无法判断时填 null；"
        "confidence 只能是 high 或 low。"
    )


def _meal_prompt(food_vocab: str, recipe_vocab: str) -> str:
    return (
        "识别图中的菜品与食材，只返回 JSON，不要输出任何其他文字。\n"
        f"候选菜谱（优先从中选，recipe_id 用候选 id）：{recipe_vocab}。\n"
        f"候选食物（优先从中选，名称用候选名）：{food_vocab}。\n"
        "返回格式：{\"recipes\": [{\"recipe_id\": \"候选菜谱 id 或null\", "
        "\"title\": \"菜谱名\", \"confidence\": \"high\"|\"low\"}], "
        "\"items\": [{\"name\": \"食物名\", \"amount\": 数字或null, "
        "\"unit\": \"g\"|\"ml\"|\"piece\", \"confidence\": \"high\"|\"low\"}]}。\n"
        "amount 无法判断时填 null，不要猜测数字；confidence 只能是 high 或 low。"
    )


@router.post("/recognition/image")
async def recognize_image(
    file: UploadFile = File(...),
    target: str = Form("pantry"),
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    if target not in ("pantry", "meal"):
        raise ApiError(422, "VALIDATION_ERROR", "target 必须是 pantry|meal")
    try:
        content = await file.read()
    except Exception:
        raise ApiError(422, "VALIDATION_ERROR", "图片读取失败")
    if len(content) > MAX_IMAGE_BYTES:
        raise ApiError(413, "FILE_TOO_LARGE", "图片超过 5MB")
    filename = (file.filename or "").lower()
    ext = "." + filename.rsplit(".", 1)[-1] if "." in filename else ""
    content_type = (file.content_type or "").lower()
    if ext and ext not in ALLOWED_EXTS:
        raise ApiError(422, "VALIDATION_ERROR", "请上传图片文件")
    if content_type and content_type != "application/octet-stream" and not content_type.startswith("image/"):
        raise ApiError(422, "VALIDATION_ERROR", "请上传图片文件")
    if not ext and not content_type.startswith("image/"):
        raise ApiError(422, "VALIDATION_ERROR", "请上传图片文件")

    if not llm.provider_available():
        raise ApiError(503, "MODEL_NOT_CONFIGURED", "未配置模型 key，当前为演示候选")

    media_type = content_type if content_type.startswith("image/") else EXT_TO_MEDIA_TYPE.get(ext, "image/jpeg")
    foods = db.query(Food).order_by(Food.id).all()
    food_vocab = "、".join(f"{f.name}({f.id})" for f in foods)
    image_b64 = base64.b64encode(content).decode("ascii")
    if target == "pantry":
        prompt = _pantry_prompt(food_vocab)
    else:
        recipes = db.query(Recipe).order_by(Recipe.id).all()
        recipe_vocab = "、".join(f"{r.id}: {r.title}" for r in recipes)
        prompt = _meal_prompt(food_vocab, recipe_vocab)

    try:
        out = llm.vision_chat_complete(image_b64, media_type, prompt)
    except httpx.HTTPStatusError as e:
        status = e.response.status_code if e.response is not None else "未知"
        raise ApiError(502, "MODEL_CALL_FAILED", f"模型调用失败：上游状态 {status}")
    except Exception as e:  # noqa: BLE001
        raise ApiError(502, "MODEL_CALL_FAILED", f"模型调用失败：{str(e)[:200]}")

    data = _extract_json(out.get("text", ""))
    if data is None:
        raise ApiError(502, "MODEL_PARSE_ERROR", "模型返回无法解析，请重试")

    index = _food_index(db)
    if target == "pantry":
        candidates = []
        for c in data.get("candidates") or []:
            if not isinstance(c, dict) or not c.get("name"):
                continue
            food = _map_food(str(c["name"]), index)
            unit = c.get("unit") if c.get("unit") in ALLOWED_UNITS else (food.unit if food else "g")
            candidates.append({
                "food_id": food.id if food else None,
                "name": str(c["name"]),
                "qty": _to_number(c.get("qty")),
                "unit": unit,
                "confidence": _confidence(c.get("confidence")),
                "expires_days": _to_number(c.get("expires_days")),
                "note": str(c.get("note") or ""),
            })
        return ok({"target": "pantry", "demo": False, "candidates": candidates})

    recipes_by_id = {r.id: r for r in db.query(Recipe).all()}
    recipes_by_title = {_normalize(r.title): r for r in recipes_by_id.values()}
    recipes_out = []
    for r in data.get("recipes") or []:
        if not isinstance(r, dict):
            continue
        rid = r.get("recipe_id")
        recipe = recipes_by_id.get(rid) if isinstance(rid, str) else None
        if recipe is None and r.get("title"):
            recipe = recipes_by_title.get(_normalize(str(r["title"])))
        recipes_out.append({
            "recipe_id": recipe.id if recipe else None,
            "title": str(r.get("title") or (recipe.title if recipe else "")),
            "confidence": _confidence(r.get("confidence")),
        })
    items = []
    for it in data.get("items") or []:
        if not isinstance(it, dict) or not it.get("name"):
            continue
        food = _map_food(str(it["name"]), index)
        unit = it.get("unit") if it.get("unit") in ALLOWED_UNITS else (food.unit if food else "g")
        items.append({
            "food_id": food.id if food else None,
            "name": str(it["name"]),
            "amount": _to_number(it.get("amount")),
            "unit": unit,
            "confidence": _confidence(it.get("confidence")),
        })
    return ok({"target": "meal", "demo": False, "recipes": recipes_out, "items": items})
