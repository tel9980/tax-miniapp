// 税优政策库 Worker
// 职责：请求时抓取国家税务总局政策法规库 → 结构化 → 优惠判定 → Cache API 缓存(1h) → 返回 API
// 数据源：https://fgk.chinatax.gov.cn （官方政策法规库）
// 缓存：用 Worker 内置 Cache API（无需 KV 权限），首次访问实时抓取，之后 1 小时内命中缓存

// ===== 栏目配置：官方「政策法规库」各栏目的 channelId（UUID，从各列表页 HTML 提取）=====
const COLUMNS = [
  { code: 'c102416', name: '财税文件',         channelId: '2cb303fdee614232b79552d52bb057d6' },
  { code: 'c100012', name: '税务规范性文件',   channelId: '470b437b304f434396500a1e2edc7f28' },
  { code: 'c100006', name: '政策法规文件',     channelId: '29a88b67e4b149cfa9fac7919dfb08a5' },
  { code: 'c100009', name: '法律',             channelId: 'd34fa7ad03f84f4caed12f5c2beae099' },
  { code: 'c100010', name: '行政法规',         channelId: 'e1cd1569d1ea4a25a11041248925a081' },
  { code: 'c102440', name: '国务院文件',       channelId: 'fa1726b47078490fa0a4522194185e8d' },
  { code: 'c100013', name: '其他文件',         channelId: '4c1a5be62f6d44d48f386f630dcebbc5' },
  { code: 'c102424', name: '工作通知',         channelId: '7778c3a40a344de3a36ca88a2548f5f8' },
];

// 每栏目抓取的最新条数（政策浏览只需要「最新」，抓 50 条足够覆盖近 1-2 年）
const PER_COLUMN = 50;

// ===== 优惠判定关键词（标题/文号命中即视为「税收优惠」政策）=====
const PREF_KEYWORDS = [
  '免征', '免税', '减征', '减半', '减按', '降税率', '降低税率', '减税',
  '退税', '即征即退', '先征后返', '留抵退税', '加计扣除', '抵免', '减免',
  '优惠', '零税率', '税收返还',
];

// 优惠类型 → 关键词
const PREF_TYPE_RULES = [
  ['免税', ['免征', '免税', '零税率']],
  ['减税', ['减征', '减半', '减按', '降税率', '降低税率', '减税']],
  ['退税', ['退税', '即征即退', '先征后返', '留抵退税']],
  ['扣除抵免', ['加计扣除', '抵免']],
  ['减免优惠', ['减免', '优惠', '税收返还']],
];

// 税种归一化映射（从官方 taxpolicy / labels 提取）
const TAX_TYPE_MAP = [
  ['增值税', ['增值税']],
  ['消费税', ['消费税']],
  ['企业所得税', ['企业所得税', '所得税']],
  ['个人所得税', ['个人所得税']],
  ['关税及进出口', ['进出口', '关税', '进口']],
  ['房产税', ['房产税']],
  ['城镇土地使用税', ['城镇土地使用税']],
  ['土地增值税', ['土地增值税']],
  ['车辆购置税', ['车辆购置税']],
  ['车船税', ['车船税']],
  ['印花税', ['印花税']],
  ['契税', ['契税']],
  ['资源税', ['资源税']],
  ['环境保护税', ['环境保护税', '环保税']],
];

// 内置兜底数据（抓取失败时用），保证站点永远有内容
const SEED_POLICIES = [
  { id: 'seed-vat-small', title: '小规模纳税人免征增值税（月销售额10万元以下）', docNo: '财政部 税务总局公告2023年第19号', date: '2023-08-01', url: 'https://fgk.chinatax.gov.cn/', taxTypes: ['增值税'], industry: '社会民生', effectLevel: '财税文件', department: '财政部,国家税务总局', isPreference: true, prefType: '免税', column: '内置兜底' },
  { id: 'seed-sme', title: '小型微利企业减按25%计入应纳税所得额，按20%税率缴纳企业所得税', docNo: '财政部 税务总局公告2023年第12号', date: '2023-03-26', url: 'https://fgk.chinatax.gov.cn/', taxTypes: ['企业所得税'], industry: '社会民生', effectLevel: '财税文件', department: '财政部,国家税务总局', isPreference: true, prefType: '减税', column: '内置兜底' },
  { id: 'seed-rd', title: '研发费用税前加计扣除比例提高至100%', docNo: '财政部 税务总局公告2023年第7号', date: '2023-03-26', url: 'https://fgk.chinatax.gov.cn/', taxTypes: ['企业所得税'], industry: '科技创新', effectLevel: '财税文件', department: '财政部,国家税务总局', isPreference: true, prefType: '扣除抵免', column: '内置兜底' },
  { id: 'seed-six', title: '增值税小规模纳税人、小型微利企业和个体工商户减半征收"六税两费"', docNo: '财政部 税务总局公告2023年第12号', date: '2023-03-26', url: 'https://fgk.chinatax.gov.cn/', taxTypes: ['其他'], industry: '社会民生', effectLevel: '财税文件', department: '财政部,国家税务总局', isPreference: true, prefType: '减税', column: '内置兜底' },
];

// ===== 工具函数 =====
function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'no-store',
    },
  });
}

