const api = require('../../utils/api');

// 三张对照表共用一套渲染：切换 tab 只换 current，不重复写三份 WXML
const TABS = [
  { k: 'vat', n: '增值税衔接表' },
  { k: 'cit', n: '所得税到期地图' },
  { k: 'iit', n: '个税到期地图' }
];

Page({
  data: {
    tab: 'vat',
    tabs: TABS,
    loading: true,
    error: '',
    current: null, // { law, grouped }
    total: 0
  },

  onLoad() {
    this.store = {};
    this.init();
  },

  async init() {
    const app = getApp();
    const g = app.globalData;
    if (g.vat && g.cit && g.iit) {
      this.applyAll({ vat: g.vat, cit: g.cit, iit: g.iit });
      return;
    }
    this.setData({ loading: true, error: '' });
    try {
      const [v, c, i] = await Promise.all([
        api.getVatContinuity(),
        api.getCitContinuity(),
        api.getIitContinuity()
      ]);
      g.vat = v; g.cit = c; g.iit = i;
      this.applyAll({ vat: v, cit: c, iit: i });
    } catch (e) {
      const cache = {};
      let ok = true;
      TABS.forEach((t) => {
        const c = wx.getStorageSync(t.k);
        if (c && c.data) cache[t.k] = c.data;
        else ok = false;
      });
      if (ok) this.applyAll(cache);
      else this.setData({ loading: false, error: '加载失败，请稍后重试' });
    }
  },

  applyAll(byKey) {
    TABS.forEach((t) => {
      const d = byKey[t.k] || {};
      this.store[t.k] = {
        law: d.law || null,
        grouped: this.groupBy(d.items || [], d.groups || []),
        total: (d.items || []).length
      };
    });
    this.showTab(this.data.tab);
  },

  groupBy(items, groups) {
    return groups
      .map((g) => ({ name: g, items: items.filter((it) => it.g === g) }))
      .filter((grp) => grp.items.length > 0);
  },

  showTab(k) {
    const s = this.store[k];
    if (!s) return;
    this.setData({
      tab: k,
      loading: false,
      error: '',
      current: { law: s.law, grouped: s.grouped },
      total: s.total
    });
  },

  switchTab(e) {
    this.showTab(e.currentTarget.dataset.tab);
  },

  openUrl(e) {
    const url = e.currentTarget.dataset.url;
    if (!url) return;
    wx.setClipboardData({
      data: url,
      success: () => wx.showToast({ title: '原文链接已复制，去浏览器粘贴', icon: 'none' })
    });
  }
});
