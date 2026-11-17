# 税收优惠微信小程序 —— 后端接口清单与部署文档

> 面向「税收优惠微信小程序」从纯前端原型升级到带后端服务的落地文档。
> 结论先行：**当前版本不需要后端**；只有在"政策云下发、跨设备保存、留资/代账对接、网页版"等需求出现时才引入。且**受"域名未备案"硬约束，微信小程序端不能直连 Cloudflare 域名**，本文给出三套真实可行的路径及取舍。

---

## 目录

1. [架构选型判断](#一架构选型判断)
2. [未备案的应对方案](#二未备案的应对方案)
3. [REST API 接口清单](#三rest-api-接口清单)
4. [云数据库表结构（D1 / SQLite）](#四云数据库表结构d1--sqlite)
5. [部署步骤（GitHub + CF Worker + D1）](#五部署步骤github--cf-worker--d1)
6. [版本策略建议（税率/政策档位云端下发）](#六版本策略建议税率政策档位云端下发)

---

## 一、架构选型判断

### 1.1 为什么当前"纯本地计算"版本不需要后端

现有代码完全符合"零后端"设计，且这正是它的优点：

- **算法是纯函数**：`miniprogram/utils/taxCalculator.js` 内所有计算函数（`progressiveTax`、`calcIncomeTax`、`calcBonus`、`calcSmeVat` 等）**无任何网络请求**，输入即输出、可离线运行、秒出结果、零成本。
- **档位是客户端常量**：`miniprogram/constants/taxRates.js` 的税率表与政策常量全部本地化，改一处全局生效。
- **不存储用户数据**：没有登录、没有云端档案，不需要服务器鉴权与数据库。

> 只要业务停留在"单机计算器"范畴，**引入后端只会增加成本、延迟和失败面，没有任何收益**。这一点要守住。

### 1.2 哪些功能才真正需要后端

| 功能需求 | 是否需要后端 | 原因 |
|---|---|---|
| **政策库云端下发** | ✅ 需要 | 政策会随年份/文号更新，写死客户端要发新版本才能改，云端下发可"改后台即全局生效" |
| **跨设备保存用户资料** | ✅ 需要 | 本地缓存只能单设备，跨设备同步必须有服务端身份 + 存储 |
| **代账服务 API 网关** | ✅ 需要 | 对接第三方代账/财税服务商，接口必须在服务端中转，保护 key、统一鉴权 |
| **表单留资采集** | ✅ 需要 | 意向客户信息（留资线索）必须落到服务端数据库，并安全导出给运营 |
| **网页版给企业主用** | ✅ 需要 | 企业主（B 端）用浏览器打开 H5/管理后台，走的是**网页域名的直连**，反而能绕开小程序备案限制（见下文方案 B） |

> 判断口诀：**只有"需要跨设备/跨版本/跨主体共享状态"的功能才需要后端**；单机可算、纯展示的功能一律留在本地。

---

## 二、未备案的应对方案

### 2.1 先说清楚硬约束（诚实版）

微信小程序 `wx.request` 的域名校验规则是**铁律**：

- 只允许 **HTTPS**；
- 请求域名必须完成 **国内 ICP 备案**；
- 未备案域名在**真机/体验版**会被微信直接拦截（`request:fail url not in domain list` 或 `fail 已配置的合法域名不匹配`），**开发者工具勾选"不校验合法域名"只能骗过本地，无法上线**。

你现有的 Cloudflare 域名**未做国内 ICP 备案**，因此：

> **结论：小程序端不能直连 `your-worker.workers.dev` 或未备案的自定义 CF 域名。** 这条路在微信侧是死的，别浪费时间配置"合法域名"。

以下是三条**真实可行**的路径，各有适用场景与取舍。

---

### 方案 A：微信云开发 / 云托管（小程序官方后端）—— 首选

**做法**：用微信官方云能力替代自建后端。在微信开发者工具里开通「云开发」，创建云函数（Node.js）承载业务逻辑，用云数据库 / 云存储存数据。

**为什么可行**：
- 微信云开发**不要求独立域名备案**，域名是微信自己的（`*.tcb.qcloud.la` / 云函数内部 `https://your-env-id.service.tcloudbase.com`），已纳入微信合法域名白名单，`wx.cloud.callFunction` / 云数据库直接可用，**无需在 `request` 合法域名里配置**。

**适用场景**：政策下发、用户资料跨设备、留资采集——**凡是"小程序端要用的后端"，都优先走这条**。

**取舍**：
- 绑定微信生态，换平台成本高；免费额度有限（超量收费）；
- 算法层 `taxCalculator.js` 是纯函数，**可以原封不动搬进云函数**，或继续在前端算，云函数只做"下发/存储"——迁移成本极低。

---

### 方案 B：仅用 CF 做"非小程序端"服务（网页版 / H5 管理后台）—— 承接你现成基建

**做法**：保持你熟悉的 **GitHub + CF Workers(Hono) + D1** 这套 factory-accounting 架构，但**明确服务对象不是小程序端**，而是：
- **企业主的网页版 / H5 管理后台**（浏览器直连 CF 自定义域名，走 DNS 解析，**网页端没有微信备案限制**）；
- **内部管理接口**（运营后台改政策、导出线索）；
- **代账服务商的外部 API 网关**（服务商后端直连你的 CF 域名，同样不受微信限制）。

**为什么可行**：微信的备案限制**只作用于小程序内的 `wx.request`**；浏览器和服务器之间的 HTTPS 请求不经过微信的域名校验。所以你的 CF 域名可以放心服务"非小程序"流量。

**适用场景**：B 端网页版（给企业主）、运营/管理后台、第三方 API 网关。**它天然是你的"冷启动正确姿势"**——先把代账业务和企业主页跑起来。

**取舍**：
- **不能解决小程序端直连问题**，小程序的存储/留资仍需方案 A 兜底；
- 但可以与方案 A 组合：CF 做"全网后端"，小程序端通过云函数中转代理（见方案 C）。

---

### 方案 C：CF Worker 只做内部 API，小程序端经微信云函数中转代理 —— 组合拳

**做法**：后端逻辑（D1 存储、政策下发、线索落库）全部放在 **CF Worker**，把 `taxCalculator.js` 算法也搬进 Worker 或云函数；微信小程序端**不直连 CF**，而是：
1. 小程序 → `wx.cloud.callFunction('proxy')`；
2. 云函数 `proxy` 在服务端 `fetch` 你的 CF Worker（服务端之间没有微信域名校验）；
3. CF Worker 处理并把结果返回给云函数，云函数透传给小程序。

```
小程序端 ──cloud.callFunction──▶ 微信云函数(proxy) ──fetch──▶ CF Worker(Hono+D1)
```

**为什么可行**：`wx.request` 域名校验只拦"小程序发出的请求"；云函数在微信的**服务端**运行，它发往 CF 的请求不受合法域名限制。等于**用云函数给 CF 套了一层小程序可用的"代理壳"**。

**适用场景**：既想保留你熟悉的 CF+D1 后端、又必须让小程序端能调用；或小程序端与网页版共用同一套 CF 后端逻辑。

**取舍**：
- 多一跳（云函数转发），延迟略增、链路更复杂，需要维护 proxy 云函数的鉴权与超时；
- 但**单一后端**：政策/线索/算法都在 CF+D1，网页版（方案 B）和小程序（方案 C）**共用一套数据库和代码**，运维成本低。

---

### 三方案对比速查

| | A 微信云开发 | B 仅 CF 非小程序端 | C CF + 云函数中转 |
|---|---|---|---|
| 小程序端可用 | ✅ 原生 | ❌ 不可直连 | ✅ 经代理 |
| 需域名备案 | 不需要 | 不需（但网页端也不被微信拦） | 不需 |
| 网页版/H5 | 一般不用它做 | ✅ 最佳 | ✅ 可用 |
| 代账 API 网关 | 一般不 | ✅ 最佳 | ✅ 最佳 |
| 保留 CF+D1 现有基建 | 放弃 | ✅ 完全保留 | ✅ 完全保留 |
| 复杂/延迟 | 低 | 低 | 中（多一跳） |
| 推荐 | 小程序端首选 | B 端/管理/网关首选 | 想共用一套后端时 |

> **落地建议（务实组合）**：
> - **第一阶段**：方案 B —— 先把"企业主网页版 / 管理后台 / 代账网关"用你现成的 CF+D1 跑起来（零备案障碍）。
> - **第二阶段**：方案 A —— 小程序端（政策下发、用户档案、留资）用微信云开发，算法层 `taxCalculator.js` 原样搬进云函数。
> - **演进到第三阶段**：若不想维护两套后端，再用方案 C 让小程序端经云函数代理连 CF+D1，统一到一套后端。

---

## 三、REST API 接口清单

> 以下接口**面向 CF Worker(Hono) 部署的后端**（即方案 B / C 的 CF 侧）。若走方案 A（微信云开发），这些接口会退化为云函数/云数据库调用，但字段与语义一致，可平替。
>
> 通用约定：
> - 基础路径前缀统一为 `/api`；
> - 统一响应封装：`{ ok: true, data: {...} }` 成功 / `{ ok: false, code, error }` 失败；
> - 时间字段存**北京时间 (UTC+8)** ISO 字符串，`created_at` 形如 `2026-11-17T07:30:00.000Z`（该串已 +8 偏移，见 factory-accounting 统一口径）。

### 3.1 `GET /api/policies` — 政策列表（支持版本号 / 时间增量拉取）

**用途**：小程序"政策库"页 / 网页端拉取政策列表；支持增量同步，减少流量。

**Query 参数**

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `category` | string | 否 | 分类过滤：`personal` 个人 / `enterprise` 企业 / `all` |
| `since_version` | integer | 否 | 增量拉取：只返回 `version > since_version` 的记录 |
| `since_updated` | string(ISO) | 否 | 增量拉取：只返回 `updated_at > since_updated` 的记录 |
| `page` / `page_size` | integer | 否 | 分页（默认 1 / 50） |

**请求示例**
```
GET /api/policies?category=enterprise&since_version=12&page=1&page_size=20
```

**响应示例**
```json
{
  "ok": true,
  "data": {
    "items": [
      {
        "id": 18,
        "category": "enterprise",
        "title": "小型微利企业年应纳税所得额减半政策",
        "summary": "对年应纳税所得额≤300万的部分，减按25%计入所得、按20%征收，实际税负5%",
        "content": "……完整政策正文 Markdown……",
        "tags": ["小微", "所得税"],
        "effective_from": "2023-01-01",
        "effective_to": "2027-12-31",
        "source": "财政部 税务总局公告",
        "version": 3,
        "updated_at": "2026-11-01T10:00:00.000Z"
      }
    ],
    "latest_version": 15,
    "page": 1,
    "page_size": 20,
    "total": 3
  }
}
```

---

### 3.2 `GET /api/policies/:id` — 单条政策详情

**用途**：政策列表页点击某条，进入详情。

**请求示例**
```
GET /api/policies/18
```

**响应示例**
```json
{
  "ok": true,
  "data": {
    "id": 18,
    "category": "enterprise",
    "title": "小型微利企业年应纳税所得额减半政策",
    "summary": "……",
    "content": "……完整政策正文 Markdown……",
    "tags": ["小微", "所得税"],
    "effective_from": "2023-01-01",
    "effective_to": "2027-12-31",
    "source": "财政部 税务总局公告",
    "version": 3,
    "updated_at": "2026-11-01T10:00:00.000Z"
  }
}
```

**失败示例**
```json
{ "ok": false, "code": "not_found", "error": "政策不存在" }
```

---

### 3.3 `POST /api/users/profile` — 保存用户测算资料（跨设备）

**用途**：用户填写/更新测算资料（收入、专项扣除、身份等），服务端按 `openid`/`user_id` 落库，实现跨设备恢复。

**身份**：`openid`（小程序登录态）或自定义 `user_id` 从请求头 `X-User-Id` 取。

**请求体示例**
```json
{
  "user_id": "oXy9z...wxid",
  "profile": {
    "identity": "employee",          // employee | individual | sme
    "monthly_income": 20000,
    "social_security": 2000,
    "monthly_deduction": 3000,
    "annual_bonus": 60000,
    "special_deductions": {
      "children_count": 1,
      "infant_count": 0,
      "elderly": true,
      "elderly_only": true,
      "housing_loan": true,
      "housing_rent_tier": -1,
      "continuing_edu": false,
      "continuing_cert": false,
      "medical_annual": 0
    }
  }
}
```

**响应示例**（UPSERT，幂等）
```json
{
  "ok": true,
  "data": {
    "user_id": "oXy9z...wxid",
    "saved_at": "2026-11-17T07:30:00.000Z",
    "updated": true
  }
}
```

---

### 3.4 `GET /api/users/profile` — 读取用户资料

**用途**：换设备登录后恢复上次保存的测算资料。

**请求示例**
```
GET /api/users/profile
X-User-Id: oXy9z...wxid
```

**响应示例**
```json
{
  "ok": true,
  "data": {
    "user_id": "oXy9z...wxid",
    "profile": {
      "identity": "employee",
      "monthly_income": 20000,
      "social_security": 2000,
      "monthly_deduction": 3000,
      "annual_bonus": 60000,
      "special_deductions": {
        "children_count": 1,
        "infant_count": 0,
        "elderly": true,
        "elderly_only": true,
        "housing_loan": true,
        "housing_rent_tier": -1,
        "continuing_edu": false,
        "continuing_cert": false,
        "medical_annual": 0
      }
    },
    "updated_at": "2026-11-17T07:30:00.000Z"
  }
}
```

**失败示例**
```json
{ "ok": false, "code": "not_found", "error": "尚未保存资料" }
```

---

### 3.5 `POST /api/leads` — 表单留资（代账服务线索）

**用途**：用户在"申报代办 / 代理记账"入口填写联系方式，作为代账服务线索落库，供运营后台/服务商对接。

**请求体示例**
```json
{
  "name": "张三",
  "phone": "13800000000",
  "city": "深圳",
  "business_type": "sme",          // employee | individual | sme
  "service": "agency_bookkeeping", // tax_filing | agency_bookkeeping | consultation
  "remark": "年利润约200万，想了解代账",
  "source": "miniapp"              // miniapp | web | ad
}
```

**响应示例**
```json
{
  "ok": true,
  "data": {
    "lead_id": 1024,
    "created_at": "2026-11-17T07:31:00.000Z",
    "status": "new"
  }
}
```

> 注意：留资含**手机号等个人信息**，建议：手机号落库前做脱敏/加密，接前端同意隐私政策；运营侧按 `status`（`new`/`contacted`/`converted`/`closed`）跟进。

---

### 3.6 `GET /api/tax-news` — 税务政策资讯（可选）

**用途**：政策库之外的"资讯/文章"流，运营在后台发布时事解读（专项扣除调整、小微新政），做内容运营与导流。

**Query 参数**

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `since_updated` | string(ISO) | 否 | 增量拉取 |
| `page` / `page_size` | integer | 否 | 分页 |

**请求示例**
```
GET /api/tax-news?page=1&page_size=10
```

**响应示例**
```json
{
  "ok": true,
  "data": {
    "items": [
      {
        "id": 32,
        "title": "2026年专项附加扣除新规解读",
        "excerpt": "……",
        "content": "……正文……",
        "cover": "https://cdn.example.com/news/32.jpg",
        "published_at": "2026-11-10T09:00:00.000Z"
      }
    ],
    "page": 1,
    "total": 1
  }
}
```

---

### 3.7 接口清单汇总表

| 方法 | 路径 | 用途 | 鉴权 | 对应表 |
|---|---|---|---|---|
| GET | `/api/policies` | 政策列表（增量/分页） | 公开 | `policies` |
| GET | `/api/policies/:id` | 单条政策详情 | 公开 | `policies` |
| POST | `/api/users/profile` | 保存/更新测算资料 | `X-User-Id` | `user_profiles` |
| GET | `/api/users/profile` | 读取测算资料 | `X-User-Id` | `user_profiles` |
| POST | `/api/leads` | 表单留资（代账线索） | 公开+限流 | `leads` |
| GET | `/api/tax-news` | 税务资讯（可选） | 公开 | `policies`(type=news) 或独立表 |

---

## 四、云数据库表结构（D1 / SQLite）

> D1 是 Cloudflare 的 **SQLite 兼容** 数据库，直接用 `CREATE TABLE` / `CREATE INDEX`，无需 `AUTO_INCREMENT` 之外的方言（D1 支持 `INTEGER PRIMARY KEY AUTOINCREMENT`）。

### 4.1 建表 SQL（完整，可直接贴进 `schema.sql`）

```sql
-- ============ 政策库 ============
CREATE TABLE IF NOT EXISTS policies (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  type           TEXT NOT NULL DEFAULT 'policy', -- policy 政策 / news 资讯
  category       TEXT NOT NULL,                  -- personal 个人 / enterprise 企业
  title          TEXT NOT NULL,                  -- 标题
  summary        TEXT DEFAULT '',                -- 摘要
  content        TEXT NOT NULL,                  -- 正文（Markdown）
  tags           TEXT DEFAULT '[]',              -- JSON 数组字符串，如 '["小微","所得税"]'
  source         TEXT DEFAULT '',                -- 出处（财政部/税务总局公告等）
  effective_from TEXT,                           -- 生效日期 YYYY-MM-DD
  effective_to   TEXT,                           -- 失效日期 YYYY-MM-DD
  version        INTEGER NOT NULL DEFAULT 1,     -- 本条当前版本号（变更+1）
  published      INTEGER NOT NULL DEFAULT 1,     -- 0 下架 / 1 发布
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_policies_cat ON policies(category, published);
CREATE INDEX IF NOT EXISTS idx_policies_ver ON policies(version);
CREATE INDEX IF NOT EXISTS idx_policies_updated ON policies(updated_at);

-- ============ 政策版本历史 ============
-- 每条政策每次变更留一个版本快照，支持"版本号增量拉取 + 历史回溯"
CREATE TABLE IF NOT EXISTS policy_versions (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  policy_id  INTEGER NOT NULL,          -- 关联 policies.id
  version    INTEGER NOT NULL,          -- 该版本的版本号
  content    TEXT NOT NULL,             -- 该版本正文快照
  summary    TEXT DEFAULT '',
  changed_at TEXT NOT NULL,             -- 该版本生效时间
  UNIQUE(policy_id, version)
);
CREATE INDEX IF NOT EXISTS idx_pv_policy ON policy_versions(policy_id, version);

-- ============ 用户测算资料（跨设备） ============
CREATE TABLE IF NOT EXISTS user_profiles (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    TEXT NOT NULL UNIQUE,      -- openid 或自定义 user_id
  profile    TEXT NOT NULL,             -- 完整测算资料 JSON
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_up_user ON user_profiles(user_id);

-- ============ 表单留资（代账服务线索） ============
CREATE TABLE IF NOT EXISTS leads (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  name          TEXT NOT NULL,
  phone         TEXT NOT NULL,          -- 建议落库前脱敏/加密
  city          TEXT DEFAULT '',
  business_type TEXT DEFAULT '',        -- employee | individual | sme
  service       TEXT DEFAULT '',        -- 需要的服务类型
  remark        TEXT DEFAULT '',
  source        TEXT DEFAULT 'miniapp', -- miniapp | web | ad
  status        TEXT NOT NULL DEFAULT 'new', -- new/contacted/converted/closed
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_leads_status ON leads(status, created_at);
CREATE INDEX IF NOT EXISTS idx_leads_phone ON leads(phone);
```

### 4.2 字段口径说明

- **`policies.content` / `user_profiles.profile` / `tags`** 均存 JSON 字符串，D1 无 JSON 列，落地用 `JSON.parse/stringify` 处理，简单场景够用。
- **`policy_versions` 与 `policies` 双表**：`policies` 存"当前最新"，`policy_versions` 存"历史快照"。更新一条政策 = 先在 `policy_versions` 插一条历史，再把 `policies.version+1` 并更新 `content`。这样 `since_version` 增量拉取可精确对齐。
- **`created_at`/`updated_at`**：统一存北京时间 (UTC+8) ISO 串（沿用 factory-accounting 的 `now()` 口径，避免凌晨跨天错位）。
- **`user_id` 唯一**：同一 `user_id` 多次 POST 走 UPSERT（`INSERT ... ON CONFLICT(user_id) DO UPDATE`）。

---

## 五、部署步骤（GitHub + CF Worker + D1）

> 完全照 factory-accounting 的成熟模式：**GitHub 管代码 + CF Workers(Hono) 做后端 + D1 数据库**，外加 CI 自动部署。适用于方案 B / C 的 CF 侧后端。

### 第 1 步：GitHub 初始化

```bash
cd /workspace/tax-miniapp
git init
git add -A
git commit -m "tax-miniapp: 初始化（前端原型 + 后端骨架）"
# 在 GitHub 网页建一个私有仓库 tax-miniapp 后：
git remote add origin https://github.com/<你的账号>/tax-miniapp.git
git push -u origin main
```

> 若本机代理导致 TLS 报错，参考 factory-accounting 的 DEPLOYMENT.md：`env -u http_proxy -u https_proxy -u HTTP_PROXY -u HTTPS_PROXY git -c http.proxy= -c https.proxy= push origin main`

### 第 2 步：准备 Hono Worker 后端（新建 `tax-miniapp/backend/`）

参照 factory-accounting 结构：

```
tax-miniapp/
├── backend/
│   ├── index.js          # Hono 应用，含上文所有 /api 路由
│   ├── schema.sql        # 第四节的建表 SQL
│   ├── wrangler.toml
│   ├── package.json      # dependencies: hono
│   └── package-lock.json
└── miniprogram/          # 现有前端（不动）
```

`backend/package.json`：
```json
{
  "name": "tax-miniapp-backend",
  "scripts": { "deploy": "wrangler deploy" },
  "dependencies": { "hono": "^4.0.0" }
}
```

`backend/wrangler.toml`（D1 绑定）：
```toml
name = "tax-miniapp-api"
main = "index.js"
compatibility_date = "2024-11-01"

[[d1_databases]]
binding = "DB"
database_name = "tax-db"
database_id = "<D1 数据库 ID，第3步创建后回填>"
```

### 第 3 步：Cloudflare 创建 Worker + D1 数据库

1. 登录 CF 控制台 → **Workers & Pages** → **Create** → 新建 **Worker**，命名 `tax-miniapp-api`。
2. 进入该 Worker → **Settings → Bindings** → **D1 Database** → **Create**，命名 `tax-db`。
3. 把生成的 `database_id` 回填进 `wrangler.toml` 的 `database_id`。
4. **执行建表**（两种方式任选）：
   - 控制台：Worker → **D1** → 选 `tax-db` → **Console**，把 `schema.sql` 内容贴进去执行；或
   - 命令行：`npx wrangler d1 execute tax-db --file=./schema.sql --remote`
5. 写 `backend/index.js` 的 Hono 路由（含上述 6 个接口），用 `c.env.DB.prepare(...).bind(...).run()/first()/all()` 访问 D1。

### 第 4 步：绑定自定义域名（或直接走网页版）

- **网页版 / 管理后台 / 代账网关**（方案 B）：Worker → **Settings → Domains & Routes** → 绑定你的 CF 自定义域名（如 `api.example.com`），走 CF 代理解析即可。**网页端没有微信备案限制，可立即用。**
- 若**暂不绑域名**：直接用默认 `tax-miniapp-api.<你的账号>.workers.dev` 给浏览器/服务商调用也够用。

> ⚠️ 提醒：这个自定义域名**仍未备案**，所以**不能**配进小程序 `request` 合法域名。要供小程序端调用，走**方案 A 云开发**或**方案 C 云函数中转**（见第 6 步）。

### 第 5 步：CI 自动部署（GitHub Actions）

在仓库建 `.github/workflows/deploy.yml`（照 factory-accounting）：

```yaml
name: Deploy Cloudflare Worker
on:
  push:
    branches: [main]
    paths: ['backend/**']
jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: npm
          cache-dependency-path: backend/package-lock.json
      - name: 安装依赖
        run: npm ci
        working-directory: backend
      - name: 部署到 Cloudflare
        run: npx wrangler deploy
        working-directory: backend
        env:
          CLOUDFLARE_API_TOKEN: ${{ secrets.CF_API_TOKEN }}
          CLOUDFLARE_ACCOUNT_ID: <你的 CF 账号 ID>
```

在 GitHub 仓库 **Settings → Secrets → Actions** 添加 `CF_API_TOKEN`（需 Worker 编辑 + D1 权限的 token）。

### 第 6 步：微信小程序端（方案 A 或 C）

- **方案 A（推荐，简单）**：微信开发者工具 → **云开发**开通 → 建云函数 `policies`/`profile`/`lead`，把 `taxCalculator.js` 原样放一份进云函数（或继续前端算），政策/资料/留资改走 `wx.cloud.callFunction`。**无需配 request 合法域名。**
- **方案 C（共用 CF 后端）**：建云函数 `proxy`，内部 `await fetch('https://tax-miniapp-api.<账号>.workers.dev/api/policies')` 并透传结果；小程序端 `wx.cloud.callFunction({ name:'proxy', data:{ path:'/api/policies' } })`。

> 无论 A 还是 C，都要在开发者工具里真机预览验证（勾选"不校验合法域名"只能骗过本地，上线前务必核对）。

---

## 六、版本策略建议（税率/政策档位云端下发）

目标：把 `miniprogram/constants/taxRates.js` 的"写死档位"迁移为"云端下发 + 本地缓存 + 版本号"，做到**改后台即全局生效、无需发版**，同时保留离线兜底。

### 6.1 三个关键原则

1. **算法不动、数据动**：`taxCalculator.js` 的算法函数全是"数据驱动"（`progressiveTax(taxable, rateTable)` 接受 rateTable 参数），**只要把 rateTable 从"常量"换成"云端取来的表"即可，算法零改动**。
2. **本地兜底**：缓存一份内置常量作为默认值，云端没拉到/拉失败时用默认档位，**保证离线与弱网可用**。
3. **版本号增量**：客户端带 `since_version` 拉取，只同步变更的档位，减少流量。

### 6.2 最小改造方案（分三步）

**① 把税率表抽成"可被云端覆盖的配置"**

新增 `miniprogram/utils/taxConfig.js`，导出一个统一的配置加载器：

```js
// utils/taxConfig.js —— 税率/政策配置加载器（本地兜底 + 云端覆盖 + 版本缓存）
const LOCAL = require('../constants/taxRates'); // 保留现有常量作离线兜底

let remote = null;          // 云端拉到的覆盖配置
let cacheVersion = 0;       // 当前生效版本号
const STORAGE_KEY = 'tax_config_v';

// 读取某套档位：有云端覆盖用云端，否则用本地兜底
function getConfig() {
  return remote || LOCAL;
}

// 启动时从本地缓存恢复（秒开）
function loadFromCache() {
  const cached = wx.getStorageSync(STORAGE_KEY);
  if (cached && cached.version > cacheVersion) {
    remote = cached.config;
    cacheVersion = cached.version;
  }
}

// 从云端增量拉取（>= since_version 才覆盖）
async function syncFromServer() {
  const since = cacheVersion;
  const res = await wx.request({
    url: `${API_BASE}/api/policies?category=tax_rates&since_version=${since}`,
    method: 'GET'
  });
  if (res.data && res.data.ok) {
    const { items, latest_version } = res.data.data;
    // 把云端的 tax_rates 档位 merge 进 remote
    remote = { ...LOCAL, ...(items[0] && items[0].content) };
    cacheVersion = Math.max(cacheVersion, latest_version);
    wx.setStorageSync(STORAGE_KEY, { config: remote, version: cacheVersion });
  }
}

module.exports = { getConfig, loadFromCache, syncFromServer };
```

> 说明：`/api/policies` 里加一条 `category='tax_rates'` 的"伪政策"记录，`content` 存整份税率配置 JSON（就是 `taxRates.js` 的结构，`COMPREHENSIVE_RATES`/`BONUS_RATES`/`SPECIAL_DEDUCTIONS`/`SME_POLICY` 等）。云端更新这条记录 → `version+1` → 客户端下次同步即覆盖。

**② 改造 `taxCalculator.js` 取数方式**

把 `const R = require('../constants/taxRates')` 换成走配置加载器，尽量少动算法主体：

```js
// taxCalculator.js —— 只改取数来源，算法逻辑不动
const { getConfig } = require('./taxConfig');
const R = getConfig();   // 云端覆盖优先，本地兜底
```

> 由于 `taxCalculator.js` 已经用 `R.COMPREHENSIVE_RATES` 这类"数据驱动"写法，只要 `R` 变成云端合并后的对象，**其余所有计算函数一行都不用改**。

**③ 在 `app.js` 里编排"先本地秒开 → 再静默同步"**

```js
// app.js
const taxConfig = require('./utils/taxConfig');
App({
  onLaunch() {
    taxConfig.loadFromCache();      // 先本地缓存，秒开可算
    taxConfig.syncFromServer().catch(() => {}); // 后台静默同步，拉到即覆盖
  }
});
```

### 6.3 为什么这样最稳

- **回滚安全**：云端只增版本号、可随时回退，客户端按版本增量对账；
- **离线兜底**：拉不到时用内置 `taxRates.js`，用户体验不断档；
- **零算法风险**：算法是"数据驱动"的，换数据源不换逻辑，可在单元测试里喂不同版本档位验证；
- **渐进式**：第一版先让 `syncFromServer` 跑通、客户端仍默认本地档位；验证无误后，再让云端配置"优先生效"。

---

> 附：本文档接口字段与建表 SQL 已在第 3、4 节给出可直接落地的 JSON / SQL；部署步骤照 factory-accounting 模式，第 2 节对"未备案"约束给出诚实且可落地的 A/B/C 三路径。落地时以 `docs/backend-plan.md` 为本，先做方案 B（CF 网页/管理端），再补方案 A（小程序云开发）。