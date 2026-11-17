# 税优计算器 · 网页版上线说明（已部署）

## 当前状态：✅ 已上线

| 项目 | 值 |
|---|---|
| 访问地址 | **https://te.1211.cc.cd** |
| 部署方式 | Cloudflare Workers Static Assets（纯静态，无服务器、无数据库） |
| 架构参考 | 同账号下的 `cf-finance-calc`（js.1211.cc.cd），完全同款 |
| 政策数据 | GitHub 仓库 `tel9980/tax-miniapp` 的 `data/policies.json` |
| 成本 | 免费（CF 免费额度个人用根本用不完） |
| 备案 | 不需要（网页没有备案限制） |

## 架构：为什么这样最省事

参考了 `cf-finance-calc` 的成功经验，走**纯静态托管**：

```
浏览器 → te.1211.cc.cd（CF Workers 托管 web/ 静态文件）
              │
              └─ 打开时 fetch 政策（按优先级）：
                   ① jsDelivr CDN（cdn.jsdelivr.net）
                   ② GitHub raw（raw.githubusercontent.com）
                   ③ 内置兜底数据（断网也能算）
```

- **没有后端代码、没有数据库**：税务算法全在浏览器本地跑，纯计算器。
- **政策自动同步**：政策一变，改 GitHub 上的 JSON + 版本号加一，用户下次打开自动更新，不用重新部署。
- **免备案**：网页用浏览器打开，没有小程序那套「域名必须备案」的限制。

## 关键文件

| 文件 | 作用 |
|---|---|
| `wrangler.toml` | CF 部署配置：`[assets]` 托管 `web/`，`[[routes]]` 绑 `te.1211.cc.cd` |
| `web/index.html` | 界面（个人 + 企业 7 个计算器） |
| `web/app.js` | 税务算法 + 政策同步逻辑 |
| `web/_headers` | 安全头 + 缓存策略 + CSP |
| `data/policies.json` | **政策数据源**（唯一需要改政策的地方） |

## 以后怎么改政策（政策一变，只动一个文件）

1. 打开 `data/policies.json`，改对应的税率数字；
2. 把顶部的 `"version": "2026.1"` 改成 `"2026.2"`（**这一步必须做**，否则用户端不会刷新）；
3. 提交到 GitHub（`git push`）：
   ```bash
   cd /workspace/tax-miniapp
   git add data/policies.json && git commit -m "政策更新 2026.2" && git push
   ```
4. **不用重新部署网页**。用户下次打开（或点页面上的同步）就自动拿到新政策，且会缓存在浏览器本地。

## 以后怎么改代码/界面（需要重新部署）

改了 `web/` 下的任何文件后，跑一次：

```bash
cd /workspace/tax-miniapp
npx wrangler deploy
```

约 5 秒生效（页面本身 `max-age=0`，改版立即生效）。

## 部署凭证（已在本机配置好）

部署命令需要两个环境变量，已存在本机 `cf-md-notes/.env.local`（勿外传）：

- `CLOUDFLARE_API_TOKEN`（需要 Workers 脚本 + DNS 编辑权限）
- `CLOUDFLARE_ACCOUNT_ID`

只要在同一台机器上跑 `npx wrangler deploy`，凭证会自动加载，无需手动填。

## 换域名

改 `wrangler.toml` 里的 `pattern`（如 `te.1211.cc.cd` → 别的子域），再 `npx wrangler deploy` 一次，CF 自动建 DNS 记录并签发证书。
