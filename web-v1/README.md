# 晶石回廊 V1.3 · 1～2 真人与 0～3 AI 桌面版

《Century: Golem Edition》的私人离线学习游戏，使用自制卡面与水晶视觉，不含原版插画或商标，和发行方无关联。

## 立即游玩

下载并用 Windows Chrome 或 Edge 打开 [dist/standalone.html](dist/standalone.html)。该文件包含完整的真实游戏规则引擎与离线 AI，可直接双击运行。

- **真人可选 1～2 名**，AI 可选 0～3 名（默认 2 真人 + 3 AI），总人数 2～5。选 1 真人时至少配置 1 名 AI；选 2 真人时允许 0 AI。
- **单真人**进入人机对战视图（真人操作区 + 共享市场 + AI 席位）；**双真人**仍固定左右两侧，不受 AI 人数影响。切换人数时保留第二位真人已输入的名称。
- 中央同时展示 5 张魔像、6 张商人卡与行内操作台；AI 席位位于上方，不压缩真人区域。
- 所有资源和卡牌来自真实对局状态，经 `applyAction` 校验。AI 使用 `chooseAIAction` 自动行动，可暂停。
- 两名真人无交接遮罩；四类行动为打出、获取、休息、认领。包含分步升级、重复交易、市场位置支付、超 10 颗弃置及整轮终局。
- 已打出卡牌正面显示；卡牌支持拖拽排序、按类型排列、鼠标右键固定、悬停放大和已打出区折叠。
- 针对 3440×1440 超宽屏优化，卡牌水晶逐颗绘制；溢出限制在局部卡牌区，不出现页面整体滚动。

## 开发与测试

安装 Node.js 20+，然后：

```bash
npm install
npm test
npm start
```

运行后访问 `http://localhost:4173`。测试包括 19 项规则与 AI 单元测试，以及 GitHub Actions 中的 Chrome + Playwright 浏览器 UI 回归（1～2 真人选择、总人数合法性、单真人 AI 自动轮转、2 真人 + 3 AI、0～3 AI 切换、拖拽、升级、休息、付费获取与认领魔像）。

本地运行浏览器测试需 Python Playwright 和 Chrome：

```bash
npm run build
python scripts/live-five-smoke.py
```

| 路径 | 说明 |
|---|---|
| `src/app.ts` / `src/styles.css` | 正式五人桌面 UI 和交互 |
| `src/engine.ts` / `src/ai.ts` | 规则引擎及离线 AI |
| `src/data.ts` | 从仓库根目录 `data/cards.json` 生成的牌面 |
| `scripts/sync-cards.mjs` | 核对（`--check`）或重建卡表 |
| `scripts/live-five-smoke.py` | Chrome 端到端验收 |
| `design-5p/index.html` | 早期独立**视觉演示**，不是正式游戏 |
| `dist/standalone.html` | **正式可玩版**，GitHub Actions 自动生成 |

核校卡牌总计 89 张实体牌：10 张起始商人卡、43 张商人牌库卡、36 张魔像；M29 为黄×4→蓝×2，M43 为升级3。旧编号存档使用单独 LocalStorage key 与版本号隔离。

**边界：** 当前为同一电脑的本地对局，不支持联机房间、账号、云存档或 AI 难度分级。AI 为启发式，并不保证最优策略。
