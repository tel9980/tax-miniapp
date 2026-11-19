const api = require('../../utils/api');

const PAGE_SIZE = 30;
const FAV_KEY = 'tax-favs';
const STATUS_OPTIONS = ['全部', '生效中', '即将到期', '已到期', '未标注'];

Page({
  data: {
    loading: true,
    error: '',
    all: [],
    filtered: [],
    visible: [],
    shown: PAGE_SIZE,
    hasMore: false,

    // 筛选状态
    q: '',
    prefOnly: false,
    tax: '全部',
    type: '全部',
    location: '全部',
    status: '全部',
    favOnly: false,
    favCount: 0,

    // 选项
    taxOptions: ['全部'],
    typeOptions: ['全部'],
    locationOptions: ['全部'],
    statusOptions: STATUS_OPTIONS,

    // 统计
    total: 0,
    prefCount: 0,
    updatedAtShort: ''
  },

  onLoad() {
    console.log('[policies] onLoad');
    try {
      let favs = [];
      try { favs = wx.getStorageSync(FAV_KEY) || []; } catch (e) {}
      // 防御：缓存里若不是数组，new Set() 会抛 "is not iterable"，整页 onLoad 中断
      this.favs = new Set(Array.isArray(favs) ? favs : []);
      this.setData({ favCount: this.favs.size });
      this.init();
    } catch (e) {
      console.error('[policies] onLoad 异常', e);
      this.setData({ loading: false, error: '页面初始化失败：' + ((e && e.message) || e) });
    }
  },

  // 收藏持久化
  saveFavs() {
    try { wx.setStorageSync(FAV_KEY, [...this.favs]); } catch (e) {}
    this.setData({ favCount: this.favs.size });
  },

  // 点星标：catchtap 阻止冒泡，避免触发卡片跳转
  toggleFav(e) {
    const id = e.currentTarget.dataset.id;
    if (!id) return;
    if (this.favs.has(id)) this.favs.delete(id); else this.favs.add(id);
    this.saveFavs();
    this.applyFilter();
    wx.showToast({ title: this.favs.has(id) ? '已收藏' : '已取消', icon: 'none', duration: 800 });
  },

  toggleFavOnly() {
    this.setData({ favOnly: !this.data.favOnly });
    this.applyFilter();
  },

  async init() {
    const cached = getApp().globalData.policies;
    if (cached) {
      this.applyData(cached);
      return;
    }
    this.setData({ loading: true, error: '' });
    try {
      const data = await api.getPolicies();
      getApp().globalData.policies = data;
      this.applyData(data);
    } catch (e) {
      const c = wx.getStorageSync('policies');
      if (c && c.data) {
        this.applyData(c.data);
      } else {
        this.setData({ loading: false, error: '加载失败，请下拉重试' });
      }
    }
  },

  applyData(data) {
    const items = data.items || [];
    const taxSet = [];
    items.forEach((p) => (p.taxTypes || []).forEach((t) => { if (taxSet.indexOf(t) < 0) taxSet.push(t); }));
    const typeSet = [];
    items.forEach((p) => { if (p.isPreference && p.prefType && typeSet.indexOf(p.prefType) < 0) typeSet.push(p.prefType); });
    const locationOptions = ['全部', '全国', '广东'].concat(data.areas || []);

    this.setData({
      loading: false,
      error: '',
      all: items,
      total: data.total || items.length,
      prefCount: data.preferenceCount || 0,
      updatedAtShort: this.fmtTime(data.updatedAt),
      taxOptions: ['全部'].concat(taxSet),
      typeOptions: ['全部'].concat(typeSet),
      locationOptions
    });
    this.applyFilter();
  },

  fmtTime(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    const p = (n) => (n < 10 ? '0' + n : '' + n);
    return `${d.getMonth() + 1}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  },

  applyFilter() {
    const { all, q, prefOnly, tax, type, location, status, favOnly } = this.data;
    const ql = q.trim().toLowerCase();
    const favs = this.favs || new Set();
    let filtered = all.filter((p) => {
      if (favOnly && !favs.has(p.id)) return false;
      if (prefOnly && !p.isPreference) return false;
      if (tax !== '全部' && (p.taxTypes || []).indexOf(tax) < 0) return false;
      if (type !== '全部' && p.prefType !== type) return false;
      if (location !== '全部') {
        if (location === '全国' || location === '广东') {
          if (p.region !== location) return false;
        } else if (p.area !== location) {
          return false;
        }
      }
      if (status !== '全部' && p.status !== status) return false;
      if (ql) {
        const hay = `${p.title || ''} ${p.docNo || ''} ${p.plain || ''}`.toLowerCase();
        if (hay.indexOf(ql) < 0) return false;
      }
      return true;
    });
    // 优惠优先，再按日期倒序
    filtered.sort((a, b) => {
      const pa = a.isPreference ? 1 : 0;
      const pb = b.isPreference ? 1 : 0;
      if (pa !== pb) return pb - pa;
      return (b.date || '').localeCompare(a.date || '');
    });
    filtered = filtered.map((p) => (favs.has(p.id) ? { ...p, isFav: true } : { ...p, isFav: false }));
    this.setData({
      filtered,
      shown: PAGE_SIZE,
      visible: filtered.slice(0, PAGE_SIZE),
      hasMore: filtered.length > PAGE_SIZE
    });
  },

  // 交互
  onInput(e) {
    this.setData({ q: e.detail.value });
    this.applyFilter();
  },
  togglePref() {
    this.setData({ prefOnly: !this.data.prefOnly });
    this.applyFilter();
  },
  setTax(e) { this.setData({ tax: e.currentTarget.dataset.v }); this.applyFilter(); },
  setType(e) { this.setData({ type: e.currentTarget.dataset.v }); this.applyFilter(); },
  setLocation(e) { this.setData({ location: e.currentTarget.dataset.v }); this.applyFilter(); },
  setStatus(e) { this.setData({ status: e.currentTarget.dataset.v }); this.applyFilter(); },

  loadMore() {
    const { shown, filtered } = this.data;
    const next = shown + PAGE_SIZE;
    this.setData({
      shown: next,
      visible: filtered.slice(0, next),
      hasMore: filtered.length > next
    });
  },

  // 点卡片 → 进详情页直接看正文（小程序不能打开外部网页）
  openUrl(e) {
    const id = e.currentTarget.dataset.id;
    if (!id) return;
    wx.navigateTo({ url: '/pages/detail/detail?id=' + encodeURIComponent(id) });
  },


  onPullDownRefresh() {
    api.getPolicies().then((data) => {
      getApp().globalData.policies = data;
      try { wx.setStorageSync('policies', { data, t: Date.now() }); } catch (err) {}
      this.applyData(data);
      wx.stopPullDownRefresh();
      wx.showToast({ title: '已更新', icon: 'success' });
    }).catch(() => {
      wx.stopPullDownRefresh();
      wx.showToast({ title: '刷新失败，稍后再试', icon: 'none' });
    });
  }
});
