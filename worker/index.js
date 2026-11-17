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

// ===== 广东区域优惠核心（横琴/前海/南沙/大湾区，财税文件稳定、总局法规库收录不全，硬编码兜底）=====
// 说明：这些是广东本地税收优惠的「精华」，由财政部/税务总局统一发文、针对特定区域，
// 总局 fgk 的栏目分页与全文搜索对这部分收录不完整，因此内置保证专题一定展示核心内容。
const REGIONAL_SEED = [
  { id: 'seed-hq-cit15', title: '横琴粤澳深度合作区符合条件的产业企业减按15%税率征收企业所得税', docNo: '财税〔2022〕19号', date: '2022-01-27', url: 'https://fgk.chinatax.gov.cn/zcfgk/', taxTypes: ['企业所得税'], effectLevel: '财税文件', department: '财政部,国家税务总局', isPreference: true, prefType: '减税', region: '广东', area: '横琴', summary: '对设在横琴粤澳深度合作区、符合《横琴粤澳深度合作区企业所得税优惠目录》的产业企业（旅游业、现代服务业、高新技术产业等），减按15%的税率征收企业所得税。' },
  { id: 'seed-qh-cit15', title: '前海深港现代服务业合作区符合条件的企业减按15%税率征收企业所得税', docNo: '财税〔2021〕30号', date: '2021-06-07', url: 'https://fgk.chinatax.gov.cn/zcfgk/', taxTypes: ['企业所得税'], effectLevel: '财税文件', department: '财政部,国家税务总局', isPreference: true, prefType: '减税', region: '广东', area: '前海', summary: '对设在前海深港现代服务业合作区、符合《前海深港现代服务业合作区企业所得税优惠目录》的企业，减按15%的税率征收企业所得税。' },
  { id: 'seed-ns-cit15', title: '广州南沙先行启动区符合条件的鼓励类产业企业减按15%税率征收企业所得税', docNo: '财税〔2022〕40号', date: '2022-09-30', url: 'https://fgk.chinatax.gov.cn/zcfgk/', taxTypes: ['企业所得税'], effectLevel: '财税文件', department: '财政部,国家税务总局', isPreference: true, prefType: '减税', region: '广东', area: '南沙', summary: '对设在南沙先行启动区（南沙湾、庆盛枢纽、南沙枢纽三个区块）符合条件的鼓励类产业企业，减按15%的税率征收企业所得税。' },
  { id: 'seed-dwq-iit', title: '粤港澳大湾区境外高端人才和紧缺人才个人所得税税负超15%部分免征', docNo: '财税〔2023〕25号', date: '2023-08-18', url: 'https://fgk.chinatax.gov.cn/zcfgk/c102416/c5211530/content.html', taxTypes: ['个人所得税'], effectLevel: '财税文件', department: '财政部,税务总局', isPreference: true, prefType: '免税', region: '广东', area: '大湾区', summary: '对在粤港澳大湾区（珠三角九市）工作的境外（含港澳台）高端人才和紧缺人才，其个人所得税税负超过15%的部分给予财政补贴、予以免征。原政策财税〔2019〕31号，本文件延续至2027年底。' },
  { id: 'seed-hq-iit15', title: '横琴粤澳深度合作区高端人才和紧缺人才个人所得税税负超15%部分免征', docNo: '财税〔2022〕3号', date: '2022-01-27', url: 'https://fgk.chinatax.gov.cn/zcfgk/', taxTypes: ['个人所得税'], effectLevel: '财税文件', department: '财政部,税务总局', isPreference: true, prefType: '免税', region: '广东', area: '横琴', summary: '对在横琴粤澳深度合作区工作的境内外高端人才和紧缺人才，其个人所得税税负超过15%的部分予以免征。' },
  { id: 'seed-qh-iit15', title: '前海深港现代服务业合作区境外高端和紧缺人才个人所得税税负超15%部分免征', docNo: '财税〔2021〕29号', date: '2021-06-01', url: 'https://fgk.chinatax.gov.cn/zcfgk/', taxTypes: ['个人所得税'], effectLevel: '财税文件', department: '财政部,税务总局', isPreference: true, prefType: '免税', region: '广东', area: '前海', summary: '对在前海深港现代服务业合作区工作的境外高端人才和紧缺人才，其个人所得税税负超过15%的部分给予财政补贴、予以免征。' },
  { id: 'seed-ns-iit15', title: '广州南沙港澳居民个人所得税税负超15%部分免征', docNo: '财税〔2022〕29号', date: '2022-09-01', url: 'https://fgk.chinatax.gov.cn/zcfgk/', taxTypes: ['个人所得税'], effectLevel: '财税文件', department: '财政部,税务总局', isPreference: true, prefType: '免税', region: '广东', area: '南沙', summary: '对在广州南沙工作的港澳居民，其个人所得税税负超过港澳税负（15%）的部分予以免征。' },
];

