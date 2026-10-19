# 卡牌数据复核与勘误（2026-10-19）

## 发现的问题

`Xike-yuhuofei/Century` 仓库中的 `02-卡牌总表.md` 声明：

- 商人牌库共 43 张：创造 8 + 升级 1 + 交易 34。
- 但交易明细表逐行列出的交易**实际有 35 行**，相加成为 44 张，不满足总数。

## 复核方式

使用独立开源实现 `kennethhyman/CenturyGolemEdition` 的 [`data/cards.csv`](https://github.com/kennethhyman/CenturyGolemEdition/blob/master/data/cards.csv) 逐张核对。

CSV 共 43 行，其中交易 34 行、创造 8 行、升级 1 行。与本项目交易表比对发现，项目资料中多出：

> 粉×1 → 绿×2

这条交易**不在上述独立 CSV 中**。因此，V1 实际游戏牌库不包含此条；另外 34 条交易与所用 CSV 一致。

这是一项**待对照实体卡/官方资料最终复核**的勘误建议，不应在没有用户授权时直接修改原仓库。此结论只表示该独立实现的卡表与项目表存在差异，并非主张开源实现就是官方唯一权威来源。

## 自动校验

- 起始牌 10 + 商人牌库 43 + 魔像 36 = 89；
- 全部 36 张魔像按「黄1、绿2、蓝3、粉4」及三色/四色加分公式验证通过；
- 所有商人卡/魔像卡 ID 唯一；
- 本地规则测试覆盖容量、位置费用、终局、交易升级边界。

## M29 专项复核（2026-10-19）

`M29` 是本网页原型对商人牌库排序后自行分配的**内部编号**，不是实体游戏卡牌上的官方编号。按 `src/data.ts` 中 M10 起第 20 张交易牌核对：

- 输入：**蓝×1**（内部数组 `[0,0,1,0]`）
- 输出：**黄×4、绿×1**（内部数组 `[4,1,0,0]`）
- 独立依据 1：[kennethhyman/CenturyGolemEdition `data/cards.csv`](https://github.com/kennethhyman/CenturyGolemEdition/blob/master/data/cards.csv)，对应数据 `0,0,1,0,4,1,0,0,0`。
- 独立依据 2：[dwerbin/spiceroad `spicelib/Game.cpp`](https://github.com/dwerbin/spiceroad/blob/main/spicelib/Game.cpp)，`Trade trades[]` 包含净变化 `{4, 1, -1, 0}`。

**结论：** 两种独立实现的效果一致，原型 M29 不需更改；此结论不等于已人工比对实体卡面。新增自动测试覆盖卡牌内容及一次交易执行后水晶变化。