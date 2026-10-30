"""All SQLAlchemy models. Single file keeps the modular monolith simple;
tables follow design doc §6 (trimmed, key unique keys + version fields kept).

Conventions: string UUID PKs (uuid4 hex), JSON columns for lists, Numeric
for amounts (Decimal in Python). SQLite-compatible; no Postgres-only types
(pgvector is optional/pluggable, see ADR-0004).
"""
import uuid
from datetime import datetime, timezone

from sqlalchemy import (
    JSON,
    Boolean,
    Column,
    Date,
    DateTime,
    ForeignKey,
    Integer,
    Numeric,
    String,
    Text,
    UniqueConstraint,
)
from sqlalchemy.orm import declarative_base

Base = declarative_base()


def _id():
    return uuid.uuid4().hex


def _utcnow():
    return datetime.now(timezone.utc)


class User(Base):
    __tablename__ = "users"
    id = Column(String(32), primary_key=True, default=_id)
    email = Column(String(255), unique=True, nullable=False)
    password_hash = Column(String(512), nullable=False)
    name = Column(String(100), nullable=True)
    status = Column(String(20), default="active", nullable=False)  # active|deleted
    created_at = Column(DateTime, default=_utcnow)
    deleted_at = Column(DateTime, nullable=True)


class UserProfile(Base):
    __tablename__ = "user_profiles"
    user_id = Column(String(32), ForeignKey("users.id"), primary_key=True)
    timezone = Column(String(64), default="Asia/Shanghai")
    locale = Column(String(16), default="zh-CN")
    max_cook_minutes = Column(Integer, default=35)
    people = Column(Integer, default=2)
    equipment = Column(JSON, default=list)
    taste = Column(JSON, default=list)


class DietaryRestriction(Base):
    __tablename__ = "dietary_restrictions"
    id = Column(String(32), primary_key=True, default=_id)
    user_id = Column(String(32), ForeignKey("users.id"), nullable=False)
    kind = Column(String(20), nullable=False)  # allergy|avoid|pref
    label = Column(String(100), nullable=False)
    keys = Column(JSON, default=list)
    hard = Column(Boolean, default=False)
    created_at = Column(DateTime, default=_utcnow)


class AuthSession(Base):
    __tablename__ = "auth_sessions"
    id = Column(String(32), primary_key=True, default=_id)
    user_id = Column(String(32), ForeignKey("users.id"), nullable=False)
    token_hash = Column(String(64), unique=True, nullable=False)
    csrf_token = Column(String(64), nullable=True)
    expires_at = Column(DateTime, nullable=True)
    revoked_at = Column(DateTime, nullable=True)
    created_at = Column(DateTime, default=_utcnow)


class Allergen(Base):
    __tablename__ = "allergens"
    id = Column(String(32), primary_key=True, default=_id)
    code = Column(String(64), unique=True, nullable=False)
    name = Column(String(100), nullable=False)


class Food(Base):
    __tablename__ = "foods"
    id = Column(String(64), primary_key=True)  # code, e.g. 'egg'
    name = Column(String(100), nullable=False)
    unit = Column(String(16), nullable=False)  # g|ml|piece
    piece_g = Column(Numeric(10, 2), nullable=True)
    density_g_ml = Column(Numeric(10, 4), nullable=True)
    # nutrients JSON: [kcal, protein, fat, carbs] per 100g, or null (unknown).
    # Canonical values live in nutrient_profiles/nutrient_values; this JSON
    # is the seed's per-100g snapshot kept for fast reads (see ADR notes).
    nutrients = Column(JSON, nullable=True)
    allergens = Column(JSON, default=list)
    tags = Column(JSON, default=list)
    allergen_unknown = Column(Boolean, default=False)


class NutrientProfile(Base):
    __tablename__ = "nutrient_profiles"
    id = Column(String(32), primary_key=True, default=_id)
    food_id = Column(String(64), ForeignKey("foods.id"), nullable=False)
    source = Column(String(255), default="seed: MVP 示例值 v1")
    version = Column(Integer, default=1)
    status = Column(String(20), default="active")


