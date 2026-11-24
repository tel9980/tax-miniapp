const api = require('../../utils/api');

const PAGE_SIZE = 40;
const FAV_KEY = 'tax-favs';
const STATUS_OPTIONS = ['全部', '生效中', '即将到期', '已到期', '未标注'];
const CACHE_KEY = 'policies-page1';

Page({
  data: {
    loading: true,
    error: '',
    items: [],       // 已加载的政策（服务端分页逐页追加）
    total: 0,        // 当前筛选条件下的总条数
    prefCount: 0,
    page: 1,
    totalPages: 1,
    hasMore: false,
    loadingMore: false,

    // 筛选状态
    q: '',
    prefOnly: false,
    tax: '全部',
    type: '全部',
    location: '全部',
    status: '全部',
    favOnly: false,
    favCount: 0,

    // 选项（来自服务端 facets）
    taxOptions: ['全部'],
    typeOptions: ['全部'],
    locationOptions: ['全部'],
    statusOptions: STATUS_OPTIONS,

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
      this.loadPage(1, false);
    } catch (e) {
      console.error('[policies] onLoad 异常', e);
      this.setData({ loading: false, error: '页面初始化失败：' + ((e && e.message) || e) });
    }
  },

  // ---------- 收藏 ----------
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
    const isFav = this.favs.has(id);
    // 只改这一条的星标，不整页重拉
    const items = this.data.items.map((p) => (p.id === id ? { ...p, isFav } : p));
    this.setData({ items });
    if (this.data.favOnly) this.loadPage(1, false);
    wx.showToast({ title: isFav ? '已收藏' : '已取消', icon: 'none', duration: 800 });
  },

  toggleFavOnly() {
    this.setData({ favOnly: !this.data.favOnly });
    this.loadPage(1, false);
  },

  // ---------- 请求 ----------
  // 把当前筛选态拼成接口参数
  buildParams(page) {
    const { q, prefOnly, tax, type, location, status, favOnly } = this.data;
    const params = { page, size: PAGE_SIZE };
    if (q.trim()) params.q = q.trim();
    if (prefOnly) params.prefOnly = 1;
    if (tax !== '全部') params.tax = tax;
    if (type !== '全部') params.type = type;
    if (status !== '全部') params.status = status;
    if (location !== '全部') {
      if (location === '全国' || location === '广东') params.region = location;
      else params.area = location;
    }
    if (favOnly) {
      params.favOnly = 1;
      params.favs = [...(this.favs || [])].join(',');
    }
    return params;
  },

  async loadPage(page, append) {
    if (append && this.data.loadingMore) return;
    if (append) this.setData({ loadingMore: true });
    else this.setData({ loading: true, error: '' });

    try {
      const d = await api.getPoliciesPage(this.buildParams(page));
      const favs = this.favs || new Set();
      const fresh = (d.items || []).map((p) => ({ ...p, isFav: favs.has(p.id), docLabel: this.docLabel(p) }));
      const items = append ? this.data.items.concat(fresh) : fresh;

      const patch = {
        items,
        total: d.total || 0,
        prefCount: d.prefCount || 0,
        page: d.page || page,
        totalPages: d.totalPages || 1,
        hasMore: (d.page || page) < (d.totalPages || 1),
        loading: false,
        loadingMore: false,
        error: ''
      };
      // facets 换页时也返回，但只在首屏刷新选项，避免翻页时 chips 跳动
      if (!append && d.facets) Object.assign(patch, this.buildOptions(d.facets));
      if (!append && d.updatedAt) patch.updatedAtShort = this.fmtTime(d.updatedAt);
      this.setData(patch);

      // 首屏结果落缓存，断网时还能看到上次的内容
      if (!append) {
        try { wx.setStorageSync(CACHE_KEY, { d, t: Date.now() }); } catch (e) {}
      }
    } catch (e) {
      if (append) {
        this.setData({ loadingMore: false });
        wx.showToast({ title: '加载失败，稍后再试', icon: 'none' });
        return;
      }
      // 首屏失败：先试缓存
      const c = wx.getStorageSync(CACHE_KEY);
      if (c && c.d && c.d.items && c.d.items.length) {
        const favs = this.favs || new Set();
        this.setData(Object.assign({
          items: c.d.items.map((p) => ({ ...p, isFav: favs.has(p.id), docLabel: this.docLabel(p) })),
          total: c.d.total || c.d.items.length,
          prefCount: c.d.prefCount || 0,
          page: 1,
          totalPages: c.d.totalPages || 1,
          hasMore: false,
          loading: false,
          error: ''
        }, c.d.facets ? this.buildOptions(c.d.facets) : {}));
      } else {
        this.setData({ loading: false, error: '加载失败，请下拉重试' });
      }
    }
  },

  // facets → chips 选项
  buildOptions(f) {
    const tax = (f.tax || []).map((x) => x.k);
    const type = (f.type || []).map((x) => x.k);
    const regions = (f.region || []).map((x) => x.k);
    const areas = (f.area || []).map((x) => x.k);
    const regionOrder = ['全国', '广东'];
    const locs = regionOrder.filter((r) => regions.indexOf(r) >= 0);
    regions.forEach((r) => { if (regionOrder.indexOf(r) < 0) locs.push(r); });
    return {
      taxOptions: ['全部'].concat(tax),
      typeOptions: ['全部'].concat(type),
      locationOptions: ['全部'].concat(locs).concat(areas)
    };
  },

  // 法律法规本身没有发文字号，用类型说明代替，避免显示成空白
  docLabel(p) {
    if (p.docNo) return p.docNo;
    if (p.docType === 'law') return '法律法规';
    if (p.docType === 'qa') return '政策解读';
    return '';
  },

  fmtTime(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    const p = (n) => (n < 10 ? '0' + n : '' + n);
    return `${d.getMonth() + 1}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  },

  // ---------- 交互 ----------
  // 搜索输入防抖：每敲一个字就请求会打爆接口
  onInput(e) {
    this.setData({ q: e.detail.value });
    if (this._qTimer) clearTimeout(this._qTimer);
    this._qTimer = setTimeout(() => this.loadPage(1, false), 350);
  },
  togglePref() { this.setData({ prefOnly: !this.data.prefOnly }); this.loadPage(1, false); },
  setTax(e) { this.setData({ tax: e.currentTarget.dataset.v }); this.loadPage(1, false); },
  setType(e) { this.setData({ type: e.currentTarget.dataset.v }); this.loadPage(1, false); },
  setLocation(e) { this.setData({ location: e.currentTarget.dataset.v }); this.loadPage(1, false); },
  setStatus(e) { this.setData({ status: e.currentTarget.dataset.v }); this.loadPage(1, false); },

  loadMore() {
    if (!this.data.hasMore) return;
    this.loadPage(this.data.page + 1, true);
  },

  // 点卡片 → 进详情页直接看正文（小程序不能打开外部网页）
  openUrl(e) {
    const id = e.currentTarget.dataset.id;
    if (!id) return;
    wx.navigateTo({ url: '/pages/detail/detail?id=' + encodeURIComponent(id) });
  },

  onPullDownRefresh() {
    this.loadPage(1, false).then(() => {
      wx.stopPullDownRefresh();
      wx.showToast({ title: '已更新', icon: 'success' });
    }).catch(() => {
      wx.stopPullDownRefresh();
    });
  },

  onUnload() {
    if (this._qTimer) clearTimeout(this._qTimer);
  }
});
