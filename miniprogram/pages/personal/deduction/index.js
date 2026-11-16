// pages/personal/deduction/index.js —— 专项附加扣除
const app = getApp();
const T = require('../../../utils/taxCalculator');

Page({
  data: {
    form: {
      childrenCount: 0,
      infantCount: 0,
      elderly: false,
      elderlyOnly: true,
      housingLoan: false,
      housingRentTier: -1,
      continuingEdu: false,
      continuingCert: false,
      medicalAnnual: 0
    },
    rentTiers: [
      { monthly: 1500, city: '直辖市/省会/计划单列市' },
      { monthly: 1100, city: '人口>100万城市' },
      { monthly: 800, city: '其他城市' }
    ],
    result: null
  },

  onInput(e) {
    const field = e.currentTarget.dataset.field;
    this.setData({ [`form.${field}`]: Number(e.detail.value) || 0 });
  },

  onSwitch(e) {
    const field = e.currentTarget.dataset.field;
    this.setData({ [`form.${field}`]: e.detail.value });
  },

  onRent(e) {
    this.setData({ 'form.housingRentTier': Number(e.detail.value) });
  },

  onCalc() {
    const result = T.calcSpecialDeductions(this.data.form);
    this.setData({ result });
    app.recordHistory({
      name: '专项附加扣除',
      result: `月扣${result.monthly}元 / 年${result.annual}元`
    });
  }
});