class NutrientValue(Base):
    __tablename__ = "nutrient_values"
    id = Column(String(32), primary_key=True, default=_id)
    profile_id = Column(String(32), ForeignKey("nutrient_profiles.id"), nullable=False)
    nutrient_code = Column(String(32), nullable=False)  # kcal|protein|fat|carbs
    amount_per_100g = Column(Numeric(12, 4), nullable=False)
    __table_args__ = (UniqueConstraint("profile_id", "nutrient_code"),)


class FoodAllergen(Base):
    __tablename__ = "food_allergens"
    food_id = Column(String(64), ForeignKey("foods.id"), primary_key=True)
    allergen_id = Column(String(32), ForeignKey("allergens.id"), primary_key=True)
    certainty = Column(String(20), default="known")  # known|possible|unknown


class Recipe(Base):
    __tablename__ = "recipes"
    id = Column(String(64), primary_key=True)
    title = Column(String(200), nullable=False)
    cook_minutes = Column(Integer, default=15)
    difficulty = Column(String(20), default="简单")
    servings = Column(Integer, default=2)
    equipment = Column(JSON, default=list)
    slots = Column(JSON, default=list)
    source = Column(String(255), nullable=True)


class RecipeIngredient(Base):
    __tablename__ = "recipe_ingredients"
    id = Column(String(32), primary_key=True, default=_id)
    recipe_id = Column(String(64), ForeignKey("recipes.id"), nullable=False)
    food_id = Column(String(64), ForeignKey("foods.id"), nullable=False)
    amount = Column(Numeric(12, 4), nullable=False)  # in food base unit
    unit = Column(String(16), nullable=False)
    optional = Column(Boolean, default=False)


class RecipeStep(Base):
    __tablename__ = "recipe_steps"
    id = Column(String(32), primary_key=True, default=_id)
    recipe_id = Column(String(64), ForeignKey("recipes.id"), nullable=False)
    step_index = Column(Integer, nullable=False)
    text = Column(Text, nullable=False)
    seconds = Column(Integer, default=0)
    __table_args__ = (UniqueConstraint("recipe_id", "step_index"),)


class RecipeFavorite(Base):
    __tablename__ = "recipe_favorites"
    user_id = Column(String(32), ForeignKey("users.id"), primary_key=True)
    recipe_id = Column(String(64), ForeignKey("recipes.id"), primary_key=True)
    created_at = Column(DateTime, default=_utcnow)


class PantryBatch(Base):
    __tablename__ = "pantry_batches"
    id = Column(String(32), primary_key=True, default=_id)
    user_id = Column(String(32), ForeignKey("users.id"), nullable=False)
    food_id = Column(String(64), ForeignKey("foods.id"), nullable=False)
    base_unit = Column(String(16), nullable=False)
    original_amount = Column(Numeric(12, 4), nullable=True)
    remaining_amount = Column(Numeric(12, 4), nullable=True)
    quantity_status = Column(String(16), default="known")  # known|unknown
    purchased_on = Column(Date, nullable=True)
    expires_on = Column(Date, nullable=True)
    location = Column(String(32), default="fridge")
    version = Column(Integer, default=1)
    created_at = Column(DateTime, default=_utcnow)


class PantryMovement(Base):
    __tablename__ = "pantry_movements"
    id = Column(String(32), primary_key=True, default=_id)
    user_id = Column(String(32), ForeignKey("users.id"), nullable=False)
    batch_id = Column(String(32), ForeignKey("pantry_batches.id"), nullable=False)
    food_id = Column(String(64), ForeignKey("foods.id"), nullable=False)
    delta = Column(Numeric(12, 4), nullable=True)  # None = unknown-qty marker
    kind = Column(String(20), nullable=False)  # OPENING|PURCHASE_IN|CONSUME|DISCARD|ADJUST|RETURN
    reason = Column(String(255), nullable=True)
    source_type = Column(String(64), nullable=False)
    source_id = Column(String(64), nullable=False)
    idempotency_key = Column(String(128), nullable=True)
    created_at = Column(DateTime, default=_utcnow)
    __table_args__ = (
        UniqueConstraint("user_id", "batch_id", "kind", "source_type", "source_id"),
        UniqueConstraint("user_id", "idempotency_key"),
    )


