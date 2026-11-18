# 税优政策库（税收优惠政策浏览平台）

> 最新税收优惠政策，自动抓取国家税务总局政策法规库 + 广东省税务局，免费、免备案、零运维。网页版 + 微信小程序双端。

## 这是什么

一个面向「个人 + 企业」的**税收优惠政策浏览、查看**平台。

核心能力：**政策一变，自动同步**。数据来自国家税务总局政策法规库（fgk.chinatax.gov.cn）+ 广东省税务局（guangdong.chinatax.gov.cn）官方源，Worker 每天定时抓取最新政策、结构化、判定优惠、按税种/优惠类型/地区/区域分类，并给每条优惠生成「一句话看懂」大白话摘要。无需人工维护，官方发了新政策自动出现在页面上。

## 线上地址

- **网页版**：https://jy.1211.cc.cd
- **微信小程序**：`miniprogram/`（AppID `wx940d75405673b165`）

## 功能

- **政策列表**：约 383 条政策按日期倒序（标题 / 文号 / 成文日期 / 发文单位 / 效力等级）
- **只看优惠**：一键只看「税收优惠」政策（83 条，免征 / 减税 / 退税 / 扣除抵免等）
- **多维度筛选**：税种、优惠类型、地区（全国 / 广东）、区域（横琴 / 前海 / 南沙 / 大湾区）、有效期状态（生效中 / 即将到期 / 已到期 / 未标注 / 待核实）
- **关键词搜索**：搜标题 / 文号 / 摘要
- **正文详情**（`/api/detail?id=`）：小程序里直接读官方原文正文
- **一句话看懂**：每条优惠配大白话摘要（核心政策人工精写，最新政策抓详情页正文首段，其余模板生成）
- **原文就在小程序里看**：网页版点卡片直达官方原文；小程序点卡片进详情页，由后端抓官方正文渲染（不用跳浏览器），长按卡片可快速复制链接
- **增值税新法衔接表**（`/api/vat-continuity`）：依据《增值税法》+ 财政部 税务总局公告 2026 年第 10 号，逐条列出 58 项增值税优惠在 2026 年新法下**继续有效还是已停止**（`worker/vatContinuity.js`，静态数据）
- **所得税到期地图**（`/api/cit-continuity`）：24 条企业所得税优惠逐条标注**长期有效 / 有效至某日 / 待核实 / 已到期**（`worker/citContinuity.js`，静态数据）
- **个税到期地图**（`/api/iit-continuity`）：25 条个人所得税优惠逐条标注**长期有效（写在法律里）/ 有效至某日 / 待核实 / 2026 年新规**（`worker/iitContinuity.js`，静态数据）。覆盖基本减除费用、七项专项附加扣除、年终奖与股权激励单独计税、个人养老金、企业年金、税优健康险、科技成果转化、股息红利差别化、换购住房退税、重点群体与退役士兵扣减、大湾区/前海/横琴/南沙/海南区域人才优惠，以及 2026 年新增的资源回收反向开票 0.25% 预缴、离岸信托征管口径。
- **下拉刷新 / 加载更多 / 筛选状态记忆**：前端体验优化

## 架构

```
┌────────────────────────────────────────────────────────────┐
│  前端（网页 web/ + 微信小程序 miniprogram/）                  │
│    └─ /api/policies · /api/vat-continuity · /api/cit-continuity · /api/iit-continuity
│                                                             │
│  Cloudflare Worker  worker/index.js                         │
│    ├─ 读 KV（POLICIES）── 新鲜(24h) ──► 秒出                │
│    ├─ 过期但有旧数据 ──► 先返旧数据 + 后台刷新(stale-while-revalidate)
│    └─ 无缓存 ──► 现场抓取：                                   │
│         ├─ 总局 fgk 8 栏目（getFileListByCodeId，各 50 条）    │
│         ├─ 广东局 2 栏目（服务端渲染 HTML，正则解析）           │
│         ├─ 总局全文搜索 5 区域关键词（search5/search/s，串行+重试）│
│         ├─ REGIONAL_SEED 13 条核心区域政策（硬编码兜底）       │
│         ├─ 结构化 + 优惠判定 + 税种分类 + 有效期标记 + 去重排序  │
│         ├─ 优惠补摘要（详情页正文 / 模板兜底）                  │
│         └─ 写 KV ──► 返回 JSON                               │
│                                                             │
│  cron 定时：每天 09:00（北京）自动抓取 → 写 KV                 │
└────────────────────────────────────────────────────────────┘
```

**为什么免费、为什么不用备案、为什么不用数据库**：

- **免费**：Cloudflare Workers 免费额度（10 万次请求/天）+ KV 免费额度（10 万读 / 1000 写 / 天）远超本项目需求（每天 cron 写 1 次，读几十次）。
- **免备案**：走 Cloudflare 边缘 + 自有域名 `jy.1211.cc.cd`，不经过国内服务器，无需 ICP 备案。
- **无数据库**：政策数据量小（几百条），用 KV 持久化即可，每天定时刷新，无需数据库。

> 注意：微信小程序上线发布时，`wx.request` 要求后端域名已 ICP 备案。小程序开发阶段可在开发者工具勾选「不校验合法域名」直连；上线前需把 `miniprogram/config.js` 的 `API_BASE` 换成备案域名。

## 目录说明

