const api = require('../../utils/api');

// 参数可能被框架解过一次，也可能没解，这里两种都兜住
function safeDecode(s) {
  if (!s) return '';
  if (s.indexOf('://') >= 0) return s;
  try { return decodeURIComponent(s); } catch (e) { return s; }
}

// 小程序里不能直接打开外部网页（web-view 要求已备案的业务域名），
// 所以详情页由后端抓官方原文正文，这里自己渲染，点开就能看内容。
Page({
  data: {
    loading: true,
    error: '',
    detail: null,
    url: '',
    docNo: ''
  },

  onLoad(query) {
    const id = (query && query.id) || '';
    const rawUrl = safeDecode((query && query.url) || '');
    const rawTitle = safeDecode((query && query.title) || '');

    // 衔接表进来的：没有政策 id，直接按官方原文链接抓正文
    if (rawUrl) {
      this.setData({ url: rawUrl });
      wx.setNavigationBarTitle({ title: '政策原文' });
      this.loadByUrl(rawUrl, rawTitle);
      return;
    }

    const app = getApp();
    const list = (app && app.globalData && app.globalData.policies && app.globalData.policies.items) || [];
    const hit = list.find((p) => p.id === id);
    if (hit) {
      this.setData({ url: hit.url || '', docNo: hit.docNo || '' });
      wx.setNavigationBarTitle({ title: hit.isPreference ? '优惠政策详情' : '政策详情' });
    }
    if (!id) {
      this.setData({ loading: false, error: '缺少政策编号' });
      return;
    }
    this.id = id;
    this.load(id);
  },

  loadByUrl(url, title) {
    this.setData({ loading: true, error: '' });
    api.getDetailByUrl(url, title)
      .then((d) => {
        if (!d || !d.ok) {
          const map = {
            empty: '没能取到正文，可以复制链接到浏览器查看。',
            host_not_allowed: '不支持的链接来源。',
            bad_url: '链接格式不对。'
          };
          this.setData({
            loading: false,
            error: map[d && d.error] || ('正文抓取失败（' + ((d && d.error) || '未知错误') + '），可复制链接到浏览器查看。'),
            detail: d || null
          });
          return;
        }
        this.setData({ loading: false, detail: d, url: d.url || url, docNo: d.docNo || '' });
      })
      .catch((e) => {
        this.setData({
          loading: false,
          error: '网络不通（' + ((e && e.message) || '请求失败') + '）。如果是开发者工具，记得勾选「不校验合法域名」。'
        });
      });
  },

  load(id) {
    this.setData({ loading: true, error: '' });
    api.getDetail(id)
      .then((d) => {
        if (!d || !d.ok) {
          const map = {
            no_url: '这条政策官方库没有收录原文，请按文号在官网检索，或拨 12366 确认。',
            empty: '没能取到正文，可以复制链接到浏览器查看。',
            not_found: '政策数据已更新，请返回列表重新进入。'
          };
          this.setData({
            loading: false,
            error: map[d && d.error] || ('正文抓取失败（' + ((d && d.error) || '未知错误') + '），可复制链接到浏览器查看。'),
            detail: d || null
          });
          return;
        }
        this.setData({ loading: false, detail: d, url: d.url || this.data.url, docNo: d.docNo || this.data.docNo });
      })
      .catch((e) => {
        this.setData({
          loading: false,
          error: '网络不通（' + ((e && e.message) || '请求失败') + '）。如果是开发者工具，记得勾选「不校验合法域名」。'
        });
      });
  },

  retry() {
    if (this.data.url) this.loadByUrl(this.data.url, '');
    else if (this.id) this.load(this.id);
  },

  copyUrl() {
    if (!this.data.url) {
      wx.showToast({ title: '这条没有原文链接', icon: 'none' });
      return;
    }
    wx.setClipboardData({
      data: this.data.url,
      success: () => wx.showToast({ title: '链接已复制，去浏览器粘贴', icon: 'none' })
    });
  },

  copyDocNo() {
    const doc = this.data.docNo || (this.data.detail && this.data.detail.docNo) || '';
    if (!doc) {
      wx.showToast({ title: '这条没有文号', icon: 'none' });
      return;
    }
    wx.setClipboardData({ data: doc, success: () => wx.showToast({ title: '文号已复制', icon: 'none' }) });
  }
});
