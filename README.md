# 税优政策库（税收优惠政策浏览平台）

> 最新税收优惠政策，自动抓取国家税务总局政策法规库 + 广东省税务局，免费、免备案、零运维。网页版 + 微信小程序双端。

## 这是什么

一个面向「个人 + 企业」的**税收优惠政策浏览、查看**平台。

核心能力：**政策一变，自动同步**。数据来自国家税务总局政策法规库（fgk.chinatax.gov.cn）+ 广东省税务局（guangdong.chinatax.gov.cn）官方源，Worker 每天定时抓取最新政策、结构化、判定优惠、按税种/优惠类型/地区/区域分类，并给每条政策配「一句话看懂」大白话摘要。官方发了新政策自动出现在页面上，无需人工维护。

## 线上地址

- **网页版**：https://jy.1211.cc.cd
- **微信小程序**：`miniprogram/`（AppID `wx940d75405673b165`）

## 功能

### 政策库

- **政策列表**：约 371 条政策按日期倒序（标题 / 文号 / 成文日期 / 发文单位 / 效力等级）
- **只看优惠**：一键只看「税收优惠」政策（82 条，免征 / 减税 / 退税 / 扣除抵免等）
- **多维度筛选**：税种、优惠类型、地区（全国 / 广东）、区域（横琴 / 前海 / 南沙 / 大湾区 / 河套）、有效期状态（生效中 / 即将到期 / 已到期 / 未标注 / 待核实）
- **关键词搜索**：搜标题 / 文号 / 正文摘要
- **一句话看懂**：每条政策配大白话摘要，覆盖率 92%（`enrich` 表 342 条）
- **服务端分页**：首屏只拉 40 条（**约 19KB**，此前一次返回全量 ~190KB），翻页按需加载；筛选维度（chips）由服务端 `facets` 下发，不用加载全量数据
- **站内读正文**：网页版点卡片直接在当前页滑出原文（`/api/detail?id=`），不用跳走；卡片右下角另有「原文 ↗」可直跳官方页
- **收藏 / 筛选状态记忆 / 回到顶部 / NEW 徽标 / 下拉刷新 / 加载更多**

### 三张「是不是还开着」的表（本平台的核心价值）

- **增值税新法衔接表**（`/api/vat-continuity`）：依据《增值税法》+ 财政部 税务总局公告 2026 年第 10 号，逐条列出 58 项增值税优惠在 2026 年新法下**继续有效还是已停止**
- **企业所得税到期地图**（`/api/cit-continuity`）：24 条所得税优惠逐条标注**长期有效 / 有效至某日 / 待核实 / 已到期**
- **个人所得税到期地图**（`/api/iit-continuity`）：25 条个税优惠逐条标注**长期有效（写在法律里）/ 有效至某日 / 待核实 / 2026 年新规**

### 两个「帮我找」的入口

- **按身份打包**（`/api/packs`）：把散在几百条里的政策按「我是谁」聚成四套——小微企业 13 条、高新/研发 20 条、个体户 7 条、打工人 26 条，不用一条条翻
- **本季到期**（`/api/expiring`）：当前季度内到期的政策清单，按到期日升序，附「还剩 N 天」

### 跟踪清单（`/api/watch`）

对**官方还没发文的政策**（横琴、南沙的企业所得税 15% 和港澳居民个税 15%，原文件执行至 2025-12-31），单独列成一张可核对清单：写明现行依据、在等什么文件、去哪儿查、查到后改哪个文件哪一行。系统还会在政策库里自动找「地区 + 延续/延长」的新文件，命中就标红提示人工确认。

**不猜、不编**——官方没发文就标「待核实」，等发了再改。

## 架构

