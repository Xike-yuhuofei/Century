# Century 独立手机版交付报告

> 2026-10-20 更新：用户已授权提交与推送。本实现已整合远端 main 的 25 个后续提交，以 `320cfe3` 的桌面源码为基准保留既有功能；桌面单文件重新生成。下文的“未提交/未发布”是 2026-10-19 审查时的历史状态，当前发布结果以 GitHub Actions 及本次推送回执为准。

日期：2026-10-19（Asia/Shanghai）

状态：**本地实现与模拟浏览器验收通过；真机与新版发布尚未验收；未提交、未合并、未推送。**

本轮需求自查发现并修复了 4 个边界问题，最新结论与证据见 [自查报告](SELF-AUDIT.md)。

## 访问与复现

- 新手机版本地运行：http://127.0.0.1:4173/mobile/
- 电脑版本地运行：http://127.0.0.1:4173/
- 离线完整版：`web-v1/dist/mobile/standalone.html`，构建后可直接打开；也可在 `/mobile/standalone.html` 下载保存。
- 模块化调试入口：http://127.0.0.1:4173/mobile/modules.html
- 线上手机入口：https://xike-yuhuofei.github.io/Century/mobile/
- 线上电脑入口：https://xike-yuhuofei.github.io/Century/

**线上地址目前仍是旧版。** 本次实际请求手机入口返回 HTTP 200，并在浏览器成功开局；这证明旧发布可访问，不代表本次新实现已发布。

```sh
cd "/Volumes/Extreme SSD/Projects/Century/web-v1"
npm ci
npm start
```

浏览器测试以 `/Century/` 为挂载前缀实际加载页面、模块和 Worker，覆盖 GitHub Pages 项目子路径。

## 一、现状审查

审阅了规则、卡牌总表、`data/cards.json`、`engine.ts`、`ai.ts`、`organize.ts`、桌面 `app.ts/styles.css`、构建脚本、既有测试和 GitHub 工作流；并核对官方规则书。

本地检出起点为 `f6839a0`，工作树最初干净。本地起点没有 mobile 页面及 Pages 工作流；远端当前已有更新的手机版及 `.github/workflows/pages.yml`，Pages 使用 workflow 发布。**本地源码与线上状态有差异，之后获授权整合时应对照最新远端变更，不能直接以旧检出覆盖远端。**

| 审查步骤 | 实测表现 | 健康度及处理 |
|---|---|---|
| 1. 本地既有界面在 390px 开局 | 个人手牌占据大半屏，公共市场在下方；同页可见第二名真人手牌 | 差：独立视图重构，双真人交接遮挡 |
| 2. 线上旧手机版开局 | 页面可以打开；魔像、商人、对手通过分段切换 | 可用：本次未复现历史打不开的问题；不能据此断言历史故障原因 |
| 3. 线上查看魔像 | 两列纵向卡片，第五张及后续内容需滚动；商人效果不能同时比较 | 有摩擦：改成两条同时显示的横滑市场 |
| 4. 线上底部手牌 | 已有常驻手牌，但每张附带移动按钮；触摸排序仍依赖桌面拖放路径 | 需优化：独立 Pointer Events 手柄拖动、排序模式及按钮辅助 |
| 5. 本地构建/发布核查 | 本地已有桌面单文件构建；缺少当前远端发布配置 | 有断层：补入完整产物发布与手机浏览器门禁，不实际触发发布 |

证据：[本地原布局](screenshots/00-before-390.png)、[线上旧手机版](screenshots/00-live-before-390.png)。审查未使用历史截图代替本次证据；未声称截图能证明完整无障碍合规。

## 二、设计方案与空间分配

深色连续桌面、浅色卡牌、浅绿主操作。系统字体，无在线字体、外部插画或 UI 框架。统一按钮、圆角、边界与卡面层级，把水晶效果置于卡号之前。

