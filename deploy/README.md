# 阿里云 Ubuntu 部署（Docker 版 · 5 分钟）

> 你的环境：PVE → Ubuntu → Docker → 容器。这套部署跟你家里那套是同一个路子，只是换到有 443 的公网服务器上。
> 为什么必须挪到服务器：家宽 80/443 被运营商封（实测超时），而微信小程序**不接受带端口的域名**，只能用标准 443。

## 0. 前提

- 一台阿里云 Ubuntu 22.04/24.04（2核2G，轻量或 ECS 都行）
- `1211663.xyz` 备案有效（`api.1211663.xyz` 跟着主域名走，不用单独备案）
- 阿里云**安全组**放行 80 和 443

## 1. DNS 加一条记录（阿里云控制台 → 云解析）

| 记录类型 | 主机记录 | 记录值 | TTL |
|---|---|---|---|
| A | `api` | 服务器公网 IP | 600 |

> 不要动现有的 `1211663.xyz` 和 `www`，那两个指向你家里的 DSH，保持不变。

验证（在你本地）：

```bash
nslookup api.1211663.xyz
```

必须返回阿里云那台服务器的 IP。

## 2. 服务器装 Docker

```bash
# 官方一键脚本
curl -fsSL https://get.docker.com | sudo sh
sudo systemctl enable --now docker

# 国内拉镜像慢的话，配个加速器
sudo mkdir -p /etc/docker
sudo tee /etc/docker/daemon.json >/dev/null <<'EOF'
{ "registry-mirrors": ["https://docker.m.daocloud.io", "https://dockerproxy.com"] }
EOF
sudo systemctl restart docker
```

## 3. 拉代码

```bash
sudo mkdir -p /opt/tax-miniapp && sudo chown $USER:$USER /opt/tax-miniapp
git clone https://github.com/tel9980/tax-miniapp.git /opt/tax-miniapp
cd /opt/tax-miniapp
mkdir -p data
```

## 4. 起容器

```bash
cd /opt/tax-miniapp
cp deploy/docker-compose.yml .
docker compose up -d
docker compose logs -f          # Ctrl+C 退出日志
```

首次启动后访问一次 API，触发第一次抓取（约 20~30 秒）：

```bash
time curl -s http://127.0.0.1:8787/api/policies | head -c 300
```

看到 `"total":383` 这类输出就成功了。数据落在 `/opt/tax-miniapp/data/kv.json`（约 230KB），容器重建不丢。

## 5. Nginx + HTTPS

```bash
sudo apt update
sudo apt install -y nginx certbot python3-certbot-nginx

sudo cp /opt/tax-miniapp/deploy/nginx.conf /etc/nginx/sites-available/tax-api
sudo ln -sf /etc/nginx/sites-available/tax-api /etc/nginx/sites-enabled/tax-api
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t && sudo systemctl reload nginx

# 自动签证书 + 自动配置续期
sudo certbot --nginx -d api.1211663.xyz
```

certbot 会往配置文件里插 443 和证书路径。选 `2`（Redirect，强制跳 HTTPS）。

验证自动续期：

```bash
sudo certbot renew --dry-run
```

## 6. 验证

```bash
curl https://api.1211663.xyz/api/policies | head -c 200
curl -s https://api.1211663.xyz/api/vat-continuity | head -c 100
curl -sI https://api.1211663.xyz/api/policies | grep -i "content-type\|HTTP/"
```

浏览器直接打开 https://api.1211663.xyz/api/policies 应该能看到 JSON。

## 7. 小程序接上

改 `miniprogram/config.js`：

```js
const API_BASE = 'https://api.1211663.xyz';
```

然后微信公众平台 → 开发管理 → 开发设置 → 服务器域名 → request 合法域名加 `https://api.1211663.xyz`。

> 服务器域名每月只能改 5 次，一次填对。填完在开发者工具里「详情 → 本地设置」取消勾选「不校验合法域名」，重新编译验证。

## 8. 日常运维

| 做什么 | 命令 |
|---|---|
| 看日志 | `cd /opt/tax-miniapp && docker compose logs -f` |
| 重启 | `docker compose restart` |
| 更新代码 | `cd /opt/tax-miniapp && git pull && docker compose restart` |
| 手动抓一次 | `curl -s https://api.1211663.xyz/api/refresh` |
| 清缓存重抓 | `rm /opt/tax-miniapp/data/kv.json && docker compose restart` |
| 看数据更新时间 | `curl -s https://api.1211663.xyz/api/policies \| head -c 200` |

定时抓取内置在 `server/index.js` 里，每天 9 点自动跑，不需要额外配 crontab。

## 9. 如果备案查出来已经被注销

备案接入跟着服务器走。买了阿里云机器后，控制台 → 备案 → **新增接入**，填服务器实例生成的备案服务号，1~3 天审核。审核期间可以先用 IP + 端口调试（`http://<IP>:8787`），小程序那边等备案通过再填域名。

## 10. 跟家里 DSH 的关系

两套完全独立：

```
1211663.xyz      → 家里公网 IP（DSH，docker，非标端口）   ← 不动
api.1211663.xyz  → 阿里云 IP（税收小程序后端，443）        ← 新增
```

同一个主域名下两条 A 记录，互不影响。家里 DSH 的 nginxwebui 配置一个字都不用改。