class ShoppingList(Base):
    __tablename__ = "shopping_lists"
    id = Column(String(32), primary_key=True, default=_id)
    user_id = Column(String(32), ForeignKey("users.id"), nullable=False)
    title = Column(String(200), default="购物清单")
    status = Column(String(20), default="active")
    created_at = Column(DateTime, default=_utcnow)


class ShoppingItem(Base):
    __tablename__ = "shopping_items"
    id = Column(String(32), primary_key=True, default=_id)
    user_id = Column(String(32), ForeignKey("users.id"), nullable=False)
    list_id = Column(String(32), ForeignKey("shopping_lists.id"), nullable=True)
    food_id = Column(String(64), ForeignKey("foods.id"), nullable=False)
    quantity = Column(Numeric(12, 4), nullable=True)
    unit = Column(String(16), nullable=False)
    origin = Column(String(16), default="manual")  # manual|plan
    plan_id = Column(String(32), nullable=True)
    plan_version = Column(Integer, nullable=True)
    status = Column(String(20), default="proposed")  # proposed|confirmed|purchased|received|cancelled
    note = Column(String(255), nullable=True)
    need_qty = Column(Numeric(12, 4), nullable=True)
    avail_qty = Column(Numeric(12, 4), nullable=True)
    incoming_qty = Column(Numeric(12, 4), nullable=True)
    first_date = Column(Date, nullable=True)
    version = Column(Integer, default=1)
    created_at = Column(DateTime, default=_utcnow)


class StockReceipt(Base):
    __tablename__ = "stock_receipts"
    id = Column(String(32), primary_key=True, default=_id)
    user_id = Column(String(32), ForeignKey("users.id"), nullable=False)
    shopping_item_id = Column(String(32), ForeignKey("shopping_items.id"), nullable=True)
    batch_id = Column(String(32), ForeignKey("pantry_batches.id"), nullable=True)
    quantity = Column(Numeric(12, 4), nullable=True)
    status = Column(String(20), default="received")
    received_at = Column(DateTime, default=_utcnow)


class CookingSession(Base):
    __tablename__ = "cooking_sessions"
    id = Column(String(32), primary_key=True, default=_id)
    user_id = Column(String(32), ForeignKey("users.id"), nullable=False)
    recipe_id = Column(String(64), ForeignKey("recipes.id"), nullable=False)
    plan_id = Column(String(32), nullable=True)
    plan_version = Column(Integer, nullable=True)
    status = Column(String(20), default="started")  # started|completed|cancelled
    started_at = Column(DateTime, default=_utcnow)
    completed_at = Column(DateTime, nullable=True)


class MealRecord(Base):
    __tablename__ = "meal_records"
    id = Column(String(32), primary_key=True, default=_id)
    user_id = Column(String(32), ForeignKey("users.id"), nullable=False)
    local_date = Column(Date, nullable=False)
    slot = Column(String(20), nullable=False)  # breakfast|lunch|dinner|snack
    title = Column(String(255), nullable=True)
    source = Column(String(20), default="manual")  # manual|plan
    planned = Column(Boolean, default=False)
    note = Column(String(255), nullable=True)
    version = Column(Integer, default=1)
    created_at = Column(DateTime, default=_utcnow)


class MealItem(Base):
    __tablename__ = "meal_items"
    id = Column(String(32), primary_key=True, default=_id)
    meal_record_id = Column(String(32), ForeignKey("meal_records.id"), nullable=False)
    user_id = Column(String(32), ForeignKey("users.id"), nullable=False)
    food_id = Column(String(64), ForeignKey("foods.id"), nullable=True)
    recipe_id = Column(String(64), ForeignKey("recipes.id"), nullable=True)
    amount = Column(Numeric(12, 4), nullable=True)  # food amount or recipe servings
    unit = Column(String(16), nullable=True)


