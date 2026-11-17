// functions/api/policy.js —— Cloudflare Pages Function
// 作用：代理拉取 GitHub 上的最新政策 JSON，并缓存 1 小时。
// 前端同域请求 /api/policy，无需 CORS、无需备案、在国内更稳定（由 CF 边缘节点访问 GitHub）。

const GH_RAW = 'https://raw.githubusercontent.com/tel9980/tax-miniapp/main/data/policies.json';
const GH_CDN = 'https://cdn.jsdelivr.net/gh/tel9980/tax-miniapp@main/data/policies.json';

export async function onRequestGet(context) {
  // 命中缓存直接返回
  const cache = caches.default;
  const cacheKey = new Request(context.request.url, { method: 'GET' });
  const cached = await cache.match(cacheKey);
  if (cached) return cached;

  // 依次尝试两个 GitHub 源
  let resp = null;
  let data = null;
  for (const url of [GH_RAW, GH_CDN]) {
    try {
      resp = await fetch(url, { cf: { cacheTtl: 3600 }, headers: { 'user-agent': 'cf-pages-tax-miniapp' } });
      if (!resp.ok) continue;
      data = await resp.json();
      break;
    } catch (e) {
      continue;
    }
  }

  if (!data) {
    return new Response(JSON.stringify({ error: 'policy source unavailable' }), {
      status: 502,
      headers: { 'content-type': 'application/json' }
    });
  }

  const res = new Response(JSON.stringify(data), {
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'public, max-age=3600',
      'access-control-allow-origin': '*'
    }
  });

  // 后台写缓存（边缘缓存，跨用户共享）
  context.waitUntil(cache.put(cacheKey, res.clone()));
  return res;
}
