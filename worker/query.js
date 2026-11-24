// 政策列表的「查询层」：身份打包 / 本季到期 / 服务端筛选分页。
//
// 这里只放纯函数（输入政策数组，输出结果，不碰网络和 KV），
// 方便本地单测，也让 index.js 只管路由和抓取。

// ---------- 按身份打包 ----------
// 把散落在几百条里的身份相关政策按「谁来看」聚成四套。
// 匹配范围 = 标题 + 文号 + 摘要（摘要来自 enrich 的正文提炼，比标题更准）。
export const IDENTITY_PACKS = [
  {
    id: 'sme', name: '小微企业', icon: '🏭',
    desc: '小型微利企业、小规模纳税人最常用到的减免',
    keywords: ['小微', '小规模', '初创', '创业', '六税两费', '减按1%', '起征点', '小型微利', '个体工商户减半'],
  },
  {
    id: 'tech', name: '高新 / 研发', icon: '🔬',
    desc: '高新技术企业、研发费用加计扣除等科技创新优惠',
    keywords: ['研发', '加计扣除', '高新', '技术企业', '软件', '集成电路', '专利', '科技', '成果转化'],
  },
  {
    id: 'self', name: '个体户', icon: '🏪',
    desc: '个体工商户、个人独资、灵活就业人员相关优惠',
    keywords: ['个体户', '个人独资', '灵活就业', '经营所得', '个体工商户'],
  },
  {
    id: 'worker', name: '打工人', icon: '👤',
    desc: '工资薪金、年终奖、专项附加扣除等个人所得税优惠',
    keywords: ['年终奖', '一次性奖金', '专项附加', '个人养老金', '个税', '股权激励', '股息', '换购住房', '汇算', '个人所得税'],
  },
];

export function buildPacks(items) {
  return IDENTITY_PACKS.map((pack) => {
    const hits = items.filter((p) => {
      const text = `${p.title} ${p.docNo || ''} ${p.plain || ''}`;
      return pack.keywords.some((k) => text.includes(k));
    });
    return {
      id: pack.id,
      name: pack.name,
      icon: pack.icon,
      desc: pack.desc,
      count: hits.length,
      items: hits.slice(0, 30), // 每个包最多展示 30 条，避免过长
    };
  });
}

// ---------- 本季度到期清单 ----------
// 取「当前季度」内到期的政策（到期日落在本季度 1 号 ~ 季末），按到期日升序。
//
// 注意：全程用 UTC 取值 + 手工拼日期，不要用 `new Date(y, m, d).toISOString()`。
// 后者会按运行环境的时区换算，在 UTC+8 的机器上季度首日会算成前一天（如 10-01 → 09-30）。
const pad2 = (n) => String(n).padStart(2, '0');
export function quarterRange(now = new Date()) {
  const y = now.getUTCFullYear();
  const q = Math.floor(now.getUTCMonth() / 3); // 0=Q1..3=Q4
  const startMonth = q * 3 + 1;                // 1 / 4 / 7 / 10
  const endMonth = q * 3 + 3;                  // 3 / 6 / 9 / 12
  // 该季度最后一天：下个月的第 0 天
  const lastDay = new Date(Date.UTC(y, endMonth, 0)).getUTCDate();
  return {
    start: `${y}-${pad2(startMonth)}-01`,
    end: `${y}-${pad2(endMonth)}-${pad2(lastDay)}`,
    label: `${y} 年第 ${q + 1} 季度`,
  };
}

export function buildExpiring(items) {
  const { start, end, label } = quarterRange();
  const hits = items
    .filter((p) => p.expiry && p.expiry >= start && p.expiry <= end)
    .sort((a, b) => a.expiry.localeCompare(b.expiry));
  return { quarter: label, start, end, count: hits.length, items: hits };
}

// ---------- 服务端筛选 ----------
// 前端只传筛选条件 + 页码，服务端返回过滤后的切片，首屏 ~20KB 而不是 190KB。
// params 是 URLSearchParams；favOnly 需要配合 favs=逗号分隔的政策 id。
export function filterItems(items, params) {
  const q = (params.get('q') || '').trim().toLowerCase();
  const tax = params.get('tax') || '';
  const type = params.get('type') || '';
  const region = params.get('region') || '';
  const area = params.get('area') || '';
  const status = params.get('status') || '';
  const prefOnly = params.get('prefOnly');
  const newOnly = params.get('newOnly');
  const favOnly = params.get('favOnly');
  const favs = (params.get('favs') || '').split(',');
  return items.filter((p) => {
    if (prefOnly === '1' && !p.isPreference) return false;
    if (newOnly === '1' && !p.isNew) return false;
    if (favOnly === '1' && !favs.includes(p.id)) return false;
    if (region && p.region !== region) return false;
    if (area && p.area !== area) return false;
    if (status && p.status !== status) return false;
    if (tax && !(p.taxTypes || []).includes(tax)) return false;
    if (type && p.prefType !== type) return false;
    if (q && !`${p.title} ${p.docNo} ${p.plain || ''}`.toLowerCase().includes(q)) return false;
    return true;
  });
}

// ---------- 筛选维度 ----------
// 各维度的去重值 + 计数，前端用它建筛选 chips，不用加载全量数据。
export function buildFacets(items) {
  const tax = new Map(), type = new Map(), region = new Map(), area = new Map(), status = new Map();
  for (const p of items) {
    (p.taxTypes || []).forEach((t) => tax.set(t, (tax.get(t) || 0) + 1));
    if (p.prefType) type.set(p.prefType, (type.get(p.prefType) || 0) + 1);
    if (p.region) region.set(p.region, (region.get(p.region) || 0) + 1);
    if (p.area) area.set(p.area, (area.get(p.area) || 0) + 1);
    if (p.status) status.set(p.status, (status.get(p.status) || 0) + 1);
  }
  const pairs = (m, sorted) => {
    const e = [...m.entries()];
    if (sorted) e.sort((a, b) => b[1] - a[1]);
    return e.map(([k, v]) => ({ k, v }));
  };
  return {
    tax: pairs(tax, true),
    type: pairs(type, true),
    region: pairs(region, false),
    area: pairs(area, false),
    status: pairs(status, false),
  };
}

// ---------- 分页 ----------
export function paginate(items, page, size) {
  const p = Math.max(1, Number(page) || 1);
  const s = Math.min(100, Math.max(1, Number(size) || 40));
  const total = items.length;
  const start = (p - 1) * s;
  return {
    items: items.slice(start, start + s),
    total,
    prefCount: items.filter((x) => x.isPreference).length,
    page: p,
    size: s,
    totalPages: Math.ceil(total / s),
    facets: buildFacets(items),
  };
}