// ===== 区域关键词 → 用总局全文搜索接口自动补充最新区域政策 =====
const REGIONAL_KEYWORDS = [
  { kw: '横琴', area: '横琴' },
  { kw: '前海', area: '前海' },
  { kw: '南沙', area: '南沙' },
  { kw: '粤港澳大湾区', area: '大湾区' },
  { kw: '河套深港', area: '河套' },
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

// ===== 政策有效期解析（从标题/摘要提取截止日期，只标「能确定的」，不猜）=====
function parseExpiry(text, date) {
  if (!text) return null;
  let m;
  // 1. 「至/到/截止/有效期…YYYY年MM月DD日」→ 明确截止日
  m = text.match(/(?:至|到|截止|有效期|执行至|延续至|延长至|延至|延续到|延长到)\s*(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日/);
  if (m) return `${m[1]}-${String(m[2]).padStart(2, '0')}-${String(m[3]).padStart(2, '0')}`;
  // 2. 「至/到/截止…YYYY年底」→ 该年 12 月 31 日
  m = text.match(/(?:至|到|截止|有效期|延续至|延长至|延至|执行至)\s*(\d{4})\s*年\s*底/);
  if (m) return `${m[1]}-12-31`;
  // 3. 「延续实施/继续实施/延长…YYYY年」（默认年底，常见于延续类文件标题）
  m = text.match(/(?:延续实施|延续执行|继续实施|继续执行|延长实施|延长执行)\s*(?:至|到)?\s*(\d{4})\s*年/);
  if (m && +m[1] >= 2000 && +m[1] <= 2100) return `${m[1]}-12-31`;
  // 4. 相对有效期：「有效期 X 年」（以成文日期为起点推算）
  m = text.match(/有效期\s*(\d{1,2})\s*年/);
  if (m && date) {
    const start = new Date(date);
    if (!isNaN(start)) {
      const end = new Date(Date.UTC(start.getUTCFullYear() + (+m[1]), start.getUTCMonth(), start.getUTCDate()));
      return end.toISOString().slice(0, 10);
    }
  }
  return null;
}

// 判定状态：已到期 / 即将到期（半年内）/ 生效中 / 未标注
function judgeStatus(expiryStr) {
  if (!expiryStr) return { expiry: null, status: '未标注' };
  const exp = new Date(expiryStr);
  if (isNaN(exp)) return { expiry: expiryStr, status: '未标注' };
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const days = Math.round((exp - today) / 86400000);
  if (days < 0) return { expiry: expiryStr, status: '已到期' };
  if (days <= 180) return { expiry: expiryStr, status: '即将到期' };
  return { expiry: expiryStr, status: '生效中' };
}

// 合并有效期信息到政策条目
function withExpiry(rec, text, date) {
  const { expiry, status } = judgeStatus(parseExpiry(text, date));
  rec.expiry = expiry;
  rec.status = status;
  return rec;
}

// 解析单条原始记录 → 政策条目
function parseRecord(rec, columnName) {
  const meta = extractMeta(rec);
  const { isPref, prefType } = classifyPreference(rec, meta);
  const title = (rec.title || '').trim();
  const date = meta.writtendate || (rec.publishedTimeStr || '').slice(0, 10);
  const out = withExpiry({
    id: genId(rec),
    title,
    docNo: meta.writtentext || '',
    date,
    url: normalizeUrl(rec.url || ''),
    taxTypes: classifyTaxTypes(rec, meta),
    industry: meta.industrytypename || '',
    effectLevel: meta.effectlevel || columnName,
    department: meta.writtendepartment || '',
    isPreference: isPref,
    prefType,
    column: columnName,
    region: '全国',
  }, `${title} ${meta.writtentext || ''} ${meta.summary || ''}`, date);
  // 官方元数据给了「废止日期」→ 优先标已废止（比有效期更准确）
  // 注意：官方 abolishdate 对未废止政策返回空串或字面量 "null"，需排除
  const abolish = (meta.abolishdate || '').trim();
  if (abolish && abolish !== 'null') {
    out.status = '已废止';
    out.expiry = abolish;
  }
  return out;
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
  return withExpiry({
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
  }, text, item.date || '');
}

// ===== 总局全文搜索接口：按区域关键词自动补充最新区域政策 =====
// 接口：https://www.chinatax.gov.cn/search5/search/s（GET，返回 JSON searchResultAll.searchTotal）
function parseSearchRecord(item, area) {
  const title = (item.title || '').replace(/<[^>]+>/g, '').trim();
  if (!title || !item.url) return null;
  // 过滤搜索噪音：标题必须命中区域关键词
  const kw = area === '大湾区' ? ['大湾区', '粤港澳', '港澳'] : [area];
  if (!kw.some((k) => title.includes(k))) return null;
  const taxDiscount = Array.isArray(item.xxgk_taxDiscount) ? item.xxgk_taxDiscount.join(',') : (item.xxgk_taxDiscount || '');
  const taxPolicy = Array.isArray(item.xxgk_taxPolicy) ? item.xxgk_taxPolicy.join(',') : (item.xxgk_taxPolicy || '');
  const text = `${title} ${taxDiscount} ${taxPolicy}`;
  const isPref = PREF_KEYWORDS.some((k) => text.includes(k)) || !!taxDiscount;
  let prefType = '';
  if (isPref) {
    for (const [type, keys] of PREF_TYPE_RULES) {
      if (keys.some((k) => text.includes(k))) { prefType = type; break; }
    }
    if (!prefType) prefType = '其他优惠';
  }
  const hits = new Set();
  for (const [tax, keys] of TAX_TYPE_MAP) {
    if (keys.some((k) => `${taxPolicy} ${title}`.includes(k))) hits.add(tax);
  }
  const docNoRaw = (item.govDoc && item.govDoc.docNum) || item.indexno || '';
  const date = (item.cwrq || '').slice(0, 10);
  return withExpiry({
    id: genId({ url: item.url }),
    title,
    docNo: Array.isArray(docNoRaw) ? docNoRaw[0] : String(docNoRaw),
    date,
    url: normalizeUrl(item.url || ''),
    taxTypes: hits.size ? [...hits] : ['其他'],
    industry: item.xxgk_industryType || '',
    effectLevel: item.xxgk_effectLevel || item.label || '财税文件',
    department: (item.pubName || '').replace(/,/g, '、'),
    isPreference: isPref,
    prefType,
    column: '区域政策',
    region: '广东',
    area,
  }, `${title} ${item.govDoc && item.govDoc.docNum || ''}`, date);
}

async function fetchRegionalByKeyword(item) {
  const p = new URLSearchParams({
    searchWord: item.kw,
    siteCode: 'bm29000002',
    pageSize: '20',
    pageNum: '0',
    orderBy: '4',
    column: '政策法规,政策解读',
    label: '文字政策解读,法律,行政法规及国务院文件,税务部门规章,税务规范性文件,财税文件,其他文件',
    searchSiteName: 'GSFFK',
  });
  const res = await fetch('https://www.chinatax.gov.cn/search5/search/s?' + p.toString(), {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
      'Referer': 'https://fgk.chinatax.gov.cn/zcfgk/',
    },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const j = await res.json();
  const list = j?.searchResultAll?.searchTotal || [];
  return list.map((it) => parseSearchRecord(it, item.area)).filter(Boolean);
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

// 抓取全部（全国 + 广东 + 区域搜索，并行）→ 结构化 → 去重 → 排序
async function fetchAll() {
  // 全国（总局 fgk 接口）
  const results = await Promise.allSettled(
    COLUMNS.map((col) => fetchColumn(col.channelId, PER_COLUMN).then((recs) => recs.map((r) => parseRecord(r, col.name))))
  );
  // 广东（省局 HTML）
  const gdResults = await Promise.allSettled(
    GD_COLUMNS.map((col) => fetchGuangdongColumn(col).then((items) => items.map((it) => parseGdRecord(it))))
  );
  // 区域优惠（总局全文搜索接口，按横琴/前海/南沙/大湾区/河套关键词补充最新政策）
  const regionalResults = await Promise.allSettled(
    REGIONAL_KEYWORDS.map((item) => fetchRegionalByKeyword(item))
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
  regionalResults.forEach((r, i) => {
    if (r.status === 'fulfilled') all.push(...r.value);
    else errors.push(`区域-${REGIONAL_KEYWORDS[i].kw}: ${r.reason?.message || r.reason}`);
  });

  // 广东区域优惠核心 seed 始终并入（保证专题一定展示核心政策）
  // 广东区域优惠核心 seed 始终并入（保证专题一定展示核心政策），并补有效期状态
  all.push(...REGIONAL_SEED.map((p) => withExpiry({ ...p }, `${p.title} ${p.summary || ''}`, p.date)));

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
  const hasNational = list.some((p) => p.region === '全国');
  const hasGd = list.some((p) => p.region === '广东');
  const areas = [...new Set(list.filter((p) => p.area).map((p) => p.area))];
  return {
    items: list,
    total: list.length,
    preferenceCount: list.filter((p) => p.isPreference).length,
    gdCount: list.filter((p) => p.region === '广东').length,
    regionalCount: list.filter((p) => p.area).length,
    source: clean.length ? 'chinatax' : 'seed',
    regions: [hasNational && '全国', hasGd && '广东'].filter(Boolean),
    areas,
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
