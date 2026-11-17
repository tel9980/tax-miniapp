// 税优政策库 Worker
// 职责：抓取国家税务总局 + 广东省税务局政策 → 结构化 → 优惠判定 → 持久化到 KV → 返回 API
// 数据源：https://fgk.chinatax.gov.cn （全国）、https://guangdong.chinatax.gov.cn （广东）
// 同步机制：
//   1) cron 每天定时抓取（wrangler.toml [triggers]）
//   2) 用户访问时读 KV 秒出；KV 缺失/超过 1 小时则现场抓取兜底
//   3) /api/refresh 手动强制刷新

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

// ===== 广东省税务局政策栏目（列表为服务端渲染 HTML，直接解析 <ul class="infoList fileList">）=====
const GD_COLUMNS = [
  { path: '/gdsw/zcwj/zcwj.shtml', name: '广东·政策文件' },
  { path: '/gdsw/zxwj/zxwj.shtml', name: '广东·最新文件' },
];

// 每栏目抓取的最新条数（政策浏览只需要「最新」，抓 50 条足够覆盖近 1-2 年）
const PER_COLUMN = 50;

// KV 缓存有效期：1 小时（与定时任务频率一致）
const CACHE_TTL_MS = 3600 * 1000;

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

// 规范化原文链接：http→https，且政策法规库的 /zcfgk/ 路径域名从 www 换成 fgk
// （www.chinatax.gov.cn/zcfgk/... 是 404，正确域名是 fgk.chinatax.gov.cn）
function normalizeUrl(u) {
  u = (u || '').replace(/^http:\/\//, 'https://');
  u = u.replace(/^https:\/\/www\.chinatax\.gov\.cn\/zcfgk\//, 'https://fgk.chinatax.gov.cn/zcfgk/');
  return u;
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
    url: normalizeUrl(rec.url || ''),
    taxTypes: classifyTaxTypes(rec, meta),
    industry: meta.industrytypename || '',
    effectLevel: meta.effectlevel || columnName,
    department: meta.writtendepartment || '',
    isPreference: isPref,
    prefType,
    column: columnName,
    region: '全国',
  };
}

// ===== 广东税务局：抓取 + 解析（服务端渲染，直接解析 HTML 列表）=====
async function fetchGuangdongColumn(col) {
  const res = await fetch('https://guangdong.chinatax.gov.cn' + col.path, {
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const html = await res.text();
  const items = [];
  const re = /<li[^>]*>\s*<h4>\s*<a href="([^"]+)"(?:\s+title="([^"]*)")?[^>]*>([\s\S]*?)<\/a>\s*<span class="time">([^<]+)<\/span>\s*<\/h4>\s*<\/li>/g;
  let m;
  while ((m = re.exec(html))) {
    const href = m[1], titleAttr = m[2], inner = m[3], date = (m[4] || '').trim().replace(/[\[\]\s]/g, '');
    const fm = /<font>([\s\S]*?)<\/font>/.exec(inner);
    const title = (fm ? fm[1] : (titleAttr || inner)).replace(/<[^>]+>/g, '').trim();
    if (!title || !href || !href.includes('content_')) continue;
    items.push({ title, date, url: 'https://guangdong.chinatax.gov.cn' + href, column: col.name });
  }
  return items;
}

function parseGdRecord(item) {
  const text = item.title || '';
  const isPref = PREF_KEYWORDS.some((k) => text.includes(k));
  let prefType = '';
  if (isPref) {
    for (const [type, keys] of PREF_TYPE_RULES) {
      if (keys.some((k) => text.includes(k))) { prefType = type; break; }
    }
    if (!prefType) prefType = '其他优惠';
  }
  const hits = new Set();
  for (const [tax, keys] of TAX_TYPE_MAP) {
    if (keys.some((k) => text.includes(k))) hits.add(tax);
  }
  let h = 0;
  const s = item.url || item.title || '';
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return {
    id: 'gd-' + h.toString(36),
    title: text,
    docNo: '',
    date: item.date || '',
    url: item.url || '',
    taxTypes: hits.size ? [...hits] : ['其他'],
    industry: '',
    effectLevel: item.column || '广东',
    department: '广东省税务局',
    isPreference: isPref,
    prefType,
    column: item.column || '广东',
    region: '广东',
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

// 抓取全部（全国 + 广东，并行）→ 结构化 → 去重 → 排序
async function fetchAll() {
  // 全国（总局 fgk 接口）
  const results = await Promise.allSettled(
    COLUMNS.map((col) => fetchColumn(col.channelId, PER_COLUMN).then((recs) => recs.map((r) => parseRecord(r, col.name))))
  );
  // 广东（省局 HTML）
  const gdResults = await Promise.allSettled(
    GD_COLUMNS.map((col) => fetchGuangdongColumn(col).then((items) => items.map((it) => parseGdRecord(it))))
  );

  const all = [];
  const errors = [];
  results.forEach((r, i) => {
    if (r.status === 'fulfilled') all.push(...r.value);
    else errors.push(`${COLUMNS[i].name}: ${r.reason?.message || r.reason}`);
  });
  gdResults.forEach((r, i) => {
    if (r.status === 'fulfilled') all.push(...r.value);
    else errors.push(`${GD_COLUMNS[i].name}: ${r.reason?.message || r.reason}`);
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
  const hasNational = clean.some((p) => p.region === '全国');
  const hasGd = clean.some((p) => p.region === '广东');
  return {
    items: list,
    total: list.length,
    preferenceCount: list.filter((p) => p.isPreference).length,
    gdCount: list.filter((p) => p.region === '广东').length,
    source: clean.length ? 'chinatax' : 'seed',
    regions: [hasNational && '全国', hasGd && '广东'].filter(Boolean),
    updatedAt: new Date().toISOString(),
    errors,
    version: 'auto',
  };
}

// ===== KV 读写 =====
async function readKV(env) {
  try {
    return await env.POLICIES.get('policies', 'json');
  } catch {
    return null;
  }
}

async function writeKV(env, data) {
  try {
    await env.POLICIES.put('policies', JSON.stringify(data));
  } catch (e) {
    console.error('KV write failed:', e?.message || e);
  }
}

// 判断缓存是否仍新鲜（1 小时内）
function isFresh(data) {
  if (!data || !data.updatedAt) return false;
  return Date.now() - new Date(data.updatedAt).getTime() < CACHE_TTL_MS;
}

// ===== Worker 入口 =====
export default {
  // cron 定时任务：每天抓取最新政策 → 写 KV（配合 wrangler.toml [triggers]）
  async scheduled(event, env, ctx) {
    const data = await fetchAll();
    await writeKV(env, data);
    console.log(`[scheduled] 更新完成：${data.total} 条，优惠 ${data.preferenceCount} 条，广东 ${data.gdCount} 条`);
  },

  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // 政策列表 API（读 KV 秒出，缺失/过期则现场抓取兜底）
    if (url.pathname === '/api/policies') {
      const cached = await readKV(env);
      if (isFresh(cached)) return json(cached);
      const data = await fetchAll();
      ctx.waitUntil(writeKV(env, data));
      return json(data);
    }

    // 手动刷新（强制重新抓取 → 写 KV）
    if (url.pathname === '/api/refresh') {
      const data = await fetchAll();
      await writeKV(env, data);
      return json({ ok: true, total: data.total, preferenceCount: data.preferenceCount, gdCount: data.gdCount, source: data.source, updatedAt: data.updatedAt, errors: data.errors });
    }

    // 其余请求交给静态资产（web/）
    return env.ASSETS.fetch(request);
  },
};
