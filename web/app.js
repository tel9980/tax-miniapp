// web/app.js —— 税收优惠计算器（网页版）核心逻辑
// 复用小程序版算法，政策数据从 GitHub 自动同步（浏览器无备案限制，可直连）

// ==================== 政策数据加载（自动同步）====================
// 政策源优先级：同域 CF Pages Function（/api/policy，最稳）→ jsDelivr → GitHub raw → 内置兜底
const POLICY_SOURCES = [
  '/api/policy',
  'https://cdn.jsdelivr.net/gh/tel9980/tax-miniapp@main/data/policies.json',
  'https://raw.githubusercontent.com/tel9980/tax-miniapp/main/data/policies.json'
];

const CACHE_KEY = 'tax_policy_cache_v1';

// 当前生效政策（初始为内置兜底）
let POLICY = getBuiltinPolicy();
let policyMeta = { version: 'builtin', source: 'builtin', updatedAt: null };

// 内置兜底政策（离线可用，与 data/policies.json 一致）
function getBuiltinPolicy() {
  return {
    TAX_YEAR: 2026,
    COMPREHENSIVE_RATES: [
      { level: 1, min: 0, max: 36000, rate: 0.03, quickDeduct: 0 },
      { level: 2, min: 36000, max: 144000, rate: 0.1, quickDeduct: 2520 },
      { level: 3, min: 144000, max: 300000, rate: 0.2, quickDeduct: 16920 },
      { level: 4, min: 300000, max: 420000, rate: 0.25, quickDeduct: 31920 },
      { level: 5, min: 420000, max: 660000, rate: 0.3, quickDeduct: 52920 },
      { level: 6, min: 660000, max: 960000, rate: 0.35, quickDeduct: 85920 },
      { level: 7, min: 960000, max: 1000000000, rate: 0.45, quickDeduct: 181920 }
    ],
    BONUS_RATES: [
      { level: 1, min: 0, max: 3000, rate: 0.03, quickDeduct: 0 },
      { level: 2, min: 3000, max: 12000, rate: 0.1, quickDeduct: 210 },
      { level: 3, min: 12000, max: 25000, rate: 0.2, quickDeduct: 1410 },
      { level: 4, min: 25000, max: 35000, rate: 0.25, quickDeduct: 2660 },
      { level: 5, min: 35000, max: 55000, rate: 0.3, quickDeduct: 4410 },
      { level: 6, min: 55000, max: 80000, rate: 0.35, quickDeduct: 7160 },
      { level: 7, min: 80000, max: 1000000000, rate: 0.45, quickDeduct: 15160 }
    ],
    SPECIAL_DEDUCTIONS: {
      children: { monthly: 2000, note: '每个子女 2000 元/月' },
      elderly: { monthly: 3000, note: '独生子女 3000 元/月' },
      housingLoan: { monthly: 1000, maxMonths: 240, note: '1000 元/月' },
      housingRent: {
        tiers: [
          { monthly: 1500, city: '直辖市/省会/计划单列市' },
          { monthly: 1100, city: '人口>100万的城市' },
          { monthly: 800, city: '其他城市' }
        ],
        note: '按城市分档'
      },
      continuingEducation: { monthly: 400, annualCert: 3600, note: '学历 400/月，职业资格 3600/年' },
      medical: { annualCap: 80000, note: '限额 80000/年' },
      infantCare: { monthly: 2000, note: '每个婴幼儿 2000/月' }
    },
    BUSINESS_RATES: [
      { level: 1, min: 0, max: 30000, rate: 0.05, quickDeduct: 0 },
      { level: 2, min: 30000, max: 90000, rate: 0.1, quickDeduct: 1500 },
      { level: 3, min: 90000, max: 300000, rate: 0.2, quickDeduct: 10500 },
      { level: 4, min: 300000, max: 500000, rate: 0.3, quickDeduct: 40500 },
      { level: 5, min: 500000, max: 1000000000, rate: 0.35, quickDeduct: 65500 }
    ],
    SME_POLICY: { maxIncome: 3000000, effectiveRate: 0.05, conditions: { employees: 300, assets: 50000000, nonTaxableIncome: 3000000 } },
    VAT_SMALL_SCALE: { monthlyExempt: 100000, quarterlyExempt: 300000, reducedRate: 0.01, note: '月销售额≤10万免征增值税' },
    SIX_TAX_HALF: { note: '六税两费减半', halfRate: 0.5 }
  };
}