// 从 domainMetaList 提取元数据 → key:value
function extractMeta(rec) {
  const meta = {};
  for (const dm of rec.domainMetaList || []) {
    for (const it of dm.resultList || []) {
      if (it.value) meta[it.key] = it.value;
    }
  }
  return meta;
}

// 提取税种（从 taxpolicy / labels，可能带"税收政策-"前缀）
function classifyTaxTypes(rec, meta) {
  const raw = [meta.taxpolicy || '', meta.labels || ''].join(',');
  const hits = new Set();
  for (const [tax, keys] of TAX_TYPE_MAP) {
    if (keys.some((k) => raw.includes(k))) hits.add(tax);
  }
  const title = rec.title || '';
  for (const [tax, keys] of TAX_TYPE_MAP) {
    if (keys.some((k) => title.includes(k))) hits.add(tax);
  }
  return hits.size ? [...hits] : ['其他'];
}

// 判定是否「税收优惠」+ 优惠类型
function classifyPreference(rec, meta) {
  const text = `${rec.title || ''} ${meta.writtentext || ''} ${meta.taxpolicy || ''} ${meta.labels || ''}`;
  const isPref = PREF_KEYWORDS.some((k) => text.includes(k));
  let prefType = '';
  if (isPref) {
    for (const [type, keys] of PREF_TYPE_RULES) {
      if (keys.some((k) => text.includes(k))) { prefType = type; break; }
    }
    if (!prefType) prefType = '其他优惠';
  }
  return { isPref, prefType };
}

// 生成稳定 id（优先取原文链接里的 c 编号）
function genId(rec) {
  const m = /\/c(\d+)\/content\.html/.exec(rec.url || '');
  if (m) return m[1];
  let h = 0;
  const s = rec.url || rec.title || '';
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return 'h' + h.toString(36);
}

// 解析单条原始记录 → 政策条目
function parseRecord(rec, columnName) {
  const meta = extractMeta(rec);
  const { isPref, prefType } = classifyPreference(rec, meta);
  return {
    id: genId(rec),
    title: (rec.title || '').trim(),
    docNo: meta.writtentext || '',
    date: meta.writtendate || (rec.publishedTimeStr || '').slice(0, 10),
    url: (rec.url || '').replace(/^http:\/\//, 'https://'),
    taxTypes: classifyTaxTypes(rec, meta),
    industry: meta.industrytypename || '',
    effectLevel: meta.effectlevel || columnName,
    department: meta.writtendepartment || '',
    isPreference: isPref,
    prefType,
    column: columnName,
  };
}

// 抓取单个栏目
async function fetchColumn(channelId, size) {
  const body = new URLSearchParams({
    codeId: '',
    channelId,
    page: '1',
    size: String(size),
  });
  const res = await fetch('https://www.chinatax.gov.cn/getFileListByCodeId', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
      'Referer': 'https://fgk.chinatax.gov.cn/zcfgk/',
      'X-Requested-With': 'XMLHttpRequest',
    },
    body,
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  return data?.results?.data?.results || [];
}

// 抓取全部栏目（并行）→ 结构化 → 去重 → 排序
async function fetchAll() {
  const results = await Promise.allSettled(
    COLUMNS.map((col) => fetchColumn(col.channelId, PER_COLUMN).then((recs) => recs.map((r) => parseRecord(r, col.name))))
  );
  const all = [];
  const errors = [];
  results.forEach((r, i) => {
    if (r.status === 'fulfilled') all.push(...r.value);
    else errors.push(`${COLUMNS[i].name}: ${r.reason?.message || r.reason}`);
  });

  const seen = new Set();
  const dedup = [];
  for (const p of all) {
    if (seen.has(p.id)) continue;
    seen.add(p.id);
    dedup.push(p);
  }
  dedup.sort((a, b) => (b.date || '').localeCompare(a.date || ''));
  const clean = dedup.filter((p) => p.title && p.url);

  const list = clean.length ? clean : SEED_POLICIES;
  return {
    items: list,
    total: list.length,
    preferenceCount: list.filter((p) => p.isPreference).length,
    source: clean.length ? 'chinatax' : 'seed',
    updatedAt: new Date().toISOString(),
    errors,
    version: 'auto',
  };
}

// ===== Worker 入口 =====
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // 政策列表 API（带 Cache API 缓存）
    if (url.pathname === '/api/policies') {
      const cache = caches.default;
      const cacheKey = new Request(url.origin + '/__policies__', { method: 'GET' });
      const hit = await cache.match(cacheKey);
      if (hit) return hit; // 缓存命中直接返回（headers 已在 put 时带 Cache-Control）
      const data = await fetchAll();
      const resp = json(data);
      resp.headers.set('Cache-Control', 'public, max-age=3600');
      ctx.waitUntil(cache.put(cacheKey, resp.clone()));
      return resp;
    }

    // 手动刷新（刷新缓存）
    if (url.pathname === '/api/refresh') {
      const data = await fetchAll();
      const cache = caches.default;
      const cacheKey = new Request(url.origin + '/__policies__', { method: 'GET' });
      const resp = json(data);
      resp.headers.set('Cache-Control', 'public, max-age=3600');
      await cache.put(cacheKey, resp.clone());
      return json({ ok: true, total: data.total, preferenceCount: data.preferenceCount, source: data.source, updatedAt: data.updatedAt, errors: data.errors });
    }

    // 其余请求交给静态资产（web/）
    return env.ASSETS.fetch(request);
  },
};
