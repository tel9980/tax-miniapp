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
    // 用 allSettled：任何一个接口挂了不影响其它三个（原先 Promise.all 是一损俱损）
    const tasks = [
      ['policies', api.getPolicies],
      ['vat', api.getVatContinuity],
      ['cit', api.getCitContinuity],
      ['iit', api.getIitContinuity]
    ];
    const results = await Promise.allSettled(tasks.map((t) => t[1]()));
    let ok = 0;
    results.forEach((r, i) => {
      const key = tasks[i][0];
      if (r.status === 'fulfilled' && r.value) {
        this.globalData[key] = r.value;
        this._saveCache(key, r.value);
        ok++;
      } else {
        console.warn('[app] 预加载失败 ' + key + ': ' + ((r.reason && r.reason.message) || '未知'));
      }
    });
    console.log('[app] 预加载完成 ' + ok + '/4');
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
