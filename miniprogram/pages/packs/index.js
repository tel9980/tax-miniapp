const api = require('../../utils/api');

Page({
  data: {
    loading: true,
    error: '',
    packs: [],
    openId: '',      // 当前展开的包 id，空 = 全部折叠
    updatedAtShort: ''
  },

  onLoad() {
    this.load();
  },

  async load() {
    const cached = getApp().globalData.packs;
    if (cached && cached.packs) {
      this.apply(cached);
      return;
    }
    this.setData({ loading: true, error: '' });
    try {
      const d = await api.getPacks();
      getApp().globalData.packs = d;
      this.apply(d);
    } catch (e) {
      const c = wx.getStorageSync('packs');
      if (c && c.data) this.apply(c.data);
      else this.setData({ loading: false, error: '加载失败，请下拉重试' });
    }
  },

  apply(d) {
    this.setData({
      loading: false,
      error: '',
      packs: (d.packs || []).map((pk) => ({
        ...pk,
        items: (pk.items || []).map((p) => ({
          ...p,
          docLabel: p.docNo || (p.docType === 'law' ? '法律法规' : p.docType === 'qa' ? '政策解读' : '')
        }))
      })),
      updatedAtShort: this.fmtTime(d.updatedAt)
    });
  },

  fmtTime(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    const p = (n) => (n < 10 ? '0' + n : '' + n);
    return `${d.getMonth() + 1}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  },

  // 点包标题展开 / 收起
  togglePack(e) {
    const id = e.currentTarget.dataset.id;
    this.setData({ openId: this.data.openId === id ? '' : id });
  },

  // 点条目进详情
  openItem(e) {
    const id = e.currentTarget.dataset.id;
    if (!id) return;
    wx.navigateTo({ url: '/pages/detail/detail?id=' + encodeURIComponent(id) });
  },

  onPullDownRefresh() {
    getApp().globalData.packs = null;
    this.load().then(() => {
      wx.stopPullDownRefresh();
      wx.showToast({ title: '已更新', icon: 'success' });
    }).catch(() => wx.stopPullDownRefresh());
  }
});
