// constants/taxRates.js —— 税收档位与常量（以现行政策为基准，标注年份便于维护）

const TAX_YEAR = 2026;

// ===== 综合所得（居民个人）年度预扣预缴税率表 =====
// 全月应纳税所得额 = 月度收入 - 5000 - 专项扣除(三险一金) - 专项附加扣除 - 依法确定的其他扣除
const COMPREHENSIVE_RATES = [
  { level: 1, min: 0, max: 36000, rate: 0.03, quickDeduct: 0 },
  { level: 2, min: 36000, max: 144000, rate: 0.10, quickDeduct: 2520 },
  { level: 3, min: 144000, max: 300000, rate: 0.20, quickDeduct: 16920 },
  { level: 4, min: 300000, max: 420000, rate: 0.25, quickDeduct: 31920 },
  { level: 5, min: 420000, max: 660000, rate: 0.30, quickDeduct: 52920 },
  { level: 6, min: 660000, max: 960000, rate: 0.35, quickDeduct: 85920 },
  { level: 7, min: 960000, max: Infinity, rate: 0.45, quickDeduct: 181920 }
];

// ===== 全年一次性奖金（单独计税）税率表 =====
// 以全年一次性奖金收入除以12个月得到的数额来确定适用税率和速算扣除数
const BONUS_RATES = [
  { level: 1, min: 0, max: 3000, rate: 0.03, quickDeduct: 0 },
  { level: 2, min: 3000, max: 12000, rate: 0.10, quickDeduct: 210 },
  { level: 3, min: 12000, max: 25000, rate: 0.20, quickDeduct: 1410 },
  { level: 4, min: 25000, max: 35000, rate: 0.25, quickDeduct: 2660 },
  { level: 5, min: 35000, max: 55000, rate: 0.30, quickDeduct: 4410 },
  { level: 6, min: 55000, max: 80000, rate: 0.35, quickDeduct: 7160 },
  { level: 7, min: 80000, max: Infinity, rate: 0.45, quickDeduct: 15160 }
];

// ===== 专项附加扣除标准（每月/年）=====
const SPECIAL_DEDUCTIONS = {
  children: { // 子女教育：每个子女 2000元/月
    monthly: 2000,
    note: '每个子女 2000 元/月，父母可选一方100%或双方各50%扣除'
  },
  elderly: { // 赡养老人：独生子女 3000元/月
    monthly: 3000,
    note: '独生子女 3000 元/月，非独生子女分摊不超过 1500 元/月'
  },
  housingLoan: { // 住房贷款利息：1000元/月，最长240个月
    monthly: 1000,
    maxMonths: 240,
    note: '1000 元/月，最长扣除 240 个月，与住房租金二选一'
  },
  housingRent: { // 住房租金：800-1500元/月按城市分档
    tiers: [
      { monthly: 1500, city: '直辖市/省会/计划单列市' },
      { monthly: 1100, city: '人口>100万的城市' },
      { monthly: 800, city: '其他城市' }
    ],
    note: '按城市分档：1500/1100/800 元/月，与住房贷款二选一'
  },
  continuingEducation: { // 继续教育：400元/月（学历）+ 3600元/年（职业资格）
    monthly: 400,
    annualCert: 3600,
    note: '学历(学位)教育 400 元/月；职业资格继续教育 3600 元/年'
  },
  medical: { // 大病医疗：每年最高 80000元
    annualCap: 80000,
    note: '年度自付医药费超过 15000 元的部分，据实扣除，限额 80000 元/年'
  },
  infantCare: { // 3岁以下婴幼儿照护：每个婴幼儿 2000元/月
    monthly: 2000,
    note: '每个婴幼儿 2000 元/月，父母一方100%或双方各50%'
  }
};

// ===== 个体工商户生产经营所得税率表（五级超额累进）=====
const BUSINESS_RATES = [
  { level: 1, min: 0, max: 30000, rate: 0.05, quickDeduct: 0 },
  { level: 2, min: 30000, max: 90000, rate: 0.10, quickDeduct: 1500 },
  { level: 3, min: 90000, max: 300000, rate: 0.20, quickDeduct: 10500 },
  { level: 4, min: 300000, max: 500000, rate: 0.30, quickDeduct: 40500 },
  { level: 5, min: 500000, max: Infinity, rate: 0.35, quickDeduct: 65500 }
];

// ===== 小型微利企业年应纳税所得额减半政策（2023-2027）=====
// 对小型微利企业年应纳税所得额不超过300万元的部分，减按25%计入应纳税所得额，按20%税率缴纳
// 实际税负 = 应纳税所得额 × 5%
const SME_POLICY = {
  maxIncome: 3000000,       // 年应纳税所得额上限 300万
  effectiveRate: 0.05,      // 实际综合税负 5%
  conditions: {
    employees: 300,         // 从业人数不超过300人
    assets: 50000000,       // 资产总额不超过5000万
    nonTaxableIncome: 3000000 // 年应纳税所得额≤300万
  }
};

// ===== 小规模纳税人增值税优惠（月销售额10万以下免征）=====
const VAT_SMALL_SCALE = {
  monthlyExempt: 100000,    // 月销售额 10 万以下（季度 30 万）免征增值税
  quarterlyExempt: 300000,
  reducedRate: 0.01,        // 征收率 1%（阶段性优惠）
  note: '小规模纳税人月销售额≤10万元（季度≤30万元）免征增值税'
};

// ===== 六税两费减半（小微企业/个体户）=====
const SIX_TAX_HALF = {
  note: '增值税小规模纳税人、小型微利企业、个体工商户可减半征收：资源税、城建税、房产税、城镇土地使用税、印花税、耕地占用税和教育费附加、地方教育附加',
  halfRate: 0.5
};

module.exports = {
  TAX_YEAR,
  COMPREHENSIVE_RATES,
  BONUS_RATES,
  SPECIAL_DEDUCTIONS,
  BUSINESS_RATES,
  SME_POLICY,
  VAT_SMALL_SCALE,
  SIX_TAX_HALF
};