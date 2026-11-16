// pages/personal/income/index.js —— 个税计算器
const app = getApp();
const T = require('../../../utils/taxCalculator');

Page({
  data: {
    form: {
      monthlyIncome: 15000,
      socialSecurity: 1500,
      monthlyDeduction: 2000,
      annualBonus: 0,
      months: 12
    },
    result: null
  },

  onInput(e) {
    const field = e.currentTarget.dataset.field;
    this.setData({ [`form.${field}`]: Number(e.detail.value) || 0 });
  },

  onCalc() {
    const { form } = this.data;
    const result = T.calcIncomeTax(form);
    this.setData({ result });
    app.recordHistory({
      name: `个税·月薪${form.monthlyIncome}元`,
      result: `年税 ${result.totalYearTax} 元`
    });
  },

  goAnnual() {
    wx.navigateTo({ url: '/pages/personal/annual/index' });
  }
});