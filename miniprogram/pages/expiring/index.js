const api = require('../../utils/api');

Page({
  data: {
    loading: true,
    error: '',
    quarter: '',
    start: '',
    end: '',
    count: 0,
    items: [],
    watch: null,
    updatedAtShort: ''
  },

  onLoad() {
    this.load();
  },

  async load() {
    this.setData({ loading: true, error: '' });
    // 跟踪清单是附加信息，失败不影响到期列表
    api.getWatch().then((w) => this.setData({ watch: w })).catch(() => {});
    try {
      const d = await api.getExpiring();
      this.apply(d);
    } catch (e) {
      this.setData({ loading: false, error: '加载失败，请下拉重试' });
    }
  },

  apply(d) {
    // 给每条算一个「还剩 N 天」，让紧迫感直接写出来
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const items = (d.items || []).map((p) => {
      let left = '';
      const t = Date.parse(p.expiry || '');
      if (Number.isFinite(t)) {
        const days = Math.round((t - today.getTime()) / 86400000);
        left = days >= 0 ? '还剩 ' + days + ' 天' : '已过期 ' + Math.abs(days) + ' 天';
      }
      const docLabel = p.docNo || (p.docType === 'law' ? '法律法规' : p.docType === 'qa' ? '政策解读' : '');
      return { ...p, left, docLabel };
    });
    this.setData({
      loading: false,
      error: '',
      quarter: d.quarter || '',
      start: d.start || '',
      end: d.end || '',
      count: d.count || items.length,
      items,
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

  openItem(e) {
    const id = e.currentTarget.dataset.id;
    if (!id) return;
    wx.navigateTo({ url: '/pages/detail/detail?id=' + encodeURIComponent(id) });
  },

  onPullDownRefresh() {
    this.load().then(() => {
      wx.stopPullDownRefresh();
      wx.showToast({ title: '已更新', icon: 'success' });
    }).catch(() => wx.stopPullDownRefresh());
  }
});
