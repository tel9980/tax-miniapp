# 税收优惠政策库 · 部署与运维手册

> 面向「要自己把这套东西部署起来 / 出问题了要修」的场景。项目已经在线上跑，本文是现状的完整记录。

## 一、现在跑在哪

| 项目 | 值 |
|---|---|
| 访问地址 | **https://jy.1211.cc.cd** |
| 部署形态 | Cloudflare Workers + Static Assets（纯静态页面 + 一个 Worker 做抓取和 API） |
| 数据存储 | Cloudflare KV（namespace `POLICIES`，id `853d9ddc1d7844169f13d085af2290a2`） |
| 定时抓取 | cron `0 1 * * *`（UTC）= **北京时间每天 09:00** |
| 账号 | Cloudflare account `7362bcc9f4ecec8318bceefe1cc53b28` |
| 费用 | 0 元（免费计划：10 万次请求/天、KV 1GB 读 10 万次/天） |

> 域名 `te.1211.cc.cd` 是旧域名，改成 `jy` 后已自动解绑，访问旧域名会返回 530。

## 二、部署（改了代码之后）

```bash
cd /workspace/tax-miniapp
unset HTTP_PROXY HTTPS_PROXY http_proxy https_proxy ALL_PROXY all_proxy NODE_USE_ENV_PROXY
set -a && source /workspace/cf-md-notes/.env.local && set +a
npx wrangler deploy
```

两个**必须**的细节（踩过坑）：

1. **必须 unset 代理**。本机环境里配了内网代理（`192.168.2.22:20172`），wrangler 会读环境变量走代理，代理一挂就报 `fetch failed`，看着像 CF 挂了，其实是本地代理挂了。
2. **必须 source token**。`CLOUDFLARE_API_TOKEN` 在 `/workspace/cf-md-notes/.env.local`，不 source 会报 `non-interactive environment`（要你交互式登录）。

部署成功会打印 `Current Version ID: xxxxxxxx`，用这个 ID 可以回滚。

## 三、抓取一次数据（不等到明早 9 点）

```bash
curl https://jy.1211.cc.cd/api/refresh
```

约 10~30 秒，返回 `{total, preferenceCount, gdCount, regionalCount, errors}`。`errors` 必须为空数组，非空说明某个源抓失败了（通常是总局搜索接口限流，见第五节）。

> 页面本身不需要手动刷新：`/api/policies` 有「过期先给旧数据、后台悄悄更新」的机制（stale-while-revalidate），缓存有效期 24 小时。

## 四、本地自测（改完代码先跑这个，再部署）

```bash
cd /workspace/tax-miniapp
node scripts/smoke.mjs          # 只测三张静态表 + 读缓存，秒出
node scripts/smoke.mjs --full   # 额外真实抓一次全量（约 10~30 秒）
```

自测会检查：政策总数、优惠条数、抓取报错、**有没有指向官网首页的假链接**、区域政策有没有被误删、三张表的条数/状态值/分组值是否合法。全绿才部署。

## 五、常见故障排查

| 现象 | 原因 | 处理 |
|---|---|---|
| `wrangler deploy` 报 `fetch failed` | 环境里的代理挂了 | 先 `unset` 代理变量（见第二节） |
| deploy 报 `non-interactive environment` | 没 source token | `source /workspace/cf-md-notes/.env.local` |
| 页面数据变少、`errors` 非空 | 总局搜索接口 `search5/search/s` 对 CF 出口 IP 限流（返回 HTML 而不是 JSON） | 等几分钟再 `/api/refresh`；代码已内置 3 次指数退避重试 + 串行间隔 1 秒 |
| 某条政策点开是官网首页 | 该政策原文法规库没收，代码里被兜底成首页 | 已修：现在这类条目**不做成链接**，显示「官方库未收录原文」提示（smoke 测试会拦住回归） |
| 政策摘要变短/变成模板话 | CF 免费计划 CPU 只有约 10ms，抓详情页正文的条目被限制在前 10 条 | 正常现象；优先给「优惠」类政策抓真摘要，其余用模板兜底 |
| 改完 KV 数据没变 | `/api/policies` 24 小时内直接读缓存 | 调一次 `/api/refresh`，或删 KV key（见下） |
| 想重置「NEW」标记 | KV 里存了 `seen` 快照 | `npx wrangler kv key delete --namespace-id=853d9ddc1d7844169f13d085af2290a2 "seen" --remote` |

## 六、回滚

CF 控制台 → Workers & Pages → `tax-miniapp` → Deployments → 选历史版本 → Rollback。
或本地 `git log` 找到旧代码重新 deploy。

## 七、小程序端

`miniprogram/` 就是微信小程序源码，`miniprogram/config.js` 里 `API_BASE` 指向 `https://jy.1211.cc.cd`。

**硬门槛（目前唯一没解决的）**：微信小程序 `wx.request` 只允许请求**已 ICP 备案**的域名，`jy.1211.cc.cd` 挂在 Cloudflare 上、没有国内备案，所以：

- 微信开发者工具里勾了「不校验合法域名」可以跑；
- **真机预览和正式发布会被拦**，必须换一个已备案域名指向同一个 Worker，或改成静态打包方案。

详见 `docs/技术架构.md` 最后一节。
