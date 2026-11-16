// pages/personal/annual/index.js —— 年终奖优化
const app = getApp();
const T = require('../../../utils/taxCalculator');

Page({
  data: {
    bonus: 60000,
    annualTaxable: 120000,
    result: null
  },

  onInput(e) {
    const field = e.currentTarget.dataset.field;
    this.setData({ [field]: Number(e.detail.value) || 0 });
  },

  onCalc() {
    const { bonus, annualTaxable } = this.data;
    const result = T.calcBonus(bonus, { annualTaxable });
    this.setData({ result });
    app.recordHistory({
      name: `年终奖${bonus}元`,
      result: `建议${result.betterMode}，税${result.best.tax}元`
    });
  }
});