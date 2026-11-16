// utils/taxCalculator.js —— 核心税务计算算法库
// 所有计算基于现行政策，返回结构化结果供页面渲染

const R = require('../constants/taxRates');

// 金额保留两位
function fmt(n) {
  return Math.round(n * 100) / 100;
}

// 超额累进计算
function progressiveTax(taxable, rateTable) {
  if (taxable <= 0) return 0;
  for (const tier of rateTable) {
    if (taxable > tier.min && taxable <= tier.max) {
      return fmt(taxable * tier.rate - tier.quickDeduct);
    }
  }
  const last = rateTable[rateTable.length - 1];
  return fmt(taxable * last.rate - last.quickDeduct);
}

// 查询适用档位
function getTier(taxable, rateTable) {
  for (const tier of rateTable) {
    if (taxable > tier.min && taxable <= tier.max) {
      return tier;
    }
  }
  return rateTable[rateTable.length - 1];
}

// ============================================================
// 一、居民个人综合所得（工资薪金）
// ============================================================
function calcIncomeTax({
  monthlyIncome = 0,
  socialSecurity = 0,
  monthlyDeduction = 0,
  annualBonus = 0,
  months = 12,
  includeBonus = true
}) {
  const basicDeduct = 5000;
  const monthlyTaxable = monthlyIncome - basicDeduct - socialSecurity - monthlyDeduction;

  const annualIncome = monthlyIncome * months;
  const annualDeduct = (basicDeduct + socialSecurity + monthlyDeduction) * months;
  const annualTaxable = annualIncome - annualDeduct;

  const incomeTaxYear = annualTaxable > 0 ? progressiveTax(annualTaxable, R.COMPREHENSIVE_RATES) : 0;

  let bonus = null;
  let totalYearTax = incomeTaxYear;

  if (includeBonus && annualBonus > 0) {
    bonus = calcBonus(annualBonus, {
      annualTaxable,
      combinedYearTax: incomeTaxYear
    });
    if (bonus.best) {
      totalYearTax = fmt(incomeTaxYear + bonus.best.tax);
    }
  }

  const taxPerMonth = fmt(totalYearTax / months);
  const netIncomePerMonth = fmt(monthlyIncome - socialSecurity - taxPerMonth);

  return {
    monthly: {
      income: monthlyIncome,
      basicDeduct,
      socialSecurity,
      specialDeduction: monthlyDeduction,
      taxable: fmt(monthlyTaxable),
      tax: taxPerMonth,
      net: netIncomePerMonth
    },
    annual: {
      income: annualIncome,
      deductible: annualDeduct,
      taxable: annualTaxable,
      tax: incomeTaxYear
    },
    bonus,
    totalYearTax,
    tier: annualTaxable > 0 ? getTier(annualTaxable, R.COMPREHENSIVE_RATES) : null
  };
}

// ============================================================
// 二、全年一次性奖金优化
// ============================================================
function calcBonus(annualBonus, { annualTaxable = 0, combinedYearTax = 0 } = {}) {
  const monthly = annualBonus / 12;
  const soloTier = getTier(monthly, R.BONUS_RATES);
  const soloTax = fmt(annualBonus * soloTier.rate - soloTier.quickDeduct);

  const mergedTaxable = annualTaxable + annualBonus;
  const mergedTax = mergedTaxable > 0 ? progressiveTax(mergedTaxable, R.COMPREHENSIVE_RATES) : 0;
  const mergeIncremental = fmt(mergedTax - combinedYearTax);

  const soloBetter = soloTax <= mergeIncremental;
  const best = soloBetter
    ? { mode: '单独计税', tax: soloTax }
    : { mode: '并入综合所得', tax: mergeIncremental };

  const saving = fmt(Math.abs(soloTax - mergeIncremental));
  const betterMode = soloBetter ? '单独计税' : '并入综合所得';

  return {
    amount: annualBonus,
    solo: { tax: soloTax, tier: soloTier },
    merged: { tax: mergeIncremental, mergedTaxable },
    best,
    betterMode,
    saving,
    tip: annualBonus > 0 ? bonusTip(annualBonus, soloTax, mergeIncremental) : ''
  };
}

// 年终奖跳档临界提示
function bonusTip(amount, soloTax, mergedIncremental) {
  const month = amount / 12;
  let tip = '';
  for (const tier of R.BONUS_RATES) {
    if (tier.max !== Infinity && month > tier.max * 0.98 && month < tier.max * 1.05) {
      tip = `注意：奖金处于跳档临界区（约月均 ${tier.max} 元），多发可能适用更高税率，建议微调或并入综合所得对比。`;
      break;
    }
  }
  return tip;
}

