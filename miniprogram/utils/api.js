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
          reject(new Error('HTTP ' + res.statusCode));
        }
      },
      fail(err) {
        reject(new Error((err && err.errMsg) || '网络错误'));
      }
    });
  });
}

module.exports = {
  API_BASE,
  getPolicies: () => request('/api/policies'),
  getVatContinuity: () => request('/api/vat-continuity'),
  getCitContinuity: () => request('/api/cit-continuity'),
  getIitContinuity: () => request('/api/iit-continuity'),
  getDetail: (id) => request('/api/detail?id=' + encodeURIComponent(id)),
  refresh: () => request('/api/refresh')
};
