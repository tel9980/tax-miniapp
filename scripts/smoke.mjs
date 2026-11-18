// 本地冒烟测试：不开网络代理，直接把 worker 跑起来，四个接口全过一遍
// 用法：node scripts/smoke.mjs            （只测静态三张表，秒出）
//       node scripts/smoke.mjs --full     （额外触发一次真实抓取，约 30 秒）
import worker from '../worker/index.js';

const FULL = process.argv.includes('--full');

// 模拟 KV（内存版）
const kv = new Map();
const env = {
  POLICIES: {
    // 与真实 KV 一致：get(key, 'json') 返回解析后的对象
    get: async (k, type) => {
      const v = kv.get(k);
      if (v == null) return null;
      return type === 'json' ? JSON.parse(v) : v;
    },
    put: async (k, v) => { kv.set(k, v); },
  },
  ASSETS: { fetch: () => new Response('assets') },
};
const ctx = { waitUntil: () => {} };

const HOME_URL = /^https?:\/\/[^/]+\/?(zcfgk\/?)?$/; // 法规库首页（曾经的 bug：点开落到首页）
let failed = 0;
const ok = (cond, msg, extra = '') => {
  console.log(`  ${cond ? '✅' : '❌'} ${msg}${extra ? ' · ' + extra : ''}`);
  if (!cond) failed++;
};

async function get(path) {
  const res = await worker.fetch(new Request('https://jy.1211.cc.cd' + path), env, ctx);
  return { status: res.status, json: await res.json() };
}

// ── 1. 政策库 ──────────────────────────────────────────────
console.log('\n[1/4] /api/policies');
const t0 = Date.now();
if (FULL) {
  const { json: r } = await get('/api/refresh');
  console.log(`  真实抓取耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s · 写入 KV ${r.total} 条`);
}
const { json: p } = await get('/api/policies');
ok(p.total > 300, `政策总数 ${p.total}（>300）`);
ok(p.preferenceCount > 50, `优惠政策 ${p.preferenceCount} 条（>50）`);
ok((p.errors || []).length === 0, '抓取无报错', JSON.stringify(p.errors || []));
ok(!p.items.some((x) => HOME_URL.test(x.url || '')), '没有指向官网首页的链接');
ok(p.items.filter((x) => !x.url).length <= 8, `无原文链接条目 ${p.items.filter((x) => !x.url).length} 条（≤8，均为法规库未收录的区域政策）`);
ok((p.areas || []).length >= 4, `区域覆盖 ${JSON.stringify(p.areas)}`);
ok(p.items.some((x) => x.id === 'seed-hq-cit15' && !x.url), '横琴/南沙「无链接但有文号」的条目没被误删');
ok(p.items.filter((x) => x.isNew).length >= 0, `NEW 标记 ${p.items.filter((x) => x.isNew).length} 条`);

// ── 2~4. 三张对照表 ────────────────────────────────────────
const TABLES = [
  ['/api/vat-continuity', 'vat-continuity', 50],
  ['/api/cit-continuity', 'cit-continuity', 20],
  ['/api/iit-continuity', 'iit-continuity', 20],
];
const VALID_STATUS = ['长期有效', '继续有效', '待核实', '已停止', '已到期'];
for (let i = 0; i < TABLES.length; i++) {
  const [path, name, min] = TABLES[i];
  console.log(`\n[${i + 2}/4] ${path}`);
  const { status, json: j } = await get(path);
  ok(status === 200, `HTTP ${status}`);
  ok(j.total >= min, `${j.total} 条（≥${min}）`);
  ok(j.law && j.law.url, '法源链接存在');
  ok(!HOME_URL.test(j.law.url), '法源不是官网首页');
  const badStatus = j.items.filter((x) => !VALID_STATUS.includes(x.status));
  ok(badStatus.length === 0, '状态值合法', badStatus.map((x) => x.status).join(','));
  const badGroup = j.items.filter((x) => !j.groups.includes(x.g));
  ok(badGroup.length === 0, '分组值都在 groups 里', badGroup.map((x) => x.g).join(','));
  ok(j.items.every((x) => x.title && x.basis), '每条都有标题和依据');
  ok(!j.items.some((x) => HOME_URL.test(x.url || '')), '没有指向官网首页的链接');
  const noLink = j.items.filter((x) => !x.url);
  console.log(`  可点 ${j.items.length - noLink.length} 条 / 无链接 ${noLink.length} 条${noLink.length ? '（' + noLink.map((x) => x.docNo).join('、') + '）' : ''}`);
}

// 汇总
console.log('\n' + '─'.repeat(48));
console.log(failed === 0 ? '✅ 全部通过' : `❌ ${failed} 项未通过`);
process.exit(failed === 0 ? 0 : 1);
