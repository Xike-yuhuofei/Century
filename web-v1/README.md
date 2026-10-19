# 晶石回廊 V1.1 · 非官方桌游练习版

这是一个基于《Century: Golem Edition》规则建立的**私人学习原型**。使用原创极简视觉呈现水晶和卡牌结构，**不含原版插画、商标或任何官方素材**，与游戏发行方无关联。

## 立即游玩（无须安装）

直接下载并打开 `dist/standalone.html`。这是一个完全自包含的网页：无需联网、无需下载额外资源，现代 Chrome / Edge / Safari 浏览器即可运行。

- 支持 **2–5 人同设备轮流游戏**。**双人模式**针对 3440×1440（21:9）超宽屏设计：双方手牌、已打出卡牌及商队分别在左右两侧始终可见，**无需交接或切换玩家界面**；3–5 人模式保留交接界面。
- **所有卡面水晶逐颗绘制**（例如黄4颗画4颗黄水晶）；已打出卡牌正面可见，保留完整效果与编号。
- 实现打出、获取、休息、认领四类行动，支持分步升级、重复交易、市场位置费用选择、获取卡上水晶奖励。
- 回合结束容量超出 10 颗时，会强制选择弃置；提供自动计分、整轮终局、同分判定。
- 游戏数据保存在当前浏览器的 LocalStorage（禁用站点存储时仍可对局，但可能不能跨刷新恢复）。

## 本地开发

需要 Node.js 20 或以上，以及全局 `tsc` 命令（TypeScript 编译器）。不需要安装 React、Vite 或其他 npm 运行依赖。

```bash
npm run build
npm start
npm test
```

运行 `npm start` 后，用浏览器访问 `http://localhost:4173`。

目录结构：

```text
src/data.ts        89 张卡牌的结构化数据和校验
src/engine.ts      不依赖 DOM 的确定性规则引擎
src/app.ts         网页操作界面和本地对局管理
src/styles.css     原创响应式样式
scripts/build.mjs  同时生成模块化网页、单 HTML 独立版
scripts/serve.mjs  Node 本地静态服务器
tests/             规则、边界条件、终局等测试
dist/standalone.html 直接用浏览器打开的版本
```

## 双人超宽屏布局与验证

- 左栏：玩家1商队、正面手牌、正面已打出卡牌、已认领魔像、硬币与休息操作；右栏：玩家2对应区域。
- 中栏：5张魔像与6张商人市场；仅**当前回合玩家**的手牌和休息按钮可用，另一位可见但无法误操作。
- 3440×1440 浏览器视口已验证无整页横向/纵向滚动；随手牌增多，玩家面板内部的卡牌区可滚动；小屏幕改为纵向布局。
- `npm test`：13项规则测试（新增M29效果与执行测试）；`python scripts/smoke.py`：UWQHD双人、3人交接及移动端交互测试（需Python Playwright及浏览器）。
- 双人截图：`dist/duel-3440x1440.png`，行动后：`dist/duel-after-play-3440x1440.png`。

## 数据与规则来源

- 项目仓库：[Xike-yuhuofei/Century](https://github.com/Xike-yuhuofei/Century)
- 复核卡牌 CSV：[kennethhyman/CenturyGolemEdition](https://github.com/kennethhyman/CenturyGolemEdition/blob/master/data/cards.csv)
- 本地核对详情：`DATA-AUDIT.md`

## 版本范围

**V1.1 当前实现：** 本地双人同屏／3–5人交接式轮流，客户端规则自动校验，浏览器存档，原创卡面。

**尚未实现：** 真正的多设备联网房间、实时同步、AI 对手、撤销和复盘、账号登录以及云端存档。这些工作归入 V2 / V3，不能因为打开了网页就将 V1 称为多人在线联机版。

**上线之前：** 如果计划面向公众使用原版卡面、名称和插画，应先核对相关版权、商标及授权条款。