```
┌────────────────────────────────────────────────────────────┐
│  前端（网页 web/ + 微信小程序 miniprogram/）                  │
│    网页 4 个 tab：政策库 / 按身份 / 本季到期 / 三张衔接表       │
│    小程序 4 个 tab：政策库 / 按身份 / 本季到期 / 衔接表         │
│                                                             │
│  Cloudflare Worker  worker/index.js                         │
│    ├─ /api/policies   默认分页 + 服务端筛选（?all=1 返全量）   │
│    ├─ /api/packs      按身份打包                              │
│    ├─ /api/expiring   本季度到期清单                          │
│    ├─ /api/watch      等官方发文的跟踪清单                     │
│    ├─ /api/{vat,cit,iit}-continuity  三张衔接表（静态数据）    │
│    ├─ /api/detail     抓官方正文（id 或 url 两种入参，KV 缓存 7 天）│
│    ├─ /healthz        健康检查（异常返 503，给外部监控用）      │
│    └─ /api/refresh    手动触发一次全量抓取                     │
│                                                             │
│  抓取链路（fetchAll）                                        │
│    ├─ 读 KV（POLICIES）── 新鲜(24h) ──► 秒出                 │
│    ├─ 过期但有旧数据 ──► 先返旧 + 后台刷新(stale-while-revalidate)│
│    └─ 无缓存 ──► 现场抓取：                                   │
│         ├─ 总局 fgk 8 栏目（getFileListByCodeId，各 50 条）    │
│         ├─ 广东局 2 栏目（服务端渲染 HTML，正则解析）           │
│         ├─ 总局全文搜索 5 区域关键词（search5/search/s，串行+重试）│
│         ├─ REGIONAL_SEED 13 条核心区域政策（硬编码兜底）       │
│         ├─ 结构化 + 优惠判定 + 税种分类 + 有效期标记 + 去重排序  │
│         ├─ 套用 enrich 离线补全表（真实文号 / 有效期 / 摘要）    │
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
| `worker/index.js` | **核心**：路由 + 抓取 → 结构化 → 优惠判定 → 摘要 → KV 缓存 → API（962 行） |
| `worker/query.js` | 纯函数查询层：`IDENTITY_PACKS` / `buildPacks` / `quarterRange` / `buildExpiring` / `filterItems` / `buildFacets` / `paginate` |
| `worker/watch.js` | 待跟踪清单：`WATCH_ITEMS`（横琴/南沙 4 项）/ `WATCH_RESOLVED`（前海、大湾区已确认）/ `buildWatch` |
| `worker/vatContinuity.js` | 增值税新法衔接表静态数据（58 项） |
| `worker/citContinuity.js` | 企业所得税到期地图静态数据（24 项） |
| `worker/iitContinuity.js` | 个人所得税到期地图静态数据（25 项） |
| `worker/detail.js` | 单篇政策正文抓取与清洗（`extractBody` / `fetchDetail`） |
| `web/index.html` + `web/app.js` | 网页版前端（政策库 + 身份包 + 本季到期 + 三张对照表 / 筛选 / 搜索 / 收藏 / 正文抽屉） |
| `web/manifest.json` + `web/sw.js` | PWA：可「添加到主屏幕」当 App 用，支持离线打开 |
| `miniprogram/` | **微信小程序**（4 个 tab，`config.js` 配后端地址） |
| `wrangler.toml` | Cloudflare 部署配置（Worker + assets + 自定义域名 + cron） |
| `server/index.js` | **普通 Node 服务器版入口**（阿里云 / 任意 VPS），复用同一套 `worker/*.js` |
| `package.json` | Node 版启动配置（零依赖，`npm start` / `node server/index.js`） |
| `scripts/smoke.mjs` | 本地自测脚本（`node scripts/smoke.mjs [--full]`） |
| `scripts/enrich.mjs` | **离线补全**：本机抓 300+ 篇正文，补真实文号 / 有效期 / 首段摘要 |
| `data/enrich.json` | 离线补全结果（推送到 KV 的 `enrich` 键，cron 重抓不会覆盖） |
| `data/enrich-ver.txt` | enrich 版本号（推到 KV 的 `enrich_ver` 键，用于判断主缓存是否过时） |
| `.github/workflows/smoke.yml` | CI：语法检查 + 冒烟测试 |
| `docs/技术架构.md` | 数据源接口、解析规则、API 契约、已知限制 |
| `docs/CF网页版部署指南.md` | Cloudflare 部署、抓取、故障排查、回滚 |
| `docs/阿里云部署指南.md` | 阿里云部署 + 备案接入 + Nginx/HTTPS（小程序合规路线） |
| `deploy/` | 阿里云 Ubuntu 部署即用件：`docker-compose.yml` / `nginx.conf` / 一页纸步骤 |

## API

| 端点 | 说明 |
|---|---|
| `GET /api/policies` | **默认分页**：`?page=1&size=40`，可带 `q` / `tax` / `type` / `region` / `area` / `status` / `prefOnly=1` / `newOnly=1` / `favOnly=1&favs=id1,id2`。返回 `{items,total,prefCount,page,size,totalPages,facets,enrichVersion,...}`。`?all=1` 返全量（给 enrich 脚本用） |
| `GET /api/packs` | 按身份打包，返回 4 个包（含 `count` 与最多 30 条 `items`） |
| `GET /api/expiring` | 本季度到期清单，返回 `{quarter,start,end,count,items}` |
| `GET /api/watch` | 待跟踪清单，返回 `{pending,resolved,pendingCount,note}` |
| `GET /api/vat-continuity` · `/api/cit-continuity` · `/api/iit-continuity` | 三张衔接表：`{law,groups,items,total,updatedAt}` |
| `GET /api/detail?id=<id>` 或 `?url=<官方链接>` | 抓官方原文正文，返回 `{ok,title,docNo,date,department,paragraphs,chars,url}`；KV 缓存 7 天 |
| `GET /healthz` | 健康检查，异常返 503 |
| `GET /api/refresh` | 手动触发全量抓取（约 35s） |

## 数据源细节

- **总局法规库**：8 个栏目（财税文件、税务规范性文件、政策法规文件、法律、行政法规、国务院文件、其他文件、工作通知），接口 `POST https://www.chinatax.gov.cn/getFileListByCodeId`（`codeId=''` + `channelId=<栏目UUID>` + `page` + `size`，需 `Referer: https://fgk.chinatax.gov.cn/zcfgk/`）。
- **总局全文搜索**：`GET https://www.chinatax.gov.cn/search5/search/s`（`searchWord` / `siteCode=bm29000002` / `searchSiteName=GSFFK` 等），用于区域优惠专题补充（横琴 / 前海 / 南沙 / 大湾区 / 河套 5 个关键词）。
- **广东省税务局**：政策文件 + 最新文件 2 个栏目，服务端渲染 HTML，正则解析列表。
- **区域专题**：`REGIONAL_SEED` 内置 13 条核心政策（横琴 / 前海 / 南沙企业所得税 15%、个税 15% 免征、大湾区个税），因总局法规库对区域核心文件收录不全，seed 兜底 + 搜索接口补充最新。
- **优惠判定**：官方接口不返回「是否优惠」字段，用关键词判定（免征 / 免税 / 减征 / 减半 / 减按 / 退税 / 即征即退 / 留抵退税 / 加计扣除 / 抵免 / 减免 / 优惠 / 零税率等）+ 否定词过滤（废止 / 取消 / 失效 / 不再执行等）。
- **有效期标记**：`parseExpiry` 从标题/摘要正则提取「至 YYYY 年 MM 月 DD 日 / 至 YYYY 年底 / 延续实施至…」，配合 `EFFECTIVE_UNTIL` 对照表补高频政策，判定「生效中 / 即将到期 / 已到期 / 未标注」。**分阶段政策**（如新能源车购置税「2024—2025 免征、2026—2027 减半」）用 `EXPIRY_OVERRIDE` 逐条核实更正，正则只能抓到第一个日期，不能这样用。
- **离线补全（关键）**：CF Worker 免费版 CPU 约 10ms，一次请求只能抓十几篇正文，所以线上原本 340+ 条没有有效期、50+ 条只有模板拼的假摘要。解法是把抓正文搬到本机：`node scripts/enrich.mjs` 跑一遍，结果写 KV 的 `enrich` 键，Worker 每次 `fetchAll` 读出来套用。**每天 cron 重抓不会覆盖**，因为它是独立的 KV 键。
- **同步策略**：cron 每天 09:00（北京）抓取写 KV；请求时 stale-while-revalidate（KV 过期先返旧数据 + 后台刷新）。KV 缓存 24 小时。enrich 推送后会写 `enrich_ver` 版本键，主缓存版本对不上就自动后台刷新。

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

### 服务器版（阿里云 / 任意 VPS，小程序合规路线）

`server/index.js` 只在本地实现了 Cloudflare 提供的两件事——KV（本地 JSON 文件 `data/kv.json`）和静态资源（本地 `web/` 目录），**`worker/index.js` 一行不用改**。

```bash
cd /workspace/tax-miniapp
PORT=8787 node server/index.js        # 零依赖，无需 npm install
curl http://127.0.0.1:8787/api/policies
```

- 首次访问会现场抓 15 个官方源（约 20~30 秒），之后写进 `data/kv.json`（约 230KB），重启后读缓存 30ms 级
- 内置每天 `DAILY_HOUR`（默认 9 点）自动抓取，等价于 CF 的 cron
- 完整步骤（买服务器 / 备案接入 / systemd / Nginx / certbot HTTPS / 小程序改域名）见 [docs/阿里云部署指南.md](docs/阿里云部署指南.md)

### 微信小程序

1. 微信开发者工具导入 `/workspace/tax-miniapp`（AppID 已填 `project.config.json`：`wx940d75405673b165`）
2. 开发者工具「详情 → 本地设置 → 勾选不校验合法域名」即可直连后端调试
3. 上线前：`miniprogram/config.js` 的 `API_BASE` 换成**已 ICP 备案**的域名 + 小程序后台加 request 合法域名

> 小程序 4 个 tab：政策库 / 按身份 / 本季到期 / 衔接表。政策卡片点开走 `/pages/detail`，由后端抓官方正文渲染（小程序不能直接打开外部网页）。
> **全项目不使用任何隐私接口**（无剪贴板、无位置、无相册、无手机号），提审时选【未采集用户隐私】即可。

## 冷启动 & 离线补全

```bash
# 1) 补全（本机跑，约 15 秒 / 371 条）。改了抓取逻辑或想刷一遍内容质量时跑
node scripts/enrich.mjs

# 2) 推到 KV —— 两个键都要推，缺 enrich_ver 会让缓存版本比对失效
npx wrangler kv key put --namespace-id=853d9ddc1d7844169f13d085af2290a2 enrich --path=data/enrich.json --remote
npx wrangler kv key put --namespace-id=853d9ddc1d7844169f13d085af2290a2 enrich_ver --path=data/enrich-ver.txt --remote

# 3) 自测：smoke 会读 data/enrich.json，跑出来跟线上一致
node scripts/smoke.mjs
```

> **`--only-missing` 会整份覆盖 `data/enrich.json`**。脚本已改成按 id 做**字段级合并**（`merged[id] = {...merged[id], ...newValue}`），避免某条这次只抓到 expiry 就把上次的好摘要弄丢。
> 总局对机房 IP 限流很凶（403），跑的时候如果成功率低于 60%，脚本会拒绝写文件（`exit 2`），保护已有好数据。

## 监控

`GET /healthz` 是给外部监控用的健康检查，数据出问题返回 **503**：

| 检查项 | 触发条件 |
|---|---|
| `kv_empty` | KV 里没有政策数据 |
| `stale_Nh` | 数据超过 36 小时没更新（说明 cron 没跑成） |
| `too_few_items_N` | 抓到的政策少于 300 条（说明官方源改版/抓取失败） |
| `scrape_errors_N` | **核心栏目**报错数 ≥ 4（官方 10 个栏目过半抓不到才算故障） |

区域关键词搜索失败**不计入**故障——总局搜索接口对机房 IP 限流严重，且区域核心政策有 `REGIONAL_SEED` 兜底。这类失败进 `warnings` 字段，只在 `/healthz` 里展示，不触发 503（否则监控会被非致命失败刷成告警）。

接 [UptimeRobot](https://uptimerobot.com/) 免费版：新建 HTTPS 监控 → URL 填 `https://jy.1211.cc.cd/healthz` → 间隔 5 分钟 → 告警邮箱。**它返回 503 就说明数据坏了**，不用等用户来报。

## 本地自测

```bash
node scripts/smoke.mjs          # 秒级：三张表 + 缓存读取
node scripts/smoke.mjs --full   # 额外真实抓一次全量（约 10~30s）
node server/index.js            # 起本地服务器版，验证 worker 逻辑
```

检查项：政策/优惠条数、抓取报错、**有无指向官网首页的假链接**、区域政策有无被误删、三张表的条数/状态值/分组值是否合法。全绿再部署。

## 已知限制

1. **小程序上线卡在域名备案**——`wx.request` 只允许备案域名，`jy.1211.cc.cd` 在 Cloudflare 上未备案（且 `.cd` 后缀本身办不了备案）。开发者工具可用，真机/发布会被拦。**现成出路**：已备好的 `server/index.js` 部署到阿里云 + 已备案域名 `1211663.xyz`，见 [docs/阿里云部署指南.md](docs/阿里云部署指南.md)。
2. **横琴、南沙的区域优惠标「待核实」**——原文件执行至 2025-12-31，总局/财政部/省局/专区四渠道均检索不到延续文件（前海已由深圳税务局 12366 问答确认延续至 2027-12-31，财政部 财税〔2026〕3号）。页面用 `/api/watch` 单独列出这 4 项，写清在等什么文件、去哪儿查，并自动扫描政策库里「地区 + 延续」的新文件。官方没发文就不猜。
3. **72 条政策没有发文字号，其中 63 条不是数据缺失**——法律和行政法规（《增值税法》《优化营商环境条例》等）本身就没有「财税〔〕号」，官方库只给部门规范性文件编文号。系统给这些打 `docType: 'law'`，前端显示「法律法规」；5 条是官方问答/科普稿（`docType: 'qa'`，显示「政策解读」），4 条是意见/清单类。**真正的文号缺失是 0 条**。
4. **「优惠」标签是关键词判定**，非官方结论，以原文为准。
5. **CF 免费计划 CPU 约 10ms**，线上抓正文能力有限——所以真实摘要靠本机 `enrich` 离线补全，不靠 Worker 实时抓。
6. **区域关键词搜索经常失败**——总局搜索接口对机房 IP 限流，线上大概率抓不到（已有 seed 兜底），进 `warnings`。

## 免责声明

本平台仅供税收政策浏览与知识普及，不构成税务建议。「优惠」标签为系统关键词判定，有效期与衔接表信息请以官方原文为准。
