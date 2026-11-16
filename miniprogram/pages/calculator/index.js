// pages/calculator/index.js —— 常用税率速查计算器
const R = require('../../constants/taxRates');

Page({
  data: {
    tab: 'comprehensive', // comprehensive | bonus | business
    comprehensive: [],
    bonus: [],
    business: []
  },

  onLoad() {
    this.setData({
      comprehensive: R.COMPREHENSIVE_RATES.map(t => ({
        level: t.level, range: `${t.min}~${t.max===Infinity?'以上':t.max}`, rate: `${t.rate*100}%`, quick: t.quickDeduct
      })),
      bonus: R.BONUS_RATES.map(t => ({
        level: t.level, range: `${t.min}~${t.max===Infinity?'以上':t.max}`, rate: `${t.rate*100}%`, quick: t.quickDeduct
      })),
      business: R.BUSINESS_RATES.map(t => ({
        level: t.level, range: `${t.min}~${t.max===Infinity?'以上':t.max}`, rate: `${t.rate*100}%`, quick: t.quickDeduct
      }))
    });
  },

  switchTab(e) {
    this.setData({ tab: e.currentTarget.dataset.tab });
  }
});