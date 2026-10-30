"""Seed data: faithful migration of the MVP index.html seed().

Sources: FOODS (35) + RECIPES (16) from app/seed_data.py, extracted verbatim
from ~/workspace/user/files/index.html. Demo user, pantry, plan v1+v2,
meals, habits, shopping, reports and notifications are generated relative
to *today* (never hardcoded to 2026-11-17). Idempotent: re-running skips
existing foods/recipes/user content.
"""
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal

from sqlalchemy.orm import Session

from app.application import services
from app.core.security import hash_password
from app.models import (
    AgentTask,
    Allergen,
    AutomationPolicy,
    DietaryRestriction,
    Food,
    FoodAllergen,
    HabitRecord,
    KnowledgeDoc,
    MealPlan,
    Notification,
    NutrientProfile,
    NutrientValue,
    PantryMovement,
    Recipe,
    RecipeIngredient,
    RecipeStep,
    ShoppingItem,
    User,
    UserProfile,
)
from app.seed_data import FOODS, RECIPES

DEMO_EMAIL = "demo@example.com"
DEMO_PASSWORD = "Demo1234!"

GUIDANCE = [
    ("食物储存：冷藏与冷冻", "容易变质的肉、鱼、奶制品应尽快放入冰箱冷藏（约 4°C），短期内不吃的肉类可分装冷冻。剩菜放凉后及时冷藏，不要在室温放置过久。不同食物分开存放，避免生熟交叉。"),
    ("剩菜处理", "剩菜再次食用前应彻底加热。外观、气味异常或存放时间过长时不要食用。建议按一餐的量分装，标注日期，先做先吃。"),
    ("均衡膳食的一般原则", "日常饮食可参考多样化搭配：主食、蔬菜、蛋白质来源（肉、蛋、豆制品、鱼）和适量水果。没有一种食物能提供全部营养，种类丰富比单一“超级食物”更重要。本建议为一般性内容，不是医疗或治疗性饮食建议。"),
    ("饮水习惯", "成年人日常饮水需求因活动量和天气而异。可以在固定时间点少量多次饮水，运动或出汗多时适当增加。口渴、尿色明显偏深是常见的缺水信号之一。"),
    ("睡眠习惯", "保持相对固定的作息时间、睡前减少强光和刺激性内容，有助于睡眠。长期睡眠问题请咨询专业人士，本内容不构成医疗建议。"),
    ("日常活动", "把活动拆成小段更容易坚持，例如饭后散步、上下楼梯、做家务。运动强度应循序渐进，身体不适时及时休息。"),
    ("厨房安全", "处理生肉后要洗手并清洁刀具砧板；生熟食物分开。油锅起火不要用水扑灭，应盖上锅盖并关闭火源。"),
    ("采购清单的使用", "按本周菜单列出采购清单，先核对家里已有的库存再买，避免重复购买。易腐食材按需购买，耐储存食材可适当备货。"),
    ("调味品与盐油", "做菜时可以先少放盐和油，尝过后再调整。酱油、豆瓣酱等本身含盐，搭配使用时注意总量。"),
    ("食材解冻", "冷冻食材建议提前移到冷藏室缓慢解冻，或用密封袋冷水解冻。解冻后的食材不宜再次冷冻，应尽快烹饪食用。"),
]

NUTRIENT_CODES = ["kcal", "protein", "fat", "carbs"]


def _monday(d: date) -> date:
    return d - timedelta(days=d.weekday())


