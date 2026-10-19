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

- **预计游戏地址（Pages 启用后）**：https://xike-yuhuofei.github.io/Century/
- **自动部署**：[.github/workflows/pages.yml](.github/workflows/pages.yml)。每次 `main` 的 `web-v1/**` 更新会校验卡牌、运行测试、重新编译，并将 `web-v1/dist/standalone.html` 发布为网站首页。
- **首次启用（仓库管理员操作一次）**：打开仓库 **Settings → Pages → Build and deployment**，将 **Source** 设置为 **GitHub Actions**。如首次自动运行因未启用 Pages 而失败，到 **Actions → Deploy Century Game to GitHub Pages → Run workflow** 选择 `main` 重跑。
- **手机**：Safari / Chrome 打开网页，可将其添加至主屏幕；当前 UI 主要针对超宽屏设计，手机布局尚未专项优化。网页仅为当前设备本地游戏，存档位于浏览器本地存储，不支持跨设备实时联机。

## 验证

需要 Node.js 18+，无额外 npm 依赖：

```bash
node scripts/validate-cards.mjs
```

GitHub Actions 会在推送及拉取请求时复跑相同校验。

## 来源与限制

游戏规则依据 [2024官方英文规则书](https://cdn.svc.asmodee.net/production-nextmove/uploads/sites/4/2024/06/EN-Century-Golem-Rules_2024_compressed.pdf)。牌面数据来自开源实现的交叉核对，不应视为官方唯一完整牌面清单。2026-10-19起，进度状态不写入 ChatGPT 静态项目规范；GitHub 变更以每次用户明确授权为前提。