- 顶部常驻当前行动者、玩家横滑状态条、轮次/终局提醒、四种水晶计数、容量和硬币。当前玩家切换时状态条自动滚到该玩家。
- 中部两条市场同时显示。魔像先看得分和支付，商人紧随其后；两行各自横滑，后续卡片露出边缘提示可滚动。没有在两个市场之间切换页面的成本。
- 底部常驻当前真人手牌，横向浏览；展开为内部滚动网格，最高约 76dvh。顶部“手牌/已打出”区域是可点按的 44px 控件，可展开正面回收区。所有手牌不会无限堆高整页。
- 320×640 下，顶部约 164px，公共市场约 312px，底部约 164px；两行卡面完整进入市场区域。390×844 有更多纵向空间用于较大卡面和最近行动。具体边界见截图。
- 932×430 横屏采用“左状态、中市场、右手牌”三栏，避免挤压竖屏布局。
- 使用 `viewport-fit=cover`、四向安全区域及 `100dvh`，保留 `100vh` 回退；支持减少动态效果偏好。

### 完整流程

| 步骤 | 界面及交互 | 实现/验收 |
|---|---|---|
| 1 | 首页：继续存档、开启新旅程、玩法、电脑入口 | 通过 |
| 2 | 配置：1–2 真人、0–4 AI、姓名、人数合法性；六人明确非官方 | 通过 |
| 3 | 主桌面：行动者、比分、魔像数、商队与两行市场 | 通过 |
| 4 | 魔像市场：5 张真实卡面、铜银奖励与余量、可认领状态 | 通过 |
| 5 | 商人市场：6 张真实卡面、位置费用、逐颗奖励水晶 | 通过 |
| 6 | 手牌展开：全部/创造/升级/交易筛选、分类整理、触屏排序、顺序持久化 | 通过 |
| 7 | 升级：逐次黄→绿→蓝→粉，可连续升级同一颗；撤销、零次或提前结束 | 通过 |
| 8 | 交易：合法次数步进，明确展示结果，缺晶禁止确认 | 通过 |
| 9 | 获取：逐颗选择支付，按顺序压到左侧卡，预览卡上奖励；可撤销/取消 | 通过 |
| 10 | 弃置：行动已执行，恰好选择超出部分；刷新可继续，关闭面板不能绕过规则 | 通过 |
| 11 | 多人：公开资源/分数/硬币/手牌张数/正面已打出卡；交接、恢复、切回前台时保护私人手牌 | 通过 |
| 12 | 结算：名次、总分、魔像/铜/银/非黄水晶分项，后手平局规则 | 通过 |

真人行动均先预览再确认，常见创造、休息、免费获取和认领为两次主要点按；升级、重复交易、压晶及弃置增加必要选择，不削减正式机制。预览取消不推进回合。

水晶采用黄/绿/蓝/粉四种颜色，同时附中文色名及形状差异。卡牌上几颗就实际绘制几颗；顶部商队计数是紧凑状态显示。奖励很多时在卡片内部横滑，避免挤压交易效果。

## 三、架构与存档

- 引擎、AI 2.0、卡表、整理工具、桌面 UI 源码均未修改。
- 手机端独立入口、独立视图函数和独立样式；不导入桌面 `app.ts` 或 `styles.css`，不改写媒体查询来强制桌面变成手机。
- 所有提交行动统一经 `applyAction`；预览仅展示草稿，不引入第二套判定规则。
- 在线优先在 Worker 调用同一 `chooseAIAction`。离线或 Worker 不可用时退回主线程调用同一 AI；没有分叉算法。WebKit 断网模拟不允许新建 Blob Worker，已验证该兼容路径。
- 手机存档键 `century-mobile-game-v2`，保留 version 2 数据契约；电脑存档键不变。可以从同一来源下的兼容电脑存档复制，或导入/导出 JSON，两个视图独立写入。
- 输入存档检查版本、人数、座次、卡号、资源、阶段等。旧存档缺省 `isAI` 仍按真人解释；不兼容的三名以上真人存档给出说明。
- 主入口及离线 HTML 自包含，样式、规则、数据、UI 与 Worker 在同一版本内。Pages 的旧 HTML 即使暂时被缓存，仍拥有匹配资源。
- 另生成指纹目录和 `modules.html` 用于模块调试；生产主入口不依赖这些后续资源请求。
- 手机首页 HTML 约 121KB；本地 gzip 测量约 26KB。未引入框架、后端、联网多人或 Service Worker。