class NutritionSnapshot(Base):
    __tablename__ = "nutrition_snapshots"
    id = Column(String(32), primary_key=True, default=_id)
    meal_record_id = Column(String(32), ForeignKey("meal_records.id"), nullable=False)
    nutrient_code = Column(String(32), nullable=False)
    amount = Column(Numeric(12, 4), nullable=False)
    completeness = Column(String(16), default="full")
    profile_ids = Column(JSON, default=list)


class MealPlan(Base):
    __tablename__ = "meal_plans"
    id = Column(String(32), primary_key=True, default=_id)
    user_id = Column(String(32), ForeignKey("users.id"), nullable=False)
    title = Column(String(200), default="本周菜单")
    period_start = Column(Date, nullable=False)
    period_end = Column(Date, nullable=False)
    active_version = Column(Integer, default=0)
    version_counter = Column(Integer, default=0)
    created_at = Column(DateTime, default=_utcnow)


class MealPlanVersion(Base):
    __tablename__ = "meal_plan_versions"
    id = Column(String(32), primary_key=True, default=_id)
    plan_id = Column(String(32), ForeignKey("meal_plans.id"), nullable=False)
    user_id = Column(String(32), ForeignKey("users.id"), nullable=False)
    version = Column(Integer, nullable=False)
    based_on_version = Column(Integer, nullable=True)
    reason = Column(String(255), nullable=True)
    created_by = Column(String(32), default="user")
    created_at = Column(DateTime, default=_utcnow)
    __table_args__ = (UniqueConstraint("plan_id", "version"),)


class PlannedMeal(Base):
    __tablename__ = "planned_meals"
    id = Column(String(32), primary_key=True, default=_id)
    plan_version_id = Column(String(32), ForeignKey("meal_plan_versions.id"), nullable=False)
    user_id = Column(String(32), ForeignKey("users.id"), nullable=False)
    local_date = Column(Date, nullable=False)
    slot = Column(String(20), nullable=False)
    recipe_id = Column(String(64), ForeignKey("recipes.id"), nullable=False)
    servings = Column(Numeric(10, 2), default=2)
    __table_args__ = (UniqueConstraint("plan_version_id", "local_date", "slot"),)


class PlanDraft(Base):
    __tablename__ = "plan_drafts"
    id = Column(String(32), primary_key=True, default=_id)
    user_id = Column(String(32), ForeignKey("users.id"), nullable=False)
    plan_id = Column(String(32), nullable=True)
    based_on_version = Column(Integer, nullable=True)
    content_json = Column(JSON, default=dict)  # {"YYYY-MM-DD|slot": {"recipe_id","servings"}}
    shopping_projection = Column(JSON, default=list)
    hard_violations = Column(JSON, default=list)
    nutrition_completeness = Column(String(16), default="unknown")
    status = Column(String(20), default="draft")  # draft|committed|expired
    created_at = Column(DateTime, default=_utcnow)


class HabitRecord(Base):
    __tablename__ = "habit_records"
    id = Column(String(32), primary_key=True, default=_id)
    user_id = Column(String(32), ForeignKey("users.id"), nullable=False)
    kind = Column(String(20), nullable=False)  # water|sleep|steps|weight|custom
    local_date = Column(Date, nullable=False)
    value = Column(Numeric(12, 4), nullable=False)
    unit = Column(String(16), nullable=True)
    source = Column(String(20), default="manual")
    created_at = Column(DateTime, default=_utcnow)


class Report(Base):
    __tablename__ = "reports"
    id = Column(String(32), primary_key=True, default=_id)
    user_id = Column(String(32), ForeignKey("users.id"), nullable=False)
    type = Column(String(20), default="weekly")
    period_start = Column(Date, nullable=False)
    period_end = Column(Date, nullable=False)
    metrics_json = Column(JSON, default=dict)
    interpretation_md = Column(Text, default="")
    status = Column(String(20), default="fresh")  # fresh|stale
    input_hash = Column(String(64), nullable=True)
    generated_at = Column(DateTime, default=_utcnow)


