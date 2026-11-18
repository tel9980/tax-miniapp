const api = require('./utils/api');

App({
  globalData: {
    policies: null, // { items, total, preferenceCount, ... }
    vat: null,      // { law, groups, items }
    cit: null,      // { law, groups, items }
    iit: null       // { law, groups, items }
  },

  onLaunch() {
    // 启动时：先读本地缓存秒出，后台再静默拉最新
    this._loadCache();
    this.prefetch();
  },

  async prefetch() {
    try {
      const [p, v, c, i] = await Promise.all([
        api.getPolicies(),
        api.getVatContinuity(),
        api.getCitContinuity(),
        api.getIitContinuity()
      ]);
      this.globalData.policies = p;
      this.globalData.vat = v;
      this.globalData.cit = c;
      this.globalData.iit = i;
      this._saveCache('policies', p);
      this._saveCache('vat', v);
      this._saveCache('cit', c);
      this._saveCache('iit', i);
    } catch (e) {
      // 静默失败，缓存兜底（_loadCache 已处理）
    }
  },

  _loadCache() {
    ['policies', 'vat', 'cit', 'iit'].forEach((key) => {
      if (!this.globalData[key]) {
        const c = wx.getStorageSync(key);
        if (c && c.data) this.globalData[key] = c.data;
      }
    });
  },

  _saveCache(key, data) {
    try {
      wx.setStorageSync(key, { data, t: Date.now() });
    } catch (e) {
      // 存储失败忽略
    }
  }
});