## 四、修改文件

| 文件 | 用途 |
|---|---|
| `web-v1/README.md` | 手机运行入口与验收文档索引 |
| `web-v1/mobile/index.html` | 手机 HTML 源模板 |
| `web-v1/src/mobile/app.ts` | 独立手机视图、操作草稿、交接、排序、存档及 AI 调度 |
| `web-v1/src/mobile/styles.css` | 手机设计系统、卡面、抽屉、短屏与横屏、安全区域 |
| `web-v1/src/mobile/storage.ts` | v2 存档检查与手机/桌面存档键 |
| `web-v1/src/mobile/worker.ts` | 同一 AI 2.0 的 Worker 入口 |
| `web-v1/scripts/build.mjs` | 在原桌面产物之后增加手机单文件及指纹资源产物 |
| `web-v1/tests/mobile.test.mjs` | 存档兼容/损坏拒绝/弃置恢复/产物完整性 |
| `web-v1/scripts/smoke_mobile.py` | Chromium、WebKit 流程、逐卡数据及布局验收 |
| `web-v1/scripts/audit_mobile.py` | 隐私恢复、长姓名、排序、触控/弹层、备份与本地文件边界回归 |
| `.github/workflows/pages.yml` | 规则与浏览器门禁、证据 artifact、Pages 构建发布定义；尚未运行远端发布 |
| `docs/mobile/` | 本报告、审查/运行截图、原始测试日志、结构化浏览器结果 |

构建产物在 `web-v1/dist/mobile/`；沿用仓库 dist 忽略约定。原已跟踪桌面 `dist/standalone.html` 内容没有变化。

## 五、测试证据

- 首次交付 `npm test`：35/35 通过。本轮增加存档阶段校验测试后，当前构建执行 `node --test tests/*.test.mjs`：36/36 通过，并重跑卡牌同步、89 张卡校验、手机与桌面浏览器回归。最新日志见 [自查报告](SELF-AUDIT.md)；底层规则及 AI 未改变。
- `node scripts/validate-cards.mjs`（仓库根目录）：起始 10、商人 43（8/1/34）、魔像 36 全部通过。
- Chromium 141 + WebKit 26：320×640、375×812、390×844、430×932、932×430 共 10 组视口通过。页面宽度和高度等于视口，无全局溢出；两市场未被底部遮住；卡面水晶越界检测为 0。
- 最小屏幕额外逐批检查全部 43 张商人卡与 36 张魔像卡，覆盖高颗数卡面；24 颗累计市场奖励不会破坏卡面布局。
- 两引擎实际运行：创造、休息、认领铜币、免费/付费获取及左侧压晶、升级连续/撤销/零次/取消、重复交易上限、缺晶、超额弃置与刷新、正面回收区、分类、顺序持久化、最终结算。
- Chromium 使用真实触摸事件拖动排序；WebKit 使用 Pointer Events 鼠标输入覆盖相同处理路径。WebKit 的真机触摸手感仍需设备复测。
- 两引擎实际运行 1 真人+1 AI、2 真人+3 AI、2 真人+4 AI 一整轮，每位玩家行动一次；双真人每次交接均遮挡手牌。
- 手机自包含入口、模块入口、Worker、断网 HTML 与同一来源电脑入口均实际加载/操作；手机存档不被电脑开局覆盖。
- 最终手机验收捕获页面异常与控制台错误共 **0**。
- 原桌面 `smoke_focus.py`、`smoke_organize.py`、`live-five-smoke.py` 全部通过，覆盖 Focus 多 AI、拖动/分类/恢复和真实五/六人行动。
- `git diff --check` 通过。

结构化结果：[browser-results.json](browser-results.json)。原始输出：[verification/](verification/)。浏览器脚本会自建临时 HTTP 服务，无须依赖正在运行的开发服务器。

复现浏览器验收：

```sh
python3 -m venv /tmp/century-mobile-qa
/tmp/century-mobile-qa/bin/pip install playwright==1.56.0
/tmp/century-mobile-qa/bin/python -m playwright install chromium webkit
/tmp/century-mobile-qa/bin/python web-v1/scripts/smoke_mobile.py
```

