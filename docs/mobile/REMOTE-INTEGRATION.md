# 远端整合与推送前验收

日期：2026-10-20。用户已授权提交与推送。

- 远端整合基线：`320cfe3198a1641cef2d5f1e18450f22f1dbf28f`，保留本地旧基线之后的 25 个提交。
- 原桌面 `src/app.ts`、`src/styles.css` 与规则、AI、卡牌数据均未相对远端改动；桌面 `dist/standalone.html` 根据现有远端源码重新生成。
- 新手机视图与样式独立运行；原有手机/电脑入口链接保留，文档改为准确说明各自存档和显式迁移方式。
- Pages 入口测试改为检查“自包含、独立视图、独立存档、同源规则与 AI”，不再要求手机与桌面 UI 脚本完全相同。
- 原有 Pages 工作流名称、并发组、首次启用能力保留；发布包包含完整资源，根目录继续使用桌面自包含 HTML。
- 更新两处 CI，使手机回归所需 Chromium 和 WebKit 均被安装。

本次推送前验收：

- `npm test`：38/38 通过，见 [完整日志](integration-tests.log)。
- `smoke_mobile.py` 与 `audit_mobile.py`：Chromium/WebKit 全部通过。
- `smoke_focus.py`、`smoke_organize.py`、`live-five-smoke.py`：全部通过。
- Git 差异检查通过；不覆盖远端已有提交。

本文件记录推送前验收。远端发布是否成功，以相应提交的 GitHub Actions 和公网实际页面验证为准；物理手机与低端性能仍属待验收项。