// 从本地缓存加载
function loadCache() {
  try {
    const c = localStorage.getItem(CACHE_KEY);
    if (c) {
      const parsed = JSON.parse(c);
      if (parsed && parsed.data) {
        POLICY = parsed.data;
        policyMeta = { version: parsed.version, source: 'cache', updatedAt: parsed.updatedAt || null };
      }
    }
  } catch (e) { /* 忽略 */ }
}

// 异步从 GitHub 拉取最新政策
async function syncPolicy() {
  let lastErr = null;
  for (const url of POLICY_SOURCES) {
    try {
      const resp = await fetch(url, { headers: { 'user-agent': 'tax-miniapp-web' } });
      if (!resp.ok) throw new Error('HTTP ' + resp.status);
      const raw = await resp.json();
      const data = raw.policy || raw;
      if (data && raw.version && raw.version !== policyMeta.version) {
        POLICY = data;
        policyMeta = { version: raw.version, source: 'cloud', updatedAt: raw.updatedAt || null };
        try { localStorage.setItem(CACHE_KEY, JSON.stringify({ version: raw.version, updatedAt: raw.updatedAt, data })); } catch (e) {}
        return { updated: true, source: 'cloud', version: raw.version };
      }
      return { updated: false, source: policyMeta.source, version: policyMeta.version };
    } catch (e) {
      lastErr = e;
    }
  }
  return { updated: false, source: policyMeta.source, version: policyMeta.version, error: String(lastErr) };
}

// ==================== 核心算法（复用小程序版）====================
function fmt(n) { return Math.round(n * 100) / 100; }

function progressiveTax(taxable, rateTable) {
  if (taxable <= 0) return 0;
  for (const tier of rateTable) {
    if (taxable > tier.min && taxable <= tier.max) return fmt(taxable * tier.rate - tier.quickDeduct);
  }
  const last = rateTable[rateTable.length - 1];
  return fmt(taxable * last.rate - last.quickDeduct);
}

function getTier(taxable, rateTable) {
  for (const tier of rateTable) {
    if (taxable > tier.min && taxable <= tier.max) return tier;
  }
  return rateTable[rateTable.length - 1];
}

function calcIncomeTax({ monthlyIncome = 0, socialSecurity = 0, monthlyDeduction = 0, annualBonus = 0, months = 12, includeBonus = true }) {
  const basicDeduct = 5000;
  const annualIncome = monthlyIncome * months;
  const annualDeduct = (basicDeduct + socialSecurity + monthlyDeduction) * months;
  const annualTaxable = annualIncome - annualDeduct;
  const incomeTaxYear = annualTaxable > 0 ? progressiveTax(annualTaxable, POLICY.COMPREHENSIVE_RATES) : 0;

  let bonus = null;
  let totalYearTax = incomeTaxYear;
  if (includeBonus && annualBonus > 0) {
    bonus = calcBonus(annualBonus, { annualTaxable, combinedYearTax: incomeTaxYear });
    if (bonus.best) totalYearTax = fmt(incomeTaxYear + bonus.best.tax);
  }
  return {
    monthlyTaxable: fmt(annualTaxable / months),
    annualTaxable,
    incomeTaxYear,
    bonus,
    totalYearTax,
    taxPerMonth: fmt(totalYearTax / months),
    netPerMonth: fmt(monthlyIncome - socialSecurity - totalYearTax / months)
  };
}

function calcBonus(annualBonus, { annualTaxable = 0, combinedYearTax = 0 } = {}) {
  const monthly = annualBonus / 12;
  const soloTier = getTier(monthly, POLICY.BONUS_RATES);
  const soloTax = fmt(annualBonus * soloTier.rate - soloTier.quickDeduct);
  const mergedTaxable = annualTaxable + annualBonus;
  const mergedTax = mergedTaxable > 0 ? progressiveTax(mergedTaxable, POLICY.COMPREHENSIVE_RATES) : 0;
  const mergeIncremental = fmt(mergedTax - combinedYearTax);
  const soloBetter = soloTax <= mergeIncremental;
  const best = soloBetter ? { mode: '单独计税', tax: soloTax } : { mode: '并入综合所得', tax: mergeIncremental };
  return { amount: annualBonus, solo: { tax: soloTax, tier: soloTier }, merged: { tax: mergeIncremental }, best, betterMode: best.mode, saving: fmt(Math.abs(soloTax - mergeIncremental)) };
}