class ReportMetric(Base):
    __tablename__ = "report_metrics"
    id = Column(String(32), primary_key=True, default=_id)
    report_id = Column(String(32), ForeignKey("reports.id"), nullable=False)
    metric_code = Column(String(32), nullable=False)
    value = Column(Numeric(12, 4), nullable=True)
    unit = Column(String(16), nullable=True)
    observed_days = Column(Integer, default=0)
    missing_days = Column(Integer, default=0)


class Notification(Base):
    __tablename__ = "notifications"
    id = Column(String(32), primary_key=True, default=_id)
    user_id = Column(String(32), ForeignKey("users.id"), nullable=False)
    kind = Column(String(32), default="info")
    text = Column(String(500), nullable=False)
    link = Column(String(255), nullable=True)
    read = Column(Boolean, default=False)
    created_at = Column(DateTime, default=_utcnow)


class AutomationPolicy(Base):
    __tablename__ = "automation_policies"
    id = Column(String(32), primary_key=True, default=_id)
    user_id = Column(String(32), ForeignKey("users.id"), nullable=False)
    task_kind = Column(String(32), nullable=False)  # weekly_report|expiry|habit_review
    mode = Column(String(16), default="off")  # off|observe|auto
    policy_version = Column(Integer, default=1)
    __table_args__ = (UniqueConstraint("user_id", "task_kind"),)


class AgentPreferences(Base):
    __tablename__ = "agent_preferences"
    user_id = Column(String(32), ForeignKey("users.id"), primary_key=True)
    name = Column(String(24), nullable=False, default="")
    tone = Column(String(16), nullable=False, default="practical")
    persona = Column(String(16), nullable=False, default="custom", server_default="custom")
    style = Column(Text, nullable=False, default="")
    memory = Column(Text, nullable=False, default="")
    version = Column(Integer, nullable=False, default=1)


class AgentThread(Base):
    __tablename__ = "agent_threads"
    id = Column(String(32), primary_key=True, default=_id)
    user_id = Column(String(32), ForeignKey("users.id"), nullable=False)
    title = Column(String(200), default="新的对话")
    title_origin = Column(String(12), nullable=False, default="auto", server_default="legacy")
    context_json = Column(JSON, default=dict)
    status = Column(String(20), default="active")
    created_at = Column(DateTime, default=_utcnow)


class AgentRun(Base):
    __tablename__ = "agent_runs"
    id = Column(String(32), primary_key=True, default=_id)
    user_id = Column(String(32), ForeignKey("users.id"), nullable=False)
    thread_id = Column(String(32), ForeignKey("agent_threads.id"), nullable=False)
    status = Column(String(32), default="running")  # running|waiting_approval|completed|failed|cancelled
    input_text = Column(Text, nullable=True)
    provider = Column(String(20), default="rule")  # rule|deepseek
    result_json = Column(JSON, default=dict)
    context_json = Column(JSON, default=dict)
    started_at = Column(DateTime, default=_utcnow)
    finished_at = Column(DateTime, nullable=True)


class AgentRunEvent(Base):
    __tablename__ = "agent_run_events"
    id = Column(String(32), primary_key=True, default=_id)
    run_id = Column(String(32), ForeignKey("agent_runs.id"), nullable=False)
    user_id = Column(String(32), ForeignKey("users.id"), nullable=False)
    seq_no = Column(Integer, nullable=False)
    type = Column(String(40), nullable=False)
    payload_json = Column(JSON, default=dict)
    created_at = Column(DateTime, default=_utcnow)
    __table_args__ = (UniqueConstraint("run_id", "seq_no"),)


class AgentAction(Base):
    __tablename__ = "agent_actions"
    id = Column(String(32), primary_key=True, default=_id)
    user_id = Column(String(32), ForeignKey("users.id"), nullable=False)
    run_id = Column(String(32), ForeignKey("agent_runs.id"), nullable=False)
    action_type = Column(String(40), nullable=False)  # replace_meal|commit_plan|propose_shopping|record_meal
    payload_json = Column(JSON, default=dict)
    payload_hash = Column(String(64), nullable=False)
    expected_version = Column(Integer, nullable=True)
    checkpoint_thread_id = Column(String(65), nullable=True)
    status = Column(String(20), default="waiting_approval")
    idempotency_key = Column(String(128), nullable=False)
    created_at = Column(DateTime, default=_utcnow)
    committed_at = Column(DateTime, nullable=True)
    __table_args__ = (UniqueConstraint("user_id", "idempotency_key"),)