## 六、实际运行截图

[最终可玩预览截图](screenshots/31-final-preview.png)。

| 场景 | Chromium | WebKit |
|---|---|---|
| 首页与配置 | [首页](screenshots/chromium-01-home.png) | [首页](screenshots/webkit-01-home.png) |
| 320×640 | [主桌面](screenshots/chromium-02-table-320x640.png) | [主桌面](screenshots/webkit-02-table-320x640.png) |
| 375×812 | [主桌面](screenshots/chromium-02-table-375x812.png) | [主桌面](screenshots/webkit-02-table-375x812.png) |
| 390×844 | [主桌面](screenshots/chromium-02-table-390x844.png) | [主桌面](screenshots/webkit-02-table-390x844.png) |
| 430×932 | [主桌面](screenshots/chromium-02-table-430x932.png) | [主桌面](screenshots/webkit-02-table-430x932.png) |
| 932×430 | [横屏](screenshots/chromium-02-table-932x430.png) | [横屏](screenshots/webkit-02-table-932x430.png) |
| 连续升级 | [操作面板](screenshots/chromium-03-upgrade.png) | [操作面板](screenshots/webkit-03-upgrade.png) |
| 真人交接 | [遮挡界面](screenshots/chromium-04-handoff.png) | [遮挡界面](screenshots/webkit-04-handoff.png) |
| 重复交易 | [次数选择](screenshots/chromium-05-trade.png) | [次数选择](screenshots/webkit-05-trade.png) |
| 获取支付 | [逐颗选择](screenshots/chromium-06-payment.png) | [逐颗选择](screenshots/webkit-06-payment.png) |
| 商队弃置 | [弃置面板](screenshots/chromium-07-discard.png) | [弃置面板](screenshots/webkit-07-discard.png) |
| 魔像认领 | [确认支付](screenshots/chromium-08-claim.png) | [确认支付](screenshots/webkit-08-claim.png) |
| 手牌展开 | [网格](screenshots/chromium-09-hand-expanded.png) | [网格](screenshots/webkit-09-hand-expanded.png) |
| 游戏结算 | [结算](screenshots/chromium-10-results.png) | [结算](screenshots/webkit-10-results.png) |

## 七、边界与后续授权

1. 本次没有连接物理 iPhone 或 Android。WebKit/Chromium 设备模拟通过不等于 iOS Safari/Android Chrome 真机验收；地址栏伸缩、键盘、刘海、系统手势和低端手机帧率仍待真机复测。
2. 断网/Worker 不可用时 AI 兼容路径在主线程计算，大手牌复杂局面可能短暂阻塞；在线 Worker 路径不会在主线程进行搜索。
3. 不提供跨设备实时多人。两真人是同一设备轮流行动；本机清理站点数据会清除存档，导出备份可用于恢复。
4. 主入口可在加载后离线玩；完全断网重新打开网页仍依赖浏览器缓存。可靠的离线启动请保存 `standalone.html`，本次未添加 PWA/Service Worker。
5. 历史“手机版打不开”本次未复现，因此不宣称已确定历史根因。新增主入口自包含与发布门禁针对本次可验证的资源完整性和版本一致性。
6. 新 Pages 工作流和新手机版尚未部署。授权后的远端整合、CI 成功、部署成功、再用公网 URL 打开新版本并检查控制台，才构成新版线上发布验收完成。
7. 已按要求停在本地交付状态；没有 Git 提交、合并或推送，也没有触发 GitHub Actions 发布。

## 规则与设计参考

- [官方 2024 英文规则书](https://cdn.svc.asmodee.net/production-nextmove/uploads/sites/4/2024/06/EN-Century-Golem-Rules_2024_compressed.pdf)：四类行动、连续升级、交易、硬币、容量、终局与平局。
- [Apple HIG — Layout](https://developer.apple.com/design/human-interface-guidelines/layout)：信息层级、相关信息分组、渐进展示、方向适配与安全区域。此实现是网页交互适配，并不声称使用原生 iOS 组件或获得 Apple 认证。