| 路径 | 说明 |
|---|---|
| `worker/index.js` | **核心**：抓取 → 结构化 → 优惠判定 → 摘要 → KV 缓存 → API |
| `worker/vatContinuity.js` | 增值税新法衔接表静态数据（58 项） |
| `worker/citContinuity.js` | 企业所得税到期地图静态数据（24 项） |
| `worker/iitContinuity.js` | 个人所得税到期地图静态数据（25 项） |
| `worker/detail.js` | 单篇政策正文抓取与清洗（`/api/detail`） |
| `web/index.html` + `web/app.js` | 网页版前端（政策库 + 三张对照表 / 筛选 / 搜索 / 收藏） |
| `miniprogram/` | **微信小程序**（政策库 + 三张对照表，`config.js` 配后端地址） |
| `wrangler.toml` | Cloudflare 部署配置（Worker + assets + 自定义域名 + cron） |
| `scripts/smoke.mjs` | 本地自测脚本（`node scripts/smoke.mjs [--full]`） |
| `docs/技术架构.md` | 数据源接口、解析规则、已知限制 |
| `docs/CF网页版部署指南.md` | 部署、抓取、故障排查、回滚 |

## 数据源细节

- **总局法规库**：8 个栏目（财税文件、税务规范性文件、政策法规文件、法律、行政法规、国务院文件、其他文件、工作通知），接口 `POST https://www.chinatax.gov.cn/getFileListByCodeId`（`codeId=''` + `channelId=<栏目UUID>` + `page` + `size`，需 `Referer: https://fgk.chinatax.gov.cn/zcfgk/`）。
- **总局全文搜索**：`GET https://www.chinatax.gov.cn/search5/search/s`（`searchWord` / `siteCode=bm29000002` / `searchSiteName=GSFFK` 等），用于区域优惠专题补充（横琴 / 前海 / 南沙 / 大湾区 / 河套 5 个关键词）。
- **广东省税务局**：政策文件 + 最新文件 2 个栏目，服务端渲染 HTML，正则解析列表。
- **区域专题**：`REGIONAL_SEED` 内置 13 条核心政策（横琴 / 前海 / 南沙企业所得税 15%、个税 15% 免征、大湾区个税），因总局法规库对区域核心文件收录不全，seed 兜底 + 搜索接口补充最新。
- **优惠判定**：官方接口不返回「是否优惠」字段，用关键词判定（免征 / 免税 / 减征 / 减半 / 减按 / 退税 / 即征即退 / 留抵退税 / 加计扣除 / 抵免 / 减免 / 优惠 / 零税率等）+ 否定词过滤（废止 / 取消 / 失效 / 不再执行等）。
- **有效期标记**：`parseExpiry` 从标题/摘要正则提取「至 YYYY 年 MM 月 DD 日 / 至 YYYY 年底 / 延续实施至…」，配合 `EFFECTIVE_UNTIL` 对照表补高频政策，判定「生效中 / 即将到期 / 已到期 / 未标注」。
- **同步策略**：cron 每天 09:00（北京）抓取写 KV；请求时 stale-while-revalidate（KV 过期先返旧数据 + 后台刷新）。KV 缓存 24 小时。

## 部署

### 网页版（Cloudflare Worker）

```bash
cd /workspace/tax-miniapp
unset HTTP_PROXY HTTPS_PROXY http_proxy https_proxy ALL_PROXY all_proxy NODE_USE_ENV_PROXY
set -a && source /workspace/cf-md-notes/.env.local && set +a   # CLOUDFLARE_API_TOKEN / ACCOUNT_ID
node scripts/smoke.mjs --full      # 先自测
npx wrangler deploy
curl https://jy.1211.cc.cd/api/refresh   # 立即抓一次（也可等次日 09:00）
```

> 必须 `unset` 代理（本机内网代理一挂 wrangler 就报 `fetch failed`），必须 source token（否则报 `non-interactive environment`）。完整运维手册见 [docs/CF网页版部署指南.md](docs/CF网页版部署指南.md)。

### 微信小程序

1. 微信开发者工具导入 `/workspace/tax-miniapp`（AppID 已填 `project.config.json`：`wx940d75405673b165`）
2. 开发者工具「详情 → 本地设置 → 勾选不校验合法域名」即可直连后端调试
3. 上线前：`miniprogram/config.js` 的 `API_BASE` 换成**已 ICP 备案**的域名 + 小程序后台加 request 合法域名

## 本地自测

```bash
node scripts/smoke.mjs          # 秒级：三张表 + 缓存读取
node scripts/smoke.mjs --full   # 额外真实抓一次全量（约 10~30s）
```

检查项：政策/优惠条数、抓取报错、**有无指向官网首页的假链接**、区域政策有无被误删、三张表的条数/状态值/分组值是否合法。全绿再部署。

## 已知限制

1. **小程序上线卡在域名备案**——`wx.request` 只允许备案域名，`jy.1211.cc.cd` 在 Cloudflare 上未备案。开发者工具可用，真机/发布会被拦。出路：换备案域名指向同一 Worker / 静态打包随版本发 / 微信云开发（要钱）。
2. **横琴、南沙的区域优惠标「待核实」**——原文件执行至 2025-12-31，总局/财政部/省局三渠道均检索不到延续文件（前海已由深圳税务局 12366 问答确认延续至 2027-12-31）。页面明确标注需人工确认，不猜。
3. **「优惠」标签是关键词判定**，非官方结论，以原文为准。
4. **CF 免费计划 CPU 约 10ms**，只能给约 10 条优惠抓真正文摘要，其余为模板摘要。

## 免责声明

本平台仅供税收政策浏览与知识普及，不构成税务建议。「优惠」标签为系统关键词判定，有效期与衔接表信息请以官方原文为准。
