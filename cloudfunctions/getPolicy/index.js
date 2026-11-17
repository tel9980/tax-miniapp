// cloudfunctions/getPolicy/index.js —— 云函数：从 GitHub 拉取最新税收政策 JSON
// 为什么需要云函数中转：微信小程序客户端直连 GitHub 域名会被「未备案」拦截，
// 而云函数运行在微信服务器端，不受小程序域名白名单/备案限制，可直连 GitHub。

const https = require('https');

// 政策数据源（多源 fallback，国内云函数环境 raw 不稳时自动切 jsDelivr CDN）
// 数据源头仍是 GitHub 仓库 data/policies.json，jsDelivr 只是它的 CDN 镜像。
const SOURCES = [
  'https://raw.githubusercontent.com/tel9980/tax-miniapp/main/data/policies.json',
  'https://cdn.jsdelivr.net/gh/tel9980/tax-miniapp@main/data/policies.json'
];

// 简单 GET 请求（支持重定向）
function fetchJson(url, redirectCount) {
  redirectCount = redirectCount || 0;
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'user-agent': 'tax-miniapp-sync' }, timeout: 8000 }, (res) => {
      // 处理 301/302 重定向
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        if (redirectCount >= 3) {
          reject(new Error('重定向次数过多'));
          return;
        }
        resolve(fetchJson(res.headers.location, redirectCount + 1));
        return;
      }
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error('HTTP ' + res.statusCode));
        return;
      }
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        try {
          resolve(JSON.parse(body));
        } catch (e) {
          reject(new Error('JSON 解析失败'));
        }
      });
    });
    req.on('timeout', () => { req.destroy(new Error('请求超时')); });
    req.on('error', reject);
  });
}

// 依次尝试多个数据源，全部失败才返回错误
async function fetchFromSources() {
  let lastErr = null;
  for (const url of SOURCES) {
    try {
      return await fetchJson(url);
    } catch (e) {
      lastErr = e;
      // 继续尝试下一个源
    }
  }
  throw lastErr || new Error('所有数据源均失败');
}

// 云函数入口
exports.main = async () => {
  try {
    const raw = await fetchFromSources();
    // 兼容两种结构：{ policy: {...} } 或 直接平铺
    const policyData = raw.policy || raw;
    return {
      ok: true,
      version: raw.version || null,
      updatedAt: raw.updatedAt || null,
      data: policyData
    };
  } catch (e) {
    return {
      ok: false,
      error: String((e && e.message) || e)
    };
  }
};