def seed_all(db: Session, *, demo: bool = True) -> dict:
    result = {"foods": 0, "recipes": 0, "demo_user": False, "seeded": False}

    # ---- foods / allergens / nutrient profiles ----
    if db.query(Food).count() == 0:
        allergen_ids: dict[str, str] = {}
        for code in sorted({a for f in FOODS.values() for a in f.get("al", [])}):
            al = Allergen(code=code, name=code)
            db.add(al)
            db.flush()
            allergen_ids[code] = al.id
        for code, f in FOODS.items():
            food = Food(id=code, name=f["name"], unit=f["unit"],
                        piece_g=Decimal(str(f["pieceG"])) if f.get("pieceG") else None,
                        density_g_ml=Decimal(str(f["density"])) if f.get("density") else None,
                        nutrients=f["n"], allergens=f.get("al", []),
                        tags=f.get("tags", []), allergen_unknown=bool(f.get("alUnknown")))
            db.add(food)
            result["foods"] += 1
            if f["n"] is not None:
                prof = NutrientProfile(food_id=code, source="seed: MVP 示例值 v1")
                db.add(prof)
                db.flush()
                for c, v in zip(NUTRIENT_CODES, f["n"]):
                    db.add(NutrientValue(profile_id=prof.id, nutrient_code=c, amount_per_100g=Decimal(str(v))))
            for a in f.get("al", []):
                db.add(FoodAllergen(food_id=code, allergen_id=allergen_ids[a], certainty="known"))
        db.flush()

    # ---- recipes ----
    if db.query(Recipe).count() == 0:
        for r in RECIPES:
            db.add(Recipe(id=r["id"], title=r["t"], cook_minutes=r["min"], difficulty=r["diff"],
                          servings=r["serv"], equipment=r["eq"], slots=r["slots"], source=r["src"]))
            for ing in r["ing"]:
                food = FOODS[ing[0]]
                db.add(RecipeIngredient(recipe_id=r["id"], food_id=ing[0], amount=Decimal(str(ing[1])),
                                        unit=food["unit"], optional=bool(len(ing) > 2 and ing[2])))
            for i, (text, secs) in enumerate(r["steps"]):
                db.add(RecipeStep(recipe_id=r["id"], step_index=i, text=text, seconds=secs))
            result["recipes"] += 1
        db.flush()

    # ---- knowledge docs: 16 recipes + 10 guidance notes ----
    if db.query(KnowledgeDoc).count() == 0:
        for r in RECIPES:
            ings = ", ".join(f"{FOODS[i[0]]['name']}{i[1]}{FOODS[i[0]]['unit']}" for i in r["ing"])
            steps = "\n".join(f"{i+1}. {s[0]}" for i, s in enumerate(r["steps"]))
            db.add(KnowledgeDoc(kind="recipe", title=r["t"],
                                content=f"{r['t']}（{r['min']} 分钟，{r['diff']}，{r['serv']} 人份）。用料：{ings}。步骤：\n{steps}",
                                source=r["src"]))
        for title, content in GUIDANCE:
            db.add(KnowledgeDoc(kind="guide", title=title, content=content, source="饮食指导 · 通用建议 v1"))
        db.flush()

    if not demo:
        db.commit()
        return result

    today = services.today()
    monday = _monday(today)
    days = [monday + timedelta(days=i) for i in range(7)]

    # ---- demo user ----
    user = db.query(User).filter(User.email == DEMO_EMAIL).first()
    if user is None:
        user = User(email=DEMO_EMAIL, password_hash=hash_password(DEMO_PASSWORD), name="小满")
        db.add(user)
        db.flush()
        db.add(UserProfile(user_id=user.id, timezone="Asia/Shanghai", locale="zh-CN",
                           max_cook_minutes=35, people=2,
                           equipment=["灶台", "电饭煲", "微波炉"], taste=["清淡", "家常"]))
        db.add(DietaryRestriction(user_id=user.id, kind="allergy", label="花生", keys=["花生"], hard=True))
        db.add(DietaryRestriction(user_id=user.id, kind="avoid", label="香菜", keys=["香菜"], hard=True))
        db.add(DietaryRestriction(user_id=user.id, kind="pref", label="少油少辣", keys=[], hard=False))
        for kind, mode in (("weekly_report", "auto"), ("expiry", "observe"), ("habit_review", "off")):
            db.add(AutomationPolicy(user_id=user.id, task_kind=kind, mode=mode))
        db.add(AgentTask(user_id=user.id, kind="weekly_report", name="每周周报", status="scheduled", next_run="本周日 20:00"))
        db.add(AgentTask(user_id=user.id, kind="expiry", name="临期扫描", status="observe", next_run="每天 08:00"))
        db.add(AgentTask(user_id=user.id, kind="habit_review", name="习惯回顾", status="off", next_run="—"))
        result["demo_user"] = True
        db.flush()
    else:
        # already seeded for this user
        if db.query(MealPlan).filter(MealPlan.user_id == user.id).first() is not None:
            db.commit()
            return {**result, "seeded": False, "note": "demo 用户已存在，跳过重复种子"}

    # ---- pantry batches (MVP seed()) ----
    def b(food, qty, exp, loc, bought=-3):
        expires = None if exp is None else today + timedelta(days=exp)
        return services.add_batch(db, user, food, qty, None, expires, loc,
                                  purchased_on=today + timedelta(days=bought))

    b("egg", 8, 12, "fridge", -2)
    egg3 = b("egg", 3, 2, "fridge", -9)
    b("tomato", 3, 2, "fridge")
    b("chicken", 600, 1, "fridge", -2)
    b("broccoli", 350, 3, "fridge")
    b("milk", 900, 4, "fridge")
    b("yogurt", 400, 5, "fridge")
    b("cucumber", 2, 4, "fridge")
    b("tofu", 400, 2, "fridge")
    b("lettuce", None, 3, "fridge")
    b("shiitake", 200, 4, "fridge")
    b("bokchoy", 300, 1, "fridge")
    b("scallion", 60, -1, "fridge", -8)
    b("lemon", 2, 10, "fridge")
    b("salmon", 250, 30, "freezer", -10)
    b("beef", 500, 60, "freezer", -15)
    b("shrimp", 300, 45, "freezer", -12)
    b("rice", 2500, 200, "pantry", -30)
    b("oats", 800, 120, "pantry", -20)
    b("pasta", 500, 300, "pantry", -40)
    b("noodles", 400, 180, "pantry", -25)
    b("oil", 1500, 300, "pantry", -40)
    b("soy", None, 200, "pantry", -60)
    b("doubanjiang", 200, 150, "pantry", -60)
    b("garlic", 150, 20, "pantry", -6)
    b("potato", 600, 14, "pantry", -4)
    b("bread", 6, 3, "pantry", -1)
    b("banana", 4, 2, "pantry", -3)
    b("carrot", 300, 10, "fridge", -4)
    # one historical consumption: 1 egg from the 3-egg batch
    egg3.remaining_amount = Decimal("2")
    egg3.version += 1
    db.add(PantryMovement(user_id=user.id, batch_id=egg3.id, food_id="egg", delta=Decimal("-1"),
                          kind="CONSUME", reason="烹饪：番茄炒蛋", source_type="cooking_session",
                          source_id="ck_seed", idempotency_key="seed-ck-1"))
    db.flush()

    # ---- plan v1 + v2 ----
    B = ["r_oat", "r_sandwich", "r_yogurt", "r_congee", "r_oat", "r_sandwich", "r_yogurt"]
    L = ["r_tomegg", "r_scallion", "r_mapo", "r_bokchoy", "r_teriyaki", "r_tomegg", "r_beef"]
    Dn = ["r_salmon", "r_beef", "r_teriyaki", "r_ribs", "r_broc", "r_shrimp", "r_salmon"]
    meals1: dict[str, dict] = {}
    for i, d in enumerate(days):
        meals1[f"{d.isoformat()}|breakfast"] = {"recipe_id": B[i], "servings": 2 if B[i] == "r_congee" else 1}
        meals1[f"{d.isoformat()}|lunch"] = {"recipe_id": L[i], "servings": 2}
        meals1[f"{d.isoformat()}|dinner"] = {"recipe_id": Dn[i], "servings": 2}
    meals2 = {k: dict(v) for k, v in meals1.items()}
    meals2[f"{days[4].isoformat()}|lunch"] = {"recipe_id": "r_shrimp", "servings": 2}
    plan = MealPlan(user_id=user.id, title="本周家常菜单", period_start=monday, period_end=monday + timedelta(days=6))
    db.add(plan)
    db.flush()
    services.commit_plan_version(db, user, plan, meals1, "七日菜单草稿 · 用户批准", by="user")
    services.commit_plan_version(db, user, plan, meals2,
                                 f"替换 {['周一','周二','周三','周四','周五','周六','周日'][4]}午餐：照烧鸡腿饭 → 蒜蓉虾仁意面", by="user")
    db.flush()

    # ---- meal records for past days (MVP rules) ----
    for i, d in enumerate(days):
        off = (d - today).days
        if off > 0:
            continue
        for slot in ("breakfast", "lunch", "dinner"):
            if off == 0 and slot != "breakfast":
                continue
            if off < 0 and d.weekday() == 1 and slot != "lunch":
                continue  # 周二只记了午餐
            if off < 0 and d.weekday() == 0 and slot == "dinner":
                continue  # 周一晚餐忘记
            if off == -3 and slot == "breakfast":
                continue
            pm = meals2[f"{d.isoformat()}|{slot}"]
            services.create_meal_record(db, user, d, slot,
                                        [{"recipe_id": pm["recipe_id"], "servings": 1}],
                                        source="plan", planned=True)
    db.flush()

    # ---- habits for 7 days before today ----
    for i in range(-6, 1):
        d = today + timedelta(days=i)
        if i != -4:
            cups = 2 if i == 0 else [5, 6, 4, 7, 6, 5][(i + 6) % 6]
            for _ in range(cups):
                db.add(HabitRecord(user_id=user.id, kind="water", local_date=d, value=Decimal("250"), unit="ml"))
        if i < 0 and i != -2:
            db.add(HabitRecord(user_id=user.id, kind="sleep", local_date=d,
                               value=Decimal(str([7.2, 6.5, 7.8, 6.9, 8.1, 7.0][(i + 6) % 6])), unit="h"))
        if i < 0 and i != -5:
            db.add(HabitRecord(user_id=user.id, kind="steps", local_date=d,
                               value=Decimal(str([6400, 8800, 5200, 10300, 7600, 9100][(i + 6) % 6])), unit="steps"))
        if i in (-6, -3, -1):
            db.add(HabitRecord(user_id=user.id, kind="weight", local_date=d,
                               value=Decimal(str([62.4, 62.1, 61.9][[-6, -3, -1].index(i)])), unit="kg"))
    db.flush()

    # ---- shopping: manual items, then plan-gap recompute ----
    db.add(ShoppingItem(user_id=user.id, food_id="lemon", quantity=Decimal("2"), unit="piece",
                        origin="manual", status="confirmed"))
    db.add(ShoppingItem(user_id=user.id, food_id="blueberry", quantity=Decimal("125"), unit="g",
                        origin="manual", status="purchased", note="超市周末打折"))
    db.flush()
    services.recompute_shopping(db, user, plan)

    # ---- reports: last week + this week ----
    from app.models import Report
    last_mon = monday - timedelta(days=7)
    for start in (last_mon, monday):
        metrics = services.compute_report_metrics(db, user, start)
        db.add(Report(user_id=user.id, type="weekly", period_start=start, period_end=start + timedelta(days=6),
                      metrics_json=metrics, interpretation_md=services.report_text(metrics), status="fresh"))

    # ---- notifications ----
    now = datetime.now(timezone.utc)
    plan_items = db.query(ShoppingItem).filter(ShoppingItem.user_id == user.id, ShoppingItem.origin == "plan").count()
    db.add(Notification(user_id=user.id, kind="expiry", text="鸡腿肉 明天到期，小青菜 明天到期",
                        link="#/pantry", read=False))
    db.add(Notification(user_id=user.id, kind="report", text="上周周报已自动生成（授权：auto）",
                        link="#/reports", read=False))
    db.add(Notification(user_id=user.id, kind="shopping", text=f"计划采购差额已更新：{plan_items} 项",
                        link="#/shopping", read=True))
    db.commit()
    return {**result, "seeded": True, "today": today.isoformat(), "monday": monday.isoformat()}
