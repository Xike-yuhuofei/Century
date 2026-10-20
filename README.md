# Century · 水晶之路：晶石传奇学习项目

本仓库是规则、卡牌和对局训练的可核校资料库。简体中文、版本为 Century: Golem Edition。

## 开始使用

| 文档 | 用途 |
|---|---|
| [00-学习路线.md](00-学习路线.md) | 最新课程进度与教学纪律（进度唯一来源） |
| [01-规则精读.md](01-规则精读.md) | 2024年官方规则校对 |
| [02-卡牌总表.md](02-卡牌总表.md) | 43张牌库商人卡、10张起始卡、36张魔像 |
| [03-策略决策模型.md](03-策略决策模型.md) | 合法性、行动经济、得分目标的评估路径 |
| [04-训练题库.md](04-训练题库.md) | 新题与题面一致性标准 |
| [05-学习与复盘日志.md](05-学习与复盘日志.md) | 历史证据状态及后续记录 |
| [06-项目说明建议.md](06-项目说明建议.md) | 可手动粘贴至 ChatGPT 项目设置的规范 |
| [data/cards.json](data/cards.json) | 卡牌机器可读数据 |
| [scripts/validate-cards.mjs](scripts/validate-cards.mjs) | 校验脚本 |

## 手机与浏览器游玩（GitHub Pages）

- **电脑地址**：https://xike-yuhuofei.github.io/Century/
- **自动部署**：[.github/workflows/pages.yml](.github/workflows/pages.yml)。每次 `main` 的 `web-v1/**` 更新会校验卡牌、运行测试、重新编译，并将 `web-v1/dist/standalone.html` 发布为网站首页。
- **首次启用（仓库管理员操作一次）**：打开仓库 **Settings → Pages → Build and deployment**，将 **Source** 设置为 **GitHub Actions**。如首次自动运行因未启用 Pages 而失败，到 **Actions → Deploy Century Game to GitHub Pages → Run workflow** 选择 `main` 重跑。
- **手机地址**：https://xike-yuhuofei.github.io/Century/mobile/ 。独立触屏界面提供双行市场、底部手牌抽屉、完整行动与双真人交接遮挡；复用电脑版规则和 AI 2.0。手机与电脑各自保存本地对局，可显式导入/导出备份，不支持跨设备实时联机。
- **设计与验收**：[交付报告](docs/mobile/DELIVERY.md)、[自查报告](docs/mobile/SELF-AUDIT.md)。
- **复盘导出**：电脑端「行动记录 ☷」、手机端「菜单 → 行动记录与复盘导出」，支持 Markdown 和 JSON。新局完整记录所有玩家每回合的行动与资源变化，随存档保留，结束后仍可导出；旧存档从更新后的接续点开始记录。详见 [复盘说明](web-v1/README.md#导出对局复盘)。

## 验证

需要 Node.js 18+，无额外 npm 依赖：

```bash
node scripts/validate-cards.mjs
```

GitHub Actions 会在推送及拉取请求时复跑相同校验。

## 来源与限制

游戏规则依据 [2024官方英文规则书](https://cdn.svc.asmodee.net/production-nextmove/uploads/sites/4/2024/06/EN-Century-Golem-Rules_2024_compressed.pdf)。牌面数据来自开源实现的交叉核对，不应视为官方唯一完整牌面清单。2026-10-19起，进度状态不写入 ChatGPT 静态项目规范；GitHub 变更以每次用户明确授权为前提。
