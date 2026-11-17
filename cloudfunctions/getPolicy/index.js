// cloudfunctions/getPolicy/index.js —— 云函数：从 GitHub 拉取最新税收政策 JSON
// 为什么需要云函数中转：微信小程序客户端直连 GitHub 域名会被「未备案」拦截，
// 而云函数运行在微信服务器端，不受小程序域名白名单/备案限制，可直连 GitHub。

const https = require('https');

// 政策数据源（GitHub 仓库公开 raw 地址）
const GITHUB_RAW_URL = 'https://raw.githubusercontent.com/tel9980/tax-miniapp/main/data/policies.json';

// 简单 GET 请求（支持一次重定向）
function fetchJson(url, redirectCount) {
  redirectCount = redirectCount || 0;
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'user-agent': 'tax-miniapp-sync' } }, (res) => {
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
    }).on('error', reject);
  });
}

// 云函数入口
exports.main = async () => {
  try {
    const raw = await fetchJson(GITHUB_RAW_URL);
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