// pages/enterprise/invoice/index.js —— 增值税/开票筹划
const app = getApp();
const T = require('../../../utils/taxCalculator');

Page({
  data: {
    monthlySales: 80000,
    result: null
  },

  onInput(e) {
    this.setData({ monthlySales: Number(e.detail.value) || 0 });
  },

  onCalc() {
    const result = T.calcSmeVat(this.data.monthlySales);
    this.setData({ result });
    app.recordHistory({
      name: `增值税测算·月销${this.data.monthlySales}元`,
      result: result.exempt ? '免征增值税' : `增值税${result.vat}元`
    });
  }
});