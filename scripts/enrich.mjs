// 离线批量补全：把 CF Worker 干不动的「抓正文」搬到本机跑。
//
// 背景：CF Worker 免费计划 CPU 约 10ms，一次请求最多只能抓十几篇详情页，
// 所以线上有 300+ 条政策没有有效期、50+ 条优惠只有模板拼接的假摘要。
// 本机 Node 没有这个限制，跑一次把结果写进 KV 的 `enrich` 键，
// Worker 每次 fetchAll 时读出来套用 —— 每天 cron 重抓也不会覆盖掉。
//
// 用法：
//   node scripts/enrich.mjs                # 全量
//   node scripts/enrich.mjs --limit 30     # 只跑前 30 条（调试用）
//   node scripts/enrich.mjs --only-missing # 只补「没有文号或没有真摘要」的
// 产出：data/enrich.json，随后用 wrangler kv key put 推到 KV（见文件末尾提示）

import { writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { extractBody } from '../worker/detail.js';

const API = process.env.API_BASE || 'https://jy.1211.cc.cd';
const CONC = Number(process.env.CONC || 4);
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const args = process.argv.slice(2);
const LIMIT = Number((args.find((a) => a.startsWith('--limit=')) || '').split('=')[1] || 0);
const ONLY_MISSING = args.includes('--only-missing');

const TODAY = new Date().toISOString().slice(0, 10);

// ---------- 从正文里提炼文号 ----------
function pickDocNo(html, paragraphs) {
  // 优先用「页面首部」的文字（发文字号一般在标题下方），避免抓到正文里引用的其他文件号
  const headText = String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .slice(0, 2000);

  // ① 部门公告式：财政部 税务总局 工业和信息化部公告2023年第10号
  let m = headText.match(/[\u4e00-\u9fa5、]{2,30}(?:\s+[\u4e00-\u9fa5、]{2,30}){0,4}公告\s*(\d{4})\s*年\s*第\s*(\d+)\s*号/);
  if (m) return trimDocPrefix(m[0]);
  // ② 括号式公告：广东省第十三届人民代表大会常务委员会公告（第41号）/ 公告(第5号)
  m = headText.match(/[\u4e00-\u9fa5、]{2,40}(?:\s+[\u4e00-\u9fa5、]{2,40}){0,3}公告\s*[（(]\s*第\s*(\d+)\s*号\s*[）)]/);
  if (m) return m[0].replace(/\s+/g, '');
  // ③ 文号式：财税〔2022〕19号 / 税务总局公告2023年第14号 / 粤财税〔2026〕1号 / 国发〔2023〕7号
  m = headText.match(/[\u4e00-\u9fa5]{2,10}\s*[〔\[]\s*(\d{4})\s*[〕\]]\s*(\d+)\s*号/);
  if (m) return m[0].replace(/\s+/g, '');
  // ④ 兜底：正文前几段里找（有些页面把文号放在正文开头）
  const bodyHead = paragraphs.slice(0, 4).join(' ');
  m = bodyHead.match(/[\u4e00-\u9fa5]{2,10}\s*[〔\[]\s*(\d{4})\s*[〕\]]\s*(\d+)\s*号/);
  if (m) return m[0].replace(/\s+/g, '');
  // ⑤ 兜底②：正文前几段里的括号式公告
  m = bodyHead.match(/[\u4e00-\u9fa5、]{2,40}公告\s*[（(]\s*第\s*(\d+)\s*号\s*[）)]/);
  if (m) return m[0].replace(/\s+/g, '');
  return '';
}

// 从「xxx 公告2026年第29号」里剥掉混进来的标题片段，只留发文机关
function trimDocPrefix(full) {
  const m = full.match(/^(.*?)\s*公告\s*(\d{4})\s*年\s*第\s*(\d+)\s*号$/);
  if (!m) return full.replace(/\s+/g, ' ').trim();
  const tokens = m[1].trim().split(/\s+/).filter(Boolean);
  const keep = [];
  // 从右往左收，遇到标题特征词（关于/的/通知/文件…）就停
  for (let i = tokens.length - 1; i >= 0; i--) {
    const t = tokens[i];
    if (t.length > 14 || /关于|的|通知|解读|目录|文件|意见|办法|规定|清单/.test(t)) break;
    keep.unshift(t);
  }
  // 不再按「部/局」后缀过滤：会漏掉「中国国家铁路集团有限公司」这类主体
  const head = keep.join(' ');
  return `${head}公告${m[2]}年第${m[3]}号`.replace(/\s+/g, ' ').trim();
}

// ---------- 从正文里提炼有效期（取文中出现的最晚截止日） ----------
// 对齐 worker/index.js 的 parseExpiry 正则，覆盖尽可能多的表述模式。
function pickExpiry(paragraphs, title, plain, date) {
  const text = paragraphs.join(' ') + ' ' + (title || '') + ' ' + (plain || '');
  const ends = [];
  let m;
  // ① 明确截止日：「至2027年12月31日」「有效期至2026年6月30日」
  const re1 = /(?:至|到|截止|执行至|延续至|延长至|延至|有效期至|有效期到|执行到)\s*(\d{4})\s*年\s*(?:(\d{1,2})\s*月\s*(\d{1,2})\s*日|底)/g;
  while ((m = re1.exec(text))) {
    const y = m[1];
    const mo = m[2] ? String(m[2]).padStart(2, '0') : '12';
    const d = m[3] ? String(m[3]).padStart(2, '0') : '31';
    ends.push(`${y}-${mo}-${d}`);
  }
  // ② 「延续实施至2027年」「继续执行到2026年」→ 年底
  const re2 = /(?:延续实施|延续执行|继续实施|继续执行|延长实施|延长执行|延续至|延长至|延至)\s*(?:至|到)?\s*(\d{4})\s*年/g;
  while ((m = re2.exec(text))) {
    if (+m[1] >= 2000 && +m[1] <= 2100) ends.push(`${m[1]}-12-31`);
  }
  // ③ 范围式：「2026—2027年」「2025年度—2027年度」→ 取结束年 12-31
  const re3 = /(\d{4})\s*(?:年(?:度)?)?\s*[—–\-~至到]\s*(\d{4})\s*年/g;
  while ((m = re3.exec(text))) {
    if (+m[2] > +m[1] && +m[2] >= 2024 && +m[2] <= 2035) ends.push(`${m[2]}-12-31`);
  }
  // ④ 「有效期X年」→ 以成文日期为起点推算（没有成文日期就用今年兜底）
  const re4 = /有效期\s*(\d{1,2})\s*年/g;
  const baseYear =
    date && /^\d{4}/.test(String(date)) ? Number(String(date).slice(0, 4)) : new Date().getFullYear();
  while ((m = re4.exec(text))) {
    const y = baseYear + (+m[1]);
    if (y <= 2035) ends.push(`${y}-12-31`);
  }
  // ⑤ 规划期：「十五五」→2030-12-31、「十四五」→2025-12-31（仅税收语境）
  const taxCtx = /税收|税费|减免|优惠|扣除|退税|免征|抵免|税率/.test(text);
  if (taxCtx && text.includes('十五五')) ends.push('2030-12-31');
  if (taxCtx && text.includes('十四五')) ends.push('2025-12-31');

  if (!ends.length) {
    // 没有明确截止日时，识别「长期」表述 —— 只认正文里明确的字面说法，不猜测
    if (/长期有效|长期执行|长期实施|长期适用|有效期\s*长期/.test(text)) return '长期';
    return '';
  }
  ends.sort();
  const max = ends[ends.length - 1];
  // 只填「还没到期」的：正文里提到历史日期时不乱标
  if (max < TODAY) return '';
  if (max > '2035-12-31') return '';
  return max;
}

// ---------- 从正文里提炼一句话摘要 ----------
const TPL_TAIL = '具体条件与操作以原文为准。';
function pickPlain(paragraphs, title) {
  const clean = paragraphs
    .map((t) => t.replace(/\s+/g, ' ').trim())
    .filter((t) => t.length >= 24 && t !== title && !/^[\d一二三四五六七八九十]+[、.]/.test(t.slice(0, 3)))
    // 纯引用段（罗列一串《…》）不是摘要
    .filter((t) => (t.match(/《/g) || []).length <= 2)
    // 「关于《某文件》的解读/说明」这类尾巴段落不是摘要
    .filter((t) => !/^关于?《[^》]{6,}》的?(解读|说明|答记者问|政策解读)[。.]?$/.test(t))
    .filter((t) => !/^(解读|政策解读|相关解读)[：:]/.test(t));

  const finish = (t) => {
    let s = t.replace(/\s+/g, ' ').trim();
    // 去掉「…如下：。」这类标点重复
    s = s.replace(/[：:]\s*[。.]?$/, '。').replace(/[。.]{2,}$/, '。');
    if (s.length > 110) {
      s = s.slice(0, 110);
      const cut = Math.max(s.lastIndexOf('，'), s.lastIndexOf('。'), s.lastIndexOf('；'));
      if (cut > 60) s = s.slice(0, cut);
      s = s.replace(/[，；]?$/, '') + '…';
    }
    if (!/[。！？…]$/.test(s)) s += '。';
    return s.replace(/[：:]\s*。$/, '。');
  };

  // 公文开头有固定套路，按「为…」>「现就/现将…」>「根据…」的优先级挑一句最像摘要的
  for (const re of [/^为/, /^(现就|现将)/, /^(根据|按照|依据|经国务院)/]) {
    const hit = clean.find((t) => re.test(t));
    if (hit) return finish(hit);
  }
  return clean[0] ? finish(clean[0]) : '';
}

// ---------- 抓一篇 ----------
async function enrichOne(item, attempt = 0) {
  const res = await fetch(item.url, {
    headers: { 'User-Agent': UA, Referer: 'https://fgk.chinatax.gov.cn/zcfgk/' },
    redirect: 'follow',
  });
  // 官网会对高频访问限流（429/403/5xx）：退避重试，别把限流当成「这条没内容」
  if (!res.ok && [403, 429, 500, 502, 503, 504].includes(res.status) && attempt < 2) {
    await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
    return enrichOne(item, attempt + 1);
  }
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const html = await res.text();
  const paragraphs = extractBody(html);
  if (!paragraphs.length) throw new Error('empty body');

  const out = {};
  const docNo = pickDocNo(html, paragraphs);
  if (docNo) out.docNo = docNo;
  // 标题本身就是「关于…的公告」，正文首段才是真摘要
  const plain = pickPlain(paragraphs, item.title);
  if (plain && plain.length >= 24 && !plain.includes(TPL_TAIL)) out.plain = plain;
  // 有效期：正文 + 标题 + 摘要一起找，覆盖更全（很多文件的期限只写在标题里）
  const expiry = pickExpiry(paragraphs, item.title, out.plain || '', item.date);
  if (expiry) out.expiry = expiry;
  return out;
}

// ---------- 主流程 ----------
async function main() {
  console.log('读取线上政策列表 …');
  // 必须带 all=1：/api/policies 默认只返第 1 页
  const r = await fetch(API + '/api/policies?all=1');
  const data = await r.json();
  let items = data.items || [];
  console.log('共', items.length, '条');

  if (ONLY_MISSING) {
    items = items.filter((p) => !p.docNo || !p.plain || p.plain.includes(TPL_TAIL) || p.status === '未标注');
    console.log('只补缺失项：', items.length, '条');
  }
  if (LIMIT) items = items.slice(0, LIMIT);

  const map = {};
  let ok = 0,
    fail = 0,
    gotDoc = 0,
    gotExp = 0,
    gotPlain = 0;
  const queue = items.slice();
  const t0 = Date.now();

  async function worker() {
    while (queue.length) {
      const p = queue.shift();
      const idx = items.length - queue.length;
      if (!p.url) {
        continue;
      }
      try {
        const e = await enrichOne(p);
        if (e.docNo || e.expiry || e.plain) {
          map[p.id] = e;
          if (e.docNo) gotDoc++;
          if (e.expiry) gotExp++;
          if (e.plain) gotPlain++;
          ok++;
        }
      } catch (err) {
        fail++;
        if (fail <= 5) console.warn('  ✗', p.title.slice(0, 30), '→', err.message);
      }
      if (idx % 25 === 0 || queue.length === 0) {
        const el = ((Date.now() - t0) / 1000).toFixed(0);
        console.log(`  进度 ${idx}/${items.length}  成功 ${ok} 失败 ${fail}  ${el}s`);
      }
      await new Promise((res2) => setTimeout(res2, 120));
    }
  }

  await Promise.all(Array.from({ length: CONC }, worker));

  // 失败保护：整批大面积失败（官网限流/改版）时不要覆盖已有的好数据
  const rate = items.length ? ok / items.length : 0;
  if (items.length > 20 && rate < 0.6) {
    console.error('');
    console.error(`✗ 成功率只有 ${(rate * 100).toFixed(0)}%（${ok}/${items.length}），大概率被限流。`);
    console.error('  为避免覆盖已有的好数据，本次不写入 data/enrich.json。');
    console.error('  稍等几分钟再跑，或用 CONC=1 降低并发。');
    process.exit(2);
  }

  // 合并写回：--only-missing 只跑部分条目，必须与现有 enrich.json 合并，
  // 否则会把上次跑出来的其他条目整份覆盖掉（曾经踩过这个坑）。
  //
  // 注意：按 id 做「字段级合并」而不是整条替换 —— 某次重抓若只拿到 expiry 没拿到 plain，
  // 整条替换会把上次的好摘要弄丢。新值优先，旧值兜底。
  let merged = {};
  let baseCount = 0;
  try {
    const prev = JSON.parse(readFileSync('data/enrich.json', 'utf8'));
    if (prev && prev.map && typeof prev.map === 'object') {
      merged = { ...prev.map };
      baseCount = Object.keys(prev.map).length;
    }
  } catch (e) {
    // 首次运行没有旧文件，直接用新结果
  }
  for (const [id, nv] of Object.entries(map)) {
    merged[id] = { ...(merged[id] || {}), ...nv };
  }

  const vals = Object.values(merged);
  const payload = {
    map: merged,
    updatedAt: new Date().toISOString(),
    stats: {
      runScanned: items.length,
      runOk: ok,
      runFail: fail,
      runDocNo: gotDoc,
      runExpiry: gotExp,
      runPlain: gotPlain,
      baseCount,
      total: vals.length,
      docNo: vals.filter((v) => v.docNo).length,
      expiry: vals.filter((v) => v.expiry).length,
      plain: vals.filter((v) => v.plain).length,
    },
  };
  mkdirSync('data', { recursive: true });
  writeFileSync('data/enrich.json', JSON.stringify(payload));
  // 版本戳：Worker 用它判断主缓存里的 enrich 是不是旧的需要重算
  writeFileSync('data/enrich-ver.txt', payload.updatedAt);
  const bytes = JSON.stringify(payload).length;

  console.log('');
  console.log('完成：本轮扫描', items.length, '条 → 命中', ok, '失败', fail);
  console.log('  本轮补文号', gotDoc, '| 补有效期', gotExp, '| 补真摘要', gotPlain);
  console.log(
    '  合并后共',
    vals.length,
    '条（旧',
    baseCount,
    '+ 新',
    Object.keys(map).length,
    '）→ 有文号',
    payload.stats.docNo,
    '| 有有效期',
    payload.stats.expiry,
    '| 有摘要',
    payload.stats.plain
  );
  console.log('  写入 data/enrich.json（', (bytes / 1024).toFixed(1), 'KB）');
  console.log('');
  console.log('推送到 KV（两条都要执行）：');
  console.log(
    '  npx wrangler kv key put --namespace-id=853d9ddc1d7844169f13d085af2290a2 enrich --path=data/enrich.json --remote'
  );
  console.log(
    '  npx wrangler kv key put --namespace-id=853d9ddc1d7844169f13d085af2290a2 enrich_ver --path=data/enrich-ver.txt --remote'
  );
}

main().catch((e) => {
  console.error('失败：', e);
  process.exit(1);
});