// ============================================================
// 三、专项附加扣除汇总
// ============================================================
function calcSpecialDeductions({
  childrenCount = 0,
  infantCount = 0,
  elderly = false,
  elderlyOnly = true,
  housingLoan = false,
  housingRentTier = -1,
  continuingEdu = false,
  continuingCert = false,
  medicalAnnual = 0
}) {
  let monthly = 0;
  const detail = [];

  if (childrenCount > 0) {
    const m = R.SPECIAL_DEDUCTIONS.children.monthly * childrenCount;
    monthly += m;
    detail.push({ name: `子女教育×${childrenCount}`, monthly: m });
  }
  if (infantCount > 0) {
    const m = R.SPECIAL_DEDUCTIONS.infantCare.monthly * infantCount;
    monthly += m;
    detail.push({ name: `婴幼儿照护×${infantCount}`, monthly: m });
  }
  if (elderly) {
    const m = elderlyOnly ? R.SPECIAL_DEDUCTIONS.elderly.monthly : 1500;
    monthly += m;
    detail.push({ name: '赡养老人', monthly: m });
  }
  if (housingLoan) {
    monthly += R.SPECIAL_DEDUCTIONS.housingLoan.monthly;
    detail.push({ name: '住房贷款利息', monthly: R.SPECIAL_DEDUCTIONS.housingLoan.monthly });
  } else if (housingRentTier >= 0 && housingRentTier < R.SPECIAL_DEDUCTIONS.housingRent.tiers.length) {
    const m = R.SPECIAL_DEDUCTIONS.housingRent.tiers[housingRentTier].monthly;
    monthly += m;
    detail.push({ name: '住房租金', monthly: m });
  }
  if (continuingEdu) {
    monthly += R.SPECIAL_DEDUCTIONS.continuingEducation.monthly;
    detail.push({ name: '继续教育(学历)', monthly: R.SPECIAL_DEDUCTIONS.continuingEducation.monthly });
  }
  if (continuingCert) {
    const m = fmt(R.SPECIAL_DEDUCTIONS.continuingEducation.annualCert / 12);
    monthly += m;
    detail.push({ name: '继续教育(职业资格)', monthly: m });
  }

  let medicalAnnualDeduct = 0;
  if (medicalAnnual > 15000) {
    medicalAnnualDeduct = Math.min(medicalAnnual - 15000, R.SPECIAL_DEDUCTIONS.medical.annualCap);
  }

  const annual = fmt(monthly * 12 + medicalAnnualDeduct);
  return {
    monthly: fmt(monthly),
    annual,
    detail,
    medicalAnnualDeduct
  };
}

// ============================================================
// 四、个体工商户经营所得
// ============================================================
function calcBusinessTax(annualTaxableIncome) {
  if (annualTaxableIncome <= 0) {
    return { taxable: 0, tax: 0, tier: null, note: '无应纳税所得额，无需缴税' };
  }
  const tax = progressiveTax(annualTaxableIncome, R.BUSINESS_RATES);
  const tier = getTier(annualTaxableIncome, R.BUSINESS_RATES);
  return {
    taxable: annualTaxableIncome,
    tax,
    tier,
    effectiveRate: fmt((tax / annualTaxableIncome) * 100)
  };
}

// ============================================================
// 五、小型微利企业所得税 + 增值税
// ============================================================
function calcSmeIncomeTax(annualProfit) {
  if (annualProfit <= 0) {
    return { tax: 0, effectiveRate: 0, eligible: true, note: '亏损，无需缴纳企业所得税' };
  }
  const eligible = annualProfit <= R.SME_POLICY.maxIncome;
  if (eligible) {
    const tax = fmt(annualProfit * R.SME_POLICY.effectiveRate);
    return {
      tax,
      taxable: annualProfit,
      effectiveRate: 5,
      eligible: true,
      note: '小型微利企业：减按25%计入所得，按20%征收，实际税负5%'
    };
  }
  const tax = fmt(annualProfit * 0.25);
  return {
    tax,
    taxable: annualProfit,
    effectiveRate: 25,
    eligible: false,
    note: '年应纳税所得额超过300万，无法享受小微优惠，按25%全额征收'
  };
}

function calcSmeVat(monthlySales) {
  const exempt = monthlySales <= R.VAT_SMALL_SCALE.monthlyExempt;
  const vat = exempt ? 0 : fmt(monthlySales * R.VAT_SMALL_SCALE.reducedRate / (1 + R.VAT_SMALL_SCALE.reducedRate));
  const surcharge = exempt ? 0 : fmt(vat * 0.12 * R.SIX_TAX_HALF.halfRate);
  return {
    monthlySales,
    exempt,
    vat,
    surcharge,
    note: exempt
      ? `月销售额 ${monthlySales} 元 ≤ 10 万，免征增值税`
      : '月销售额超过10万，按1%征收率缴纳'
  };
}

// ============================================================
// 六、汇算清缴退税测算
// ============================================================
function calcAnnualSettle({
  annualIncome = 0,
  annualPrepaid = 0,
  monthlyDeduction = 0,
  socialSecurityYear = 0
}) {
  const annualDeduct = 60000 + socialSecurityYear + monthlyDeduction * 12;
  const taxable = annualIncome - annualDeduct;
  const due = taxable > 0 ? progressiveTax(taxable, R.COMPREHENSIVE_RATES) : 0;
  const diff = fmt(annualPrepaid - due);
  const type = diff > 0 ? '退税' : (diff < 0 ? '补税' : '两清');
  return {
    annualIncome,
    annualDeduct,
    taxable,
    due,
    prepaid: annualPrepaid,
    diff,
    type,
    absDiff: Math.abs(diff)
  };
}

module.exports = {
  fmt,
  progressiveTax,
  getTier,
  calcIncomeTax,
  calcBonus,
  calcSpecialDeductions,
  calcBusinessTax,
  calcSmeIncomeTax,
  calcSmeVat,
  calcAnnualSettle
};