class Approval(Base):
    __tablename__ = "approvals"
    id = Column(String(32), primary_key=True, default=_id)
    user_id = Column(String(32), ForeignKey("users.id"), nullable=False)
    action_id = Column(String(32), ForeignKey("agent_actions.id"), nullable=False, unique=True)
    status = Column(String(20), default="pending")  # pending|approved|rejected|expired
    expires_at = Column(DateTime, nullable=True)
    decided_at = Column(DateTime, nullable=True)


class AgentTask(Base):
    __tablename__ = "tasks"
    id = Column(String(32), primary_key=True, default=_id)
    user_id = Column(String(32), ForeignKey("users.id"), nullable=True)
    kind = Column(String(32), nullable=False)  # weekly_report|expiry|habit_review
    name = Column(String(100), nullable=False)
    status = Column(String(20), default="scheduled")  # scheduled|queued|running|completed|failed|observe|off|pending
    next_run = Column(String(100), nullable=True)
    attempt = Column(Integer, default=0)
    payload_json = Column(JSON, default=dict)
    created_at = Column(DateTime, default=_utcnow)


class OutboxEvent(Base):
    __tablename__ = "outbox_events"
    id = Column(String(32), primary_key=True, default=_id)
    aggregate_type = Column(String(64), nullable=False)
    aggregate_id = Column(String(64), nullable=False)
    event_type = Column(String(64), nullable=False)
    payload_json = Column(JSON, default=dict)
    occurred_at = Column(DateTime, default=_utcnow)
    published_at = Column(DateTime, nullable=True)
    retry_count = Column(Integer, default=0)


class KnowledgeDoc(Base):
    __tablename__ = "knowledge_docs"
    id = Column(String(32), primary_key=True, default=_id)
    owner_user_id = Column(String(32), nullable=True)  # null = public seed knowledge
    kind = Column(String(20), default="guide")  # recipe|guide
    title = Column(String(200), nullable=False)
    content = Column(Text, nullable=False)
    source = Column(String(255), nullable=True)
    version = Column(Integer, default=1)
    created_at = Column(DateTime, default=_utcnow)


class McpCredential(Base):
    __tablename__ = "mcp_credentials"
    id = Column(String(32), primary_key=True, default=_id)
    user_id = Column(String(32), ForeignKey("users.id"), nullable=False)
    name = Column(String(100), default="mcp-client")
    scope = Column(JSON, default=list)  # e.g. ["pantry:read","recipes:read","plan:read","knowledge:read","shopping:propose","plan:propose"]
    token_hash = Column(String(64), unique=True, nullable=False)
    expires_at = Column(DateTime, nullable=True)
    revoked_at = Column(DateTime, nullable=True)
    last_used_at = Column(DateTime, nullable=True)
    created_at = Column(DateTime, default=_utcnow)


class IdempotencyRecord(Base):
    __tablename__ = "idempotency_records"
    id = Column(String(32), primary_key=True, default=_id)
    user_id = Column(String(32), ForeignKey("users.id"), nullable=False)
    operation = Column(String(64), nullable=False)
    key = Column(String(128), nullable=False)
    request_hash = Column(String(64), nullable=True)
    response_json = Column(JSON, default=dict)
    status = Column(String(20), default="done")
    created_at = Column(DateTime, default=_utcnow)
    __table_args__ = (UniqueConstraint("user_id", "operation", "key"),)


class AuditLog(Base):
    __tablename__ = "audit_logs"
    id = Column(String(32), primary_key=True, default=_id)
    user_id = Column(String(32), nullable=True)
    actor = Column(String(32), default="user")
    action = Column(String(100), nullable=False)
    target_type = Column(String(64), nullable=True)
    target_id = Column(String(64), nullable=True)
    result = Column(String(20), default="ok")
    created_at = Column(DateTime, default=_utcnow)