function calcSpecialDeductions({ childrenCount = 0, infantCount = 0, elderly = false, elderlyOnly = true, housingLoan = false, housingRentTier = -1, continuingEdu = false, continuingCert = false, medicalAnnual = 0 }) {
  const S = POLICY.SPECIAL_DEDUCTIONS;
  let monthly = 0;
  const detail = [];
  if (childrenCount > 0) { const m = S.children.monthly * childrenCount; monthly += m; detail.push({ name: `子女教育×${childrenCount}`, monthly: m }); }
  if (infantCount > 0) { const m = S.infantCare.monthly * infantCount; monthly += m; detail.push({ name: `婴幼儿照护×${infantCount}`, monthly: m }); }
  if (elderly) { const m = elderlyOnly ? S.elderly.monthly : 1500; monthly += m; detail.push({ name: '赡养老人', monthly: m }); }
  if (housingLoan) { monthly += S.housingLoan.monthly; detail.push({ name: '住房贷款利息', monthly: S.housingLoan.monthly }); }
  else if (housingRentTier >= 0 && housingRentTier < S.housingRent.tiers.length) { const m = S.housingRent.tiers[housingRentTier].monthly; monthly += m; detail.push({ name: '住房租金', monthly: m }); }
  if (continuingEdu) { monthly += S.continuingEducation.monthly; detail.push({ name: '继续教育(学历)', monthly: S.continuingEducation.monthly }); }
  if (continuingCert) { const m = fmt(S.continuingEducation.annualCert / 12); monthly += m; detail.push({ name: '继续教育(职业资格)', monthly: m }); }
  let medicalAnnualDeduct = 0;
  if (medicalAnnual > 15000) medicalAnnualDeduct = Math.min(medicalAnnual - 15000, S.medical.annualCap);
  return { monthly: fmt(monthly), annual: fmt(monthly * 12 + medicalAnnualDeduct), detail, medicalAnnualDeduct };
}

function calcBusinessTax(annualTaxableIncome) {
  if (annualTaxableIncome <= 0) return { tax: 0, effectiveRate: 0, note: '无应纳税所得额' };
  const tax = progressiveTax(annualTaxableIncome, POLICY.BUSINESS_RATES);
  return { tax, effectiveRate: fmt(tax / annualTaxableIncome * 100), tier: getTier(annualTaxableIncome, POLICY.BUSINESS_RATES) };
}

function calcSmeIncomeTax(annualProfit) {
  if (annualProfit <= 0) return { tax: 0, effectiveRate: 0, eligible: true, note: '亏损，无需缴税' };
  const eligible = annualProfit <= POLICY.SME_POLICY.maxIncome;
  if (eligible) return { tax: fmt(annualProfit * POLICY.SME_POLICY.effectiveRate), effectiveRate: 5, eligible: true, note: '小型微利企业：实际税负 5%' };
  return { tax: fmt(annualProfit * 0.25), effectiveRate: 25, eligible: false, note: '超过 300 万，按 25% 全额征收' };
}

function calcSmeVat(monthlySales) {
  const V = POLICY.VAT_SMALL_SCALE;
  const exempt = monthlySales <= V.monthlyExempt;
  const vat = exempt ? 0 : fmt(monthlySales * V.reducedRate / (1 + V.reducedRate));
  const surcharge = exempt ? 0 : fmt(vat * 0.12 * POLICY.SIX_TAX_HALF.halfRate);
  return { monthlySales, exempt, vat, surcharge, note: exempt ? `月销售额 ${monthlySales} 元 ≤ 10 万，免征增值税` : '超过 10 万，按 1% 征收率缴纳' };
}

function calcAnnualSettle({ annualIncome = 0, annualPrepaid = 0, monthlyDeduction = 0, socialSecurityYear = 0 }) {
  const annualDeduct = 60000 + socialSecurityYear + monthlyDeduction * 12;
  const taxable = annualIncome - annualDeduct;
  const due = taxable > 0 ? progressiveTax(taxable, POLICY.COMPREHENSIVE_RATES) : 0;
  const diff = fmt(annualPrepaid - due);
  return { taxable, due, diff, absDiff: Math.abs(diff), type: diff > 0 ? '退税' : (diff < 0 ? '补税' : '两清') };
}
