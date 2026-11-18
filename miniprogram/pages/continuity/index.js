const api = require('../../utils/api');

Page({
  data: {
    tab: 'vat',
    loading: true,
    error: '',
    vatLaw: null,
    citLaw: null,
    vatGrouped: [],
    citGrouped: [],
    vatTotal: 0,
    citTotal: 0
  },

  onLoad() {
    this.init();
  },

  async init() {
    const app = getApp();
    const vat = app.globalData.vat;
    const cit = app.globalData.cit;
    if (vat && cit) {
      this.applyData(vat, cit);
      return;
    }
    this.setData({ loading: true, error: '' });
    try {
      const [v, c] = await Promise.all([api.getVatContinuity(), api.getCitContinuity()]);
      app.globalData.vat = v;
      app.globalData.cit = c;
      this.applyData(v, c);
    } catch (e) {
      const vc = wx.getStorageSync('vat');
      const cc = wx.getStorageSync('cit');
      if (vc && vc.data && cc && cc.data) {
        this.applyData(vc.data, cc.data);
      } else {
        this.setData({ loading: false, error: '加载失败，请稍后重试' });
      }
    }
  },

  applyData(vat, cit) {
    this.setData({
      loading: false,
      error: '',
      vatLaw: vat.law || null,
      citLaw: cit.law || null,
      vatGrouped: this.groupBy(vat.items || [], vat.groups || []),
      citGrouped: this.groupBy(cit.items || [], cit.groups || []),
      vatTotal: vat.total || 0,
      citTotal: cit.total || 0
    });
  },

  groupBy(items, groups) {
    return groups
      .map((g) => ({ name: g, items: items.filter((it) => it.g === g) }))
      .filter((grp) => grp.items.length > 0);
  },

  switchTab(e) {
    this.setData({ tab: e.currentTarget.dataset.tab });
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
