# 图标来源

本目录的 SVG 全部来自用户提供的 **Foodlife_Icon_Kit**（2026-11-18），按原包目录结构原样存放，
未改动文件内容。前端引用时：

| 目录 | 用途 | 建议尺寸 |
| --- | --- | --- |
| `ui/` | 导航（今日 / 菜单 / 冰箱 / 菜谱 / 购物 / 饮食记录） | 20–24 px |
| `ingredients/` | 食材大图：菜谱详情、速记 chips | 32–72 px |
| `compact/` | 食材小图：冰箱清单、购物行、食材标签 | 24 px |
| `hero/` | 登录页和首页主视觉（番茄炒蛋餐盘） | 220–320 px 宽 |

使用方式：

- `ui/` 是线性图标（`stroke="currentColor"`），为保证跟随控件颜色，
  其路径以内联 SVG 字符串的形式同步在 `app.js` 的 `KIT_UI` 里
  （`app.js` 不直接 fetch，见 smoke 检查“所有 fetch 都在 api.js 内”）。
  如需更新图标，先替换本目录文件，再同步 `KIT_UI`。
- `ingredients/` / `compact/` / `hero/` 是固定填色插画，用 `<img>` 引用，
  在 `app.js` 里由 `foodImg()` / `iconize()` 按场景选择版本：
  8 种有新图的食材（egg / tomato / carrot / broccoli / shiitake / salmon /
  lemon / oats）用新图，其余食材保留原有手绘 glyph，不硬套。
- 食材插画使用图标包的固定填色。页面和操作按钮的主题色见 `frontend/styles.css`。
