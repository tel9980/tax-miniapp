// utils/taxConfig.js —— 政策数据加载器（三层：内置兜底 → 本地缓存 → 云函数同步）
// 作用：让税率/政策档位「政策一变自动生效」，无需重新发布小程序。
// 数据流向：GitHub(data/policies.json) → 微信云函数(getPolicy) → 本地缓存 → 计算算法

const BUILTIN = require('../constants/taxRates');

// 当前生效的税率/政策配置，初始指向内置兜底常量
let state = BUILTIN;

// 同步状态元信息
let meta = {
  version: BUILTIN.DEFAULT_POLICY_VERSION,
  source: 'builtin',   // builtin | cache | cloud
  updatedAt: null
};

// 获取当前生效配置（同步，算法层调用）
function get() {
  return state;
}

// 获取同步状态（同步，页面展示用）
function getMeta() {
  return meta;
}

// 启动时同步读取本地缓存（在 onLaunch 早期调用，保证首屏就有较新数据）
function loadCache() {
  try {
    const c = wx.getStorageSync('tax_policy_cache');
    if (c && c.data && c.version) {
      state = c.data;
      meta = { version: c.version, source: 'cache', updatedAt: c.updatedAt || null };
    }
  } catch (e) {
    // 缓存读取失败，保持内置
  }
}

// 异步从云函数同步最新政策（云函数内部从 GitHub raw 拉取）
// 返回 Promise<{ updated, source, version }>
function sync() {
  return new Promise((resolve) => {
    // 未初始化云开发，直接返回当前来源
    if (typeof wx === 'undefined' || !wx.cloud) {
      resolve({ updated: false, source: meta.source, version: meta.version });
      return;
    }
    wx.cloud.callFunction({ name: 'getPolicy' })
      .then((res) => {
        const d = res && res.result;
        if (d && d.ok && d.data && d.version && d.version !== meta.version) {
          // 有新版本，覆盖内存与本地缓存
          state = d.data;
          meta = { version: d.version, source: 'cloud', updatedAt: d.updatedAt || null };
          try {
            wx.setStorageSync('tax_policy_cache', {
              version: d.version,
              updatedAt: d.updatedAt || null,
              data: d.data
            });
          } catch (e) {
            // 缓存写入失败不影响本次同步结果
          }
          resolve({ updated: true, source: 'cloud', version: d.version });
        } else {
          resolve({ updated: false, source: meta.source, version: meta.version });
        }
      })
      .catch(() => {
        resolve({ updated: false, source: meta.source, version: meta.version });
      });
  });
}

module.exports = { get, getMeta, loadCache, sync };