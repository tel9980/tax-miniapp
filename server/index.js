// 在普通 Node 服务器（阿里云轻量 / ECS / 任意 VPS）上跑同一套 Worker 代码。
// 目标：worker/index.js 一行不改，只把 Cloudflare 提供的两个能力本地化——
//   env.POLICIES（KV）→ 本地 JSON 文件
//   env.ASSETS（静态资源）→ 本地 web/ 目录
// 启动：node server/index.js      默认端口 8787（可用 PORT 环境变量改）

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import worker from '../worker/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'data');
const KV_FILE = path.join(DATA_DIR, 'kv.json');
const WEB_DIR = path.join(ROOT, 'web');
const PORT = Number(process.env.PORT || 8787);
const DAILY_HOUR = Number(process.env.DAILY_HOUR || 9); // 每天几点抓取（默认 9 点）

fs.mkdirSync(DATA_DIR, { recursive: true });

// ===== 用本地 JSON 文件模拟 Cloudflare KV =====
let store = {};
try {
  store = JSON.parse(fs.readFileSync(KV_FILE, 'utf8'));
  console.log(`[kv] 已加载缓存 ${Object.keys(store).length} 个键`);
} catch {
  store = {};
  console.log('[kv] 没有缓存文件，首次访问会现场抓取');
}

let timer = null;
function flush() {
  clearTimeout(timer);
  timer = setTimeout(() => {
    try {
      fs.writeFileSync(KV_FILE + '.tmp', JSON.stringify(store));
      fs.renameSync(KV_FILE + '.tmp', KV_FILE);
    } catch (e) {
      console.error('[kv] 落盘失败:', e.message);
    }
  }, 200);
}

const POLICIES = {
  async get(key, type) {
    const v = store[key];
    if (v == null) return null;
    return type === 'json' ? JSON.parse(v) : v;
  },
  async put(key, value) {
    store[key] = typeof value === 'string' ? value : JSON.stringify(value);
    flush();
  },
  async delete(key) {
    delete store[key];
    flush();
  },
};

// ===== 静态资源（等价于 Cloudflare Workers Static Assets）=====
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
};

const ASSETS = {
  async fetch(request) {
    const url = new URL(request.url);
    let rel = decodeURIComponent(url.pathname);
    if (rel.endsWith('/')) rel += 'index.html';
    let file = path.resolve(WEB_DIR, '.' + rel);
    // 防目录穿越
    if (!file.startsWith(WEB_DIR)) return new Response('403', { status: 403 });
    if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      // 单页应用：找不到就回 index.html
      file = path.join(WEB_DIR, 'index.html');
      if (!fs.existsSync(file)) return new Response('404 Not Found', { status: 404 });
    }
    const body = fs.readFileSync(file);
    return new Response(body, {
      status: 200,
      headers: {
        'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
        'Cache-Control': rel.startsWith('/api') ? 'no-store' : 'public, max-age=300',
      },
    });
  },
};

const env = { POLICIES, ASSETS };
const ctx = { waitUntil(p) { Promise.resolve(p).catch(() => {}); } };

// ===== HTTP 服务 =====
const server = http.createServer(async (req, res) => {
  try {
    const host = req.headers.host || `localhost:${PORT}`;
    const request = new Request(`http://${host}${req.url}`, {
      method: req.method,
      headers: {
        'user-agent': req.headers['user-agent'] || 'node-server',
        accept: req.headers.accept || '*/*',
      },
    });
    const response = await worker.fetch(request, env, ctx);
    const headers = {};
    response.headers.forEach((v, k) => { headers[k] = v; });
    res.writeHead(response.status, headers);
    res.end(Buffer.from(await response.arrayBuffer()));
  } catch (e) {
    console.error('[error]', e?.stack || e);
    res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('服务器错误：' + (e?.message || e));
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[server] 已启动 http://0.0.0.0:${PORT}`);
  console.log(`[server] 数据缓存 ${KV_FILE}`);
  console.log(`[server] 每天 ${DAILY_HOUR}:00 自动抓取（也可手动 curl /api/refresh）`);
  scheduleDaily();
});

// ===== 每天定时抓取（等价于 Cloudflare cron "0 1 * * *"）=====
function scheduleDaily() {
  const now = new Date();
  const next = new Date(now);
  next.setHours(DAILY_HOUR, 0, 0, 0);
  if (next <= now) next.setDate(next.getDate() + 1);
  const wait = next - now;
  console.log(`[cron] 下次抓取：${next.toLocaleString('zh-CN')}（${Math.round(wait / 60000)} 分钟后）`);
  setTimeout(async () => {
    try {
      await worker.scheduled({}, env, ctx);
    } catch (e) {
      console.error('[cron] 抓取失败:', e?.message || e);
    } finally {
      scheduleDaily();
    }
  }, wait);
}

process.on('SIGTERM', () => {
  console.log('[server] 收到 SIGTERM，保存缓存后退出');
  try {
    fs.writeFileSync(KV_FILE, JSON.stringify(store));
  } catch (e) {
    console.error('[kv] 退出时落盘失败:', e.message);
  }
  process.exit(0);
});
