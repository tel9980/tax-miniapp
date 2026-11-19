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

import { writeFileSync, mkdirSync } from 'node:fs';
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
  // ② 文号式：财税〔2022〕19号 / 税务总局公告2023年第14号 / 粤财税〔2026〕1号
  m = headText.match(/[\u4e00-\u9fa5]{2,10}\s*[〔\[]\s*(\d{4})\s*[〕\]]\s*(\d+)\s*号/);
  if (m) return m[0].replace(/\s+/g, '');
  // ③ 兜底：正文前几段里找（有些页面把文号放在正文开头）
  const bodyHead = paragraphs.slice(0, 4).join(' ');
  m = bodyHead.match(/[\u4e00-\u9fa5]{2,10}\s*[〔\[]\s*(\d{4})\s*[〕\]]\s*(\d+)\s*号/);
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
function pickExpiry(paragraphs) {
  const text = paragraphs.join(' ');
  const ends = [];
  let m;
  // 「至2027年12月31日」「到2026年底」
  const re1 = /(?:至|到|截止|执行至|延续至|延长至|有效期至)\s*(\d{4})\s*年\s*(?:(\d{1,2})\s*月\s*(\d{1,2})\s*日|底)/g;
  while ((m = re1.exec(text))) {
    const y = m[1];
    const mo = m[2] ? String(m[2]).padStart(2, '0') : '12';
    const d = m[3] ? String(m[3]).padStart(2, '0') : '31';
    ends.push(`${y}-${mo}-${d}`);
  }
  // 「2024年1月1日至2027年12月31日」这类区间已在 re1 命中；再补「执行期限延长至2027年12月31日」
  if (!ends.length) return '';
  ends.sort();
  const max = ends[ends.length - 1];
  // 只填「还没到期」的：正文里提到历史日期（如旧文件执行期）时不乱标
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
    .filter((t) => (t.match(/《/g) || []).length <= 2);

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
async function enrichOne(item) {
  const res = await fetch(item.url, {
    headers: { 'User-Agent': UA, Referer: 'https://fgk.chinatax.gov.cn/zcfgk/' },
    redirect: 'follow',
  });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const html = await res.text();
  const paragraphs = extractBody(html);
  if (!paragraphs.length) throw new Error('empty body');

  const out = {};
  const docNo = pickDocNo(html, paragraphs);
  if (docNo) out.docNo = docNo;
  const expiry = pickExpiry(paragraphs);
  if (expiry) out.expiry = expiry;
  // 标题本身就是「关于…的公告」，正文首段才是真摘要
  const plain = pickPlain(paragraphs, item.title);
  if (plain && plain.length >= 24 && !plain.includes(TPL_TAIL)) out.plain = plain;
  return out;
}

// ---------- 主流程 ----------
async function main() {
  console.log('读取线上政策列表 …');
  const r = await fetch(API + '/api/policies');
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

  const payload = {
    map,
    updatedAt: new Date().toISOString(),
    stats: { scanned: items.length, ok, fail, docNo: gotDoc, expiry: gotExp, plain: gotPlain },
  };
  mkdirSync('data', { recursive: true });
  writeFileSync('data/enrich.json', JSON.stringify(payload));
  const bytes = JSON.stringify(payload).length;

  console.log('');
  console.log('完成：扫描', items.length, '条 → 命中', ok, '失败', fail);
  console.log('  补文号', gotDoc, '| 补有效期', gotExp, '| 补真摘要', gotPlain);
  console.log('  写入 data/enrich.json（', (bytes / 1024).toFixed(1), 'KB）');
  console.log('');
  console.log('推送到 KV：');
  console.log(
    '  npx wrangler kv key put --namespace-id=853d9ddc1d7844169f13d085af2290a2 enrich --path=data/enrich.json --remote'
  );
}

main().catch((e) => {
  console.error('失败：', e);
  process.exit(1);
});
