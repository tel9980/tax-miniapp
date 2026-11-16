// app.js —— 税收优惠小程序全局逻辑
App({
  globalData: {
    // 用户身份：'personal' 个人 | 'enterprise' 企业 | 'mixed' 综合
    userType: 'mixed',
    // 是否开启风险提示
    riskAlert: true,
    // 当前年份，用于计税档位
    taxYear: 2026,
    // 缓存计算历史
    history: []
  },

  onLaunch() {
    // 从本地缓存恢复用户偏好
    try {
      const saved = wx.getStorageSync('tax_global');
      if (saved) {
        this.globalData = Object.assign({}, this.globalData, saved);
      }
    } catch (e) {
      // 忽略读取失败
    }
  },

  // 写入本地缓存
  persistGlobal() {
    try {
      wx.setStorageSync('tax_global', this.globalData);
    } catch (e) {
      // 存储失败不阻塞业务
    }
  },

  // 记录一次计算历史，方便"最近计算"复用
  recordHistory(item) {
    const history = this.globalData.history || [];
    history.unshift(item);
    if (history.length > 20) {
      history.pop();
    }
    this.globalData.history = history;
    this.persistGlobal();
  }
});