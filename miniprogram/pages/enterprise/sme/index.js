// pages/enterprise/sme/index.js —— 小微企业所得税
const app = getApp();
const T = require('../../../utils/taxCalculator');

Page({
  data: {
    form: {
      annualProfit: 1000000,   // 年应纳税所得额（利润）
      monthlySales: 80000      // 月销售额
    },
    result: null
  },

  onInput(e) {
    const field = e.currentTarget.dataset.field;
    this.setData({ [`form.${field}`]: Number(e.detail.value) || 0 });
  },

  onCalc() {
    const { form } = this.data;
    const income = T.calcSmeIncomeTax(form.annualProfit);
    const vat = T.calcSmeVat(form.monthlySales);
    this.setData({ result: { income, vat } });
    app.recordHistory({
      name: '小微测算',
      result: `所得税${income.tax}元 · ${vat.exempt?'免增值税':'增值税'+vat.vat+'元'}`
    });
  }
});