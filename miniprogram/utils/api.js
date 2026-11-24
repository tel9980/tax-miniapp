const { API_BASE } = require('../config');

function request(path, method = 'GET') {
  return new Promise((resolve, reject) => {
    wx.request({
      url: API_BASE + path,
      method,
      timeout: 30000,
      success(res) {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve(res.data);
        } else {
          console.warn('[api] ' + path + ' → HTTP ' + res.statusCode);
          reject(new Error('HTTP ' + res.statusCode));
        }
      },
      fail(err) {
        const msg = (err && err.errMsg) || '网络错误';
        console.warn('[api] ' + path + ' → ' + msg);
        reject(new Error(msg));
      }
    });
  });
}

// 把筛选条件 + 页码拼成查询串。空值不传，减少 URL 长度。
function buildQuery(obj) {
  const parts = [];
  Object.keys(obj || {}).forEach((k) => {
    const v = obj[k];
    if (v === undefined || v === null || v === '' || v === false) return;
    parts.push(encodeURIComponent(k) + '=' + encodeURIComponent(v === true ? 1 : v));
  });
  return parts.length ? '?' + parts.join('&') : '';
}

module.exports = {
  API_BASE,
  getPolicies: () => request('/api/policies?all=1'),
  // 服务端分页：首屏只拉 40 条（约 19KB），翻页再拉，避免一次塞 190KB
  getPoliciesPage: (params) => request('/api/policies' + buildQuery(params)),
  // 按身份打包（小微企业 / 高新研发 / 个体户 / 打工人）
  getPacks: () => request('/api/packs'),
  // 本季度到期的政策清单
  getExpiring: () => request('/api/expiring'),
  // 等官方发文的待跟踪清单（横琴/南沙延续等）
  getWatch: () => request('/api/watch'),
  getVatContinuity: () => request('/api/vat-continuity'),
  getCitContinuity: () => request('/api/cit-continuity'),
  getIitContinuity: () => request('/api/iit-continuity'),
  getDetail: (id) => request('/api/detail?id=' + encodeURIComponent(id)),
  getDetailByUrl: (url, title) => request('/api/detail?url=' + encodeURIComponent(url)
    + (title ? '&title=' + encodeURIComponent(title) : '')),
  refresh: () => request('/api/refresh')
};
