// app.js —— 税收优惠小程序全局逻辑

// ===== 云开发环境 ID（政策自动同步用）=====
// 开通微信云开发后，把这里改成你的环境 ID，例如 'tax-miniapp-1g2h3j4k'
// 不改（留空）也能正常用，只是政策更新走内置兜底数据，不自动同步。
const CLOUD_ENV = '';

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

    // 初始化云开发（政策自动同步依赖；未开通则跳过，走内置兜底）
    if (wx.cloud && CLOUD_ENV) {
      wx.cloud.init({ env: CLOUD_ENV, traceUser: true });
    } else if (wx.cloud) {
      wx.cloud.init({ traceUser: true }); // 使用默认环境
    }

    // 政策自动同步：先读本地缓存（秒开），再异步从云函数拉最新（云函数内部连 GitHub）
    const taxConfig = require('./utils/taxConfig');
    taxConfig.loadCache();
    taxConfig.sync().then((r) => {
      this.globalData.policyVersion = r.version;
      this.globalData.policySource = r.source;
      this.persistGlobal();
    });
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