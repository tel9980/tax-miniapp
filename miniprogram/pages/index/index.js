// pages/index/index.js —— 首页
const app = getApp();

Page({
  data: {
    userType: 'mixed',
    history: []
  },

  onShow() {
    this.setData({
      userType: app.globalData.userType,
      history: (app.globalData.history || []).slice(0, 4)
    });
  },

  // 个人端入口
  goPersonal(e) {
    const type = e.currentTarget.dataset.type;
    const map = {
      'income': '/pages/personal/income/index',
      'annual': '/pages/personal/annual/index',
      'deduction': '/pages/personal/deduction/index'
    };
    wx.navigateTo({ url: map[type] });
  },

  // 企业端入口
  goEnterprise(e) {
    const type = e.currentTarget.dataset.type;
    const map = {
      'sme': '/pages/enterprise/sme/index',
      'invoice': '/pages/enterprise/invoice/index'
    };
    wx.navigateTo({ url: map[type] });
  },

  switchUser(e) {
    const type = e.currentTarget.dataset.type;
    app.globalData.userType = type;
    app.persistGlobal();
    this.setData({ userType: type });
    wx.showToast({ title: '已切换', icon: 'success' });
  },

  goCalc() {
    wx.switchTab({ url: '/pages/calculator/index' });
  }
});