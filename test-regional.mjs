// 本地测试：调用 worker 的 /api/refresh，验证区域优惠专题抓取
import worker from './worker/index.js';

const env = {
  POLICIES: { get: async () => null, put: async () => {} },
  ASSETS: { fetch: () => new Response('assets') },
};

const t0 = Date.now();
const res = await worker.fetch(new Request('https://jy.1211.cc.cd/api/policies'), env, { waitUntil: () => {} });
const j = await res.json();
console.log(`耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
console.log(`total=${j.total} 优惠=${j.preferenceCount} 广东=${j.gdCount} 区域=${j.regionalCount}`);
console.log(`areas=${JSON.stringify(j.areas)}`);
console.log(`errors=${JSON.stringify(j.errors)}`);
console.log('\n=== 区域优惠条目（含 area 标签）===');
j.items.filter((p) => p.area).slice(0, 20).forEach((p) => {
  console.log(`  [${p.area}] ${p.date || '?'} ${(p.docNo || '').slice(0, 16)} ${p.title.slice(0, 48)}`);
});
console.log('\n=== 区域优惠里 isPreference 的 ===');
j.items.filter((p) => p.area && p.isPreference).slice(0, 20).forEach((p) => {
  console.log(`  [${p.area}] ${p.prefType} ${p.title.slice(0, 50)}`);
});
