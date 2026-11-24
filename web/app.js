// 税优政策库前端逻辑
// 数据流：fetch /api/policies → Worker 抓取官方接口(缓存1h) → 结构化 JSON → 前端筛选渲染

// 内置兜底（Worker 或网络不可用时保证页面有内容）
const FALLBACK = [
  { id: 'seed-vat-small', title: '小规模纳税人免征增值税（月销售额10万元以下）', docNo: '财政部 税务总局公告2023年第19号', date: '2023-08-01', url: 'https://fgk.chinatax.gov.cn/', taxTypes: ['增值税'], industry: '社会民生', effectLevel: '财税文件', department: '财政部,国家税务总局', isPreference: true, prefType: '免税' },
  { id: 'seed-sme', title: '小型微利企业减按25%计入应纳税所得额，按20%税率缴纳企业所得税', docNo: '财政部 税务总局公告2023年第12号', date: '2023-03-26', url: 'https://fgk.chinatax.gov.cn/', taxTypes: ['企业所得税'], industry: '社会民生', effectLevel: '财税文件', department: '财政部,国家税务总局', isPreference: true, prefType: '减税' },
  { id: 'seed-rd', title: '研发费用税前加计扣除比例提高至100%', docNo: '财政部 税务总局公告2023年第7号', date: '2023-03-26', url: 'https://fgk.chinatax.gov.cn/', taxTypes: ['企业所得税'], industry: '科技创新', effectLevel: '财税文件', department: '财政部,国家税务总局', isPreference: true, prefType: '扣除抵免' },
  { id: 'seed-six', title: '增值税小规模纳税人、小型微利企业和个体工商户减半征收"六税两费"', docNo: '财政部 税务总局公告2023年第12号', date: '2023-03-26', url: 'https://fgk.chinatax.gov.cn/', taxTypes: ['其他'], industry: '社会民生', effectLevel: '财税文件', department: '财政部,国家税务总局', isPreference: true, prefType: '减税' },
];

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

let policies = [];           // 当前已加载的政策（服务端分页的一页或多页）
let facets = null;           // 服务端返回的筛选维度（tax/type/region/area/status 各去重值+计数）
let currentPage = 1;         // 当前页码
let totalPages = 1;          // 总页数
let serverTotal = 0;         // 服务端筛选后的总条数
let serverPref = 0;          // 服务端筛选后的优惠条数
const PAGE_SIZE = 40;                 // 每页渲染条数，避免一次传输/渲染 300+ 条
const FILTER_KEYS = ['tax', 'type', 'region', 'area', 'status', 'prefOnly', 'newOnly', 'favOnly'];
const FAV_KEY = 'tax-favs';
let favs = new Set();
try { favs = new Set(JSON.parse(localStorage.getItem(FAV_KEY) || '[]')); } catch (e) {}
function saveFavs() { try { localStorage.setItem(FAV_KEY, JSON.stringify([...favs])); } catch (e) {} }
const state = (() => {
  const s = { q: '', tax: '全部', type: '全部', region: '全部', area: '全部', status: '全部', prefOnly: true, newOnly: false, favOnly: false, shown: PAGE_SIZE };
  try { // 记住上次筛选，二次访问无需重新点
    const saved = JSON.parse(localStorage.getItem('tax-filter') || '{}');
    FILTER_KEYS.forEach((k) => { if (k in saved) s[k] = saved[k]; });
  } catch (e) {}
  return s;
})();
function saveFilter() {
  try { const o = {}; FILTER_KEYS.forEach((k) => (o[k] = state[k])); localStorage.setItem('tax-filter', JSON.stringify(o)); } catch (e) {}
}

// 把筛选条件拼成 URL 查询串（服务端筛选 + 分页）
function buildQuery(page) {
  const p = new URLSearchParams();
  p.set('page', page);
  p.set('size', PAGE_SIZE);
  if (state.q.trim()) p.set('q', state.q.trim());
  if (state.tax !== '全部') p.set('tax', state.tax);
  if (state.type !== '全部') p.set('type', state.type);
  if (state.region !== '全部') p.set('region', state.region);
  if (state.area !== '全部') p.set('area', state.area);
  if (state.status !== '全部') p.set('status', state.status);
  if (state.prefOnly) p.set('prefOnly', '1');
  if (state.newOnly) p.set('newOnly', '1');
  if (state.favOnly) { p.set('favOnly', '1'); p.set('favs', [...favs].join(',')); }
  return p.toString();
}

// ===== 加载（服务端分页）=====
async function loadPage(page = 1, append = false) {
  if (!append) $('list').innerHTML = '<div class="loading"><div class="spinner"></div>正在同步最新政策…</div>';
  try {
    const r = await fetch('/api/policies?' + buildQuery(page), { headers: { Accept: 'application/json' } });
    const d = await r.json();
    const items = (d && Array.isArray(d.items)) ? d.items : [];
    policies = append ? policies.concat(items) : items;
    facets = d.facets || null;
    currentPage = d.page || page;
    totalPages = d.totalPages || 1;
    serverTotal = d.total || 0;
    serverPref = d.prefCount || 0;
    updateBadge(d);
  } catch (e) {
    policies = FALLBACK;
    facets = null;
    currentPage = 1; totalPages = 1;
    serverTotal = FALLBACK.length; serverPref = FALLBACK.length;
    updateBadge({ source: '内置兜底', total: FALLBACK.length, preferenceCount: FALLBACK.length, updatedAt: null });
  }
  buildChips();
  bindFavClicks();
  $('prefToggle').classList.toggle('on', state.prefOnly);
  render();
}

function updateBadge(d) {
  const src = d && d.source === 'chinatax' ? '官方实时' : '内置兜底';
  let t = '—';
  if (d && d.updatedAt) {
    try { t = new Date(d.updatedAt).toLocaleString('zh-CN', { hour12: false }); } catch (e) {}
  }
  $('badge').textContent = `已同步 ${d?.total ?? serverTotal} 条 · 优惠 ${d?.prefCount ?? d?.preferenceCount ?? '?'} 条 · ${src} · ${t}`;
}

// 快捷筛选 chips：「新增政策」（cron 每日 diff）+ 「我的收藏」（本地存储）
function buildNewChip() {
  const holder = $('newFilters');
  if (!holder) return;
  holder.innerHTML = '';

  const c = document.createElement('div');
  c.className = 'chip new-chip' + (state.newOnly ? ' active' : '');
  c.textContent = '🆕 新增政策';
  c.addEventListener('click', () => {
    state.newOnly = !state.newOnly;
    c.classList.toggle('active', state.newOnly);
    loadPage(1);
  });
  holder.appendChild(c);

  const f = document.createElement('div');
  f.className = 'chip fav-chip' + (state.favOnly ? ' active' : '');
  f.textContent = favs.size ? `★ 我的收藏 ${favs.size}` : '★ 我的收藏';
  f.addEventListener('click', () => {
    state.favOnly = !state.favOnly;
    f.classList.toggle('active', state.favOnly);
    loadPage(1);
  });
  holder.appendChild(f);
}

// 收藏点击：事件委托（卡片整体是 <a>，必须阻止跳转）
function bindFavClicks() {
  const list = $('list');
  if (!list || list.dataset.favBound) return;
  list.dataset.favBound = '1';
  list.addEventListener('click', (e) => {
    const btn = e.target.closest('.fav-btn');
    if (!btn) return;
    e.preventDefault();
    e.stopPropagation();
    const id = btn.dataset.fav;
    if (favs.has(id)) favs.delete(id); else favs.add(id);
    saveFavs();
    buildNewChip();          // 刷新收藏计数
    // 若正以「我的收藏」筛选，需重新请求服务端；否则只更新星标
    if (state.favOnly) loadPage(1); else render();
  });
}

// ===== 筛选 chips 构建（数据源：服务端 facets，非当前页 policies）=====
function buildChips() {
  buildRegionChips();
  buildAreaChips();
  buildStatusChips();
  buildTypeChips();
  buildTaxChips();
  buildNewChip();
}

function facetKeys(facet) {
  return facet && Array.isArray(facet) ? facet.map((x) => x.k) : [];
}

function buildRegionChips() {
  const regions = facetKeys(facets && facets.region);
  const holder = $('regionFilters');
  holder.innerHTML = '';
  ['全部', ...regions].forEach((r) => {
    const c = document.createElement('div');
    c.className = 'chip' + (r === state.region ? ' active' : '');
    c.textContent = r;
    c.addEventListener('click', () => {
      state.region = r;
      holder.querySelectorAll('.chip').forEach((x) => x.classList.toggle('active', x.textContent === r));
      loadPage(1);
    });
    holder.appendChild(c);
  });
}

function buildAreaChips() {
  const areas = facetKeys(facets && facets.area);
  const holder = $('areaFilters');
  if (!areas.length) { holder.style.display = 'none'; return; }
  holder.style.display = 'flex';
  holder.innerHTML = '';
  ['全部', ...areas].forEach((a) => {
    const c = document.createElement('div');
    c.className = 'chip' + (a === state.area ? ' active' : '');
    c.textContent = a;
    c.addEventListener('click', () => {
      state.area = a;
      holder.querySelectorAll('.chip').forEach((x) => x.classList.toggle('active', x.textContent === a));
      loadPage(1);
    });
    holder.appendChild(c);
  });
}

function buildStatusChips() {
  const holder = $('statusFilters');
  const opts = ['全部', '生效中', '即将到期', '已到期', '已停止', '已废止'];
  holder.innerHTML = '';
  opts.forEach((s) => {
    const c = document.createElement('div');
    c.className = 'chip' + (s === state.status ? ' active' : '');
    c.textContent = s;
    c.addEventListener('click', () => {
      state.status = s;
      holder.querySelectorAll('.chip').forEach((x) => x.classList.toggle('active', x.textContent === s));
      loadPage(1);
    });
    holder.appendChild(c);
  });
}

function buildTypeChips() {
  const types = facetKeys(facets && facets.type);
  const holder = $('prefFilters');
  const toggle = $('prefToggle');
  holder.innerHTML = '';
  holder.appendChild(toggle);
  ['全部', ...types].forEach((t) => {
    const c = document.createElement('div');
    c.className = 'chip' + (t === state.type ? ' active' : '');
    c.textContent = t;
    c.addEventListener('click', () => {
      state.type = t;
      holder.querySelectorAll('.chip').forEach((x) => x.classList.toggle('active', x.textContent === t));
      loadPage(1);
    });
    holder.appendChild(c);
  });
}

function buildTaxChips() {
  const taxes = facetKeys(facets && facets.tax);
  const holder = $('taxFilters');
  holder.innerHTML = '';
  ['全部', ...taxes].forEach((t) => {
    const c = document.createElement('div');
    c.className = 'chip' + (t === state.tax ? ' active' : '');
    c.textContent = t;
    c.addEventListener('click', () => {
      state.tax = t;
      holder.querySelectorAll('.chip').forEach((x) => x.classList.toggle('active', x.textContent === t));
      loadPage(1);
    });
    holder.appendChild(c);
  });
}

// ===== 渲染（服务端已筛选+分页，前端只渲染已加载的页）=====
function render() {
  saveFilter();
  const prefCount = serverPref;
  const newFresh = policies.filter((p) => p.isNew).length;
  const newPill = newFresh ? ` · <span class="new-pill">🆕 新增 ${newFresh} 条</span>` : '';
  $('stats').innerHTML = `共 <b>${serverTotal}</b> 条${state.prefOnly ? '（仅优惠）' : ''} · 其中优惠 <b>${prefCount}</b> 条${newPill}`;

  if (!policies.length) {
    $('list').innerHTML = '<div class="empty"><div class="emoji">🔍</div>没有匹配的政策，换个关键词或筛选条件试试</div>';
    return;
  }

  const rest = serverTotal - policies.length;
  $('list').innerHTML = policies.map((p) => {
    const taxTags = (p.taxTypes || []).slice(0, 3).map((t) => `<span class="tag">${esc(t)}</span>`).join('');
    const prefTag = p.isPreference && p.prefType ? `<span class="tag pref">${esc(p.prefType)}</span>` : '';
    const regionTag = p.region ? `<span class="tag region">${esc(p.region)}</span>` : '';
    const areaTag = p.area ? `<span class="tag area">${esc(p.area)}</span>` : '';
    const stCls = { '生效中': 'st-valid', '即将到期': 'st-soon', '已到期': 'st-expired', '已停止': 'st-revoked', '已废止': 'st-revoked' }[p.status] || '';
    const statusTag = (p.status && p.status !== '未标注')
      ? `<span class="tag status ${stCls}">${esc(p.status)}${p.expiry ? ' ' + esc(p.expiry) : ''}</span>` : '';
    const lvTag = p.effectLevel ? `<span class="tag lv">${esc(p.effectLevel)}</span>` : '';
    const newTag = p.isNew ? '<span class="tag new">NEW</span>' : '';
    const favOn = favs.has(p.id);
    const favBtn = `<span class="fav-btn${favOn ? ' on' : ''}" data-fav="${esc(p.id)}" title="${favOn ? '取消收藏' : '收藏'}">${favOn ? '★' : '☆'}</span>`;
    const vatTag = p.vatPre2026 ? `<span class="tag vat">2026前·增值税待核实</span>` : '';
    const summary = (p.plain || p.summary) ? `<div class="summary">${esc(p.plain || p.summary)}</div>` : '';
    const hint = p.linkHint ? `<div class="hint">${esc(p.linkHint)}</div>` : '';
    const docDate = [p.docNo, p.date].filter(Boolean).join(' · ');
    const dept = p.department ? esc(p.department) : esc(p.column || '');
    const arrow = p.url ? ' <span class="arrow">›</span>' : '';
    const body = `
        <div class="title">${favBtn}${newTag}${esc(p.title)}</div>
        ${summary}
        ${hint}
        <div class="meta">${statusTag}${vatTag}${regionTag}${areaTag}${prefTag}${taxTags}${lvTag}</div>
        <div class="sub"><span>${esc(docDate)}</span><span>${dept}${arrow}</span></div>`;
    // 官方库未收录原文的政策：不做成链接，避免点开落到官网首页
    if (!p.url) {
      return `<div class="item nolink">${body}
        <div class="nolink-hint">官方库未收录原文 · 请按文号「${esc(p.docNo || '')}」自行核实，或拨 12366 确认</div>
      </div>`;
    }
    return `<a class="item" href="${esc(p.url)}" target="_blank" rel="noopener">${body}</a>`;
  }).join('') + (rest > 0
    ? `<div class="load-more"><button id="loadMoreBtn">加载更多 · 还有 ${rest} 条</button></div>`
    : '');

  const btn = $('loadMoreBtn');
  if (btn) btn.addEventListener('click', () => loadPage(currentPage + 1, true));
}

// ===== 回到顶部 =====
(function () {
  const bt = $('backTop');
  if (!bt) return;
  window.addEventListener('scroll', () => bt.classList.toggle('show', window.scrollY > 600), { passive: true });
  bt.addEventListener('click', () => window.scrollTo({ top: 0, behavior: 'smooth' }));
})();

// ===== 事件绑定 =====
$('prefToggle').addEventListener('click', function () {
  state.prefOnly = !state.prefOnly;
  this.classList.toggle('on', state.prefOnly);
  loadPage(1);
});

let debounceTimer;
$('searchInput').addEventListener('input', (e) => {
  clearTimeout(debounceTimer);
  $('clearBtn').style.display = e.target.value ? 'block' : 'none';
  debounceTimer = setTimeout(() => { state.q = e.target.value; loadPage(1); }, 300);
});
$('clearBtn').addEventListener('click', () => {
  $('searchInput').value = '';
  $('clearBtn').style.display = 'none';
  state.q = '';
  loadPage(1);
});

// ===== 按身份打包 =====
async function loadPacks() {
  $('packsList').innerHTML = '<div class="loading"><div class="spinner"></div>正在聚类…</div>';
  try {
    const r = await fetch('/api/packs', { headers: { Accept: 'application/json' } });
    const d = await r.json();
    renderPacks(d.packs || [], d.updatedAt);
  } catch (e) {
    $('packsList').innerHTML = '<div class="loading">加载失败，请刷新重试</div>';
  }
}

function renderPacks(packs, updatedAt) {
  const holder = $('packsList');
  if (!packs.length) { holder.innerHTML = '<div class="empty"><div class="emoji">📦</div>暂无打包数据</div>'; return; }
  holder.innerHTML = packs.map((pack) => {
    const items = pack.items.map((p) => {
      const taxTags = (p.taxTypes || []).slice(0, 2).map((t) => `<span class="tag">${esc(t)}</span>`).join('');
      const prefTag = p.isPreference && p.prefType ? `<span class="tag pref">${esc(p.prefType)}</span>` : '';
      const statusTag = p.status && p.status !== '未标注' ? `<span class="tag status">${esc(p.status)}${p.expiry ? ' ' + esc(p.expiry) : ''}</span>` : '';
      const summary = p.plain ? `<div class="summary">${esc(p.plain)}</div>` : '';
      const docDate = [p.docNo, p.date].filter(Boolean).join(' · ');
      const body = `
        <div class="title">${esc(p.title)}</div>
        ${summary}
        <div class="meta">${statusTag}${prefTag}${taxTags}</div>
        <div class="sub"><span>${esc(docDate)}</span></div>`;
      if (!p.url) return `<div class="item nolink">${body}<div class="nolink-hint">官方库未收录原文 · 请按文号「${esc(p.docNo || '')}」自行核实，或拨 12366 确认</div></div>`;
      return `<a class="item" href="${esc(p.url)}" target="_blank" rel="noopener">${body}</a>`;
    }).join('');
    return `
      <div class="pack-card">
        <div class="pack-head">
          <span class="pack-icon">${pack.icon}</span>
          <div class="pack-title">${esc(pack.name)}<span class="pack-count">${pack.count} 条</span></div>
        </div>
        <div class="pack-desc">${esc(pack.desc)}</div>
        <div class="list">${items}</div>
      </div>`;
  }).join('');
  $('packsKey').innerHTML = `按<strong>身份/场景</strong>聚合相关优惠政策，帮您快速定位与自己最相关的条款。共 <b>${packs.length}</b> 个身份包 · ${packs.reduce((s, p) => s + p.count, 0)} 条相关政策${updatedAt ? ' · 更新于 ' + new Date(updatedAt).toLocaleString('zh-CN', { hour12: false }) : ''}`;
}

// ===== 本季度到期清单 =====
async function loadExpiring() {
  $('expiringList').innerHTML = '<div class="loading"><div class="spinner"></div>正在统计…</div>';
  try {
    const r = await fetch('/api/expiring', { headers: { Accept: 'application/json' } });
    const d = await r.json();
    renderExpiring(d);
  } catch (e) {
    $('expiringList').innerHTML = '<div class="loading">加载失败，请刷新重试</div>';
  }
}

function renderExpiring(d) {
  const holder = $('expiringList');
  $('expiringKey').innerHTML = `<strong>${esc(d.quarter)}到期清单</strong> · 本季度（${esc(d.start)} ~ ${esc(d.end)}）内到期的政策，按到期日升序排列，共 <b>${d.count}</b> 条，请提前关注续期或替代政策。`;
  if (!d.count) { holder.innerHTML = '<div class="empty"><div class="emoji">✅</div>本季度暂无到期政策，安心使用</div>'; return; }
  holder.innerHTML = d.items.map((p) => {
    const taxTags = (p.taxTypes || []).slice(0, 2).map((t) => `<span class="tag">${esc(t)}</span>`).join('');
    const prefTag = p.isPreference && p.prefType ? `<span class="tag pref">${esc(p.prefType)}</span>` : '';
    const regionTag = p.region ? `<span class="tag region">${esc(p.region)}</span>` : '';
    const summary = p.plain ? `<div class="summary">${esc(p.plain)}</div>` : '';
    const docDate = [p.docNo, p.date].filter(Boolean).join(' · ');
    const body = `
        <div class="title"><span class="tag status st-soon">${esc(p.expiry)} 到期</span>${esc(p.title)}</div>
        ${summary}
        <div class="meta">${regionTag}${prefTag}${taxTags}</div>
        <div class="sub"><span>${esc(docDate)}</span></div>`;
    if (!p.url) return `<div class="item nolink">${body}<div class="nolink-hint">官方库未收录原文 · 请按文号「${esc(p.docNo || '')}」自行核实，或拨 12366 确认</div></div>`;
    return `<a class="item" href="${esc(p.url)}" target="_blank" rel="noopener">${body}</a>`;
  }).join('');
}

// ===== 增值税新法衔接对照表 =====
// ===== 优惠衔接表通用渲染器（增值税 / 企业所得税共用）=====
const STATUS_META = {
  '长期有效': { cls: 'st-valid', label: (x) => '长期有效' },
  '继续有效': { cls: 'st-valid', label: (x) => (x.until === '长期' ? '长期有效' : '有效至 ' + x.until) },
  '待核实':   { cls: 'st-warn',  label: () => '⚠️ 待核实 · 需人工确认' },
  '已停止':   { cls: 'stopped',  label: (x) => '已停止 ' + x.until },
  '已到期':   { cls: 'stopped',  label: (x) => '已到期 ' + x.until },
};

function makeContinuity(cfg) {
  const st = { group: '全部' };
  let data = null;

  async function load() {
    if (data) return;
    $(cfg.listId).innerHTML = '<div class="loading"><div class="spinner"></div>正在加载…</div>';
    try {
      const r = await fetch(cfg.api, { headers: { Accept: 'application/json' } });
      data = await r.json();
    } catch (e) {
      $(cfg.listId).innerHTML = '<div class="loading">加载失败，请刷新重试</div>';
      return;
    }
    $(cfg.keyId).innerHTML = cfg.keyHtml(data);
    buildChips();
    render();
  }

  function chips() {
    const statuses = [...new Set(data.items.map((x) => x.status))];
    return ['全部', ...data.groups, ...statuses.filter((x) => x !== '继续有效')];
  }

  function buildChips() {
    const box = $(cfg.chipsId);
    const list = chips();
    box.innerHTML = list.map((g) =>
      '<div class="chip' + (st.group === g ? ' on' : '') + '" data-g="' + esc(g) + '">' + esc(g) + '</div>'
    ).join('');
    box.querySelectorAll('.chip').forEach((c) => {
      c.addEventListener('click', () => { st.group = c.dataset.g; buildChips(); render(); });
    });
  }

  function render() {
    const isStatus = (v) => data.items.some((x) => x.status === v);
    const items = data.items.filter((x) => {
      if (st.group === '全部') return true;
      if (isStatus(st.group)) return x.status === st.group;
      return x.g === st.group;
    });
    const counts = {};
    data.items.forEach((x) => { counts[x.g] = (counts[x.g] || 0) + 1; });
    const okN = data.items.filter((x) => x.status === '继续有效' || x.status === '长期有效').length;
    const badN = data.items.filter((x) => x.status === '已停止' || x.status === '已到期').length;
    const waitN = data.items.filter((x) => x.status === '待核实').length;
    $(cfg.statsId).innerHTML =
      '共 ' + data.items.length + ' 项 · 有效 ' + okN + ' 项' +
      (badN ? ' · 已失效 ' + badN + ' 项' : '') +
      '（当前显示 ' + items.length + ' 项）' +
      (waitN ? ' <span class="wait-pill">⚠️ 待核实 ' + waitN + ' 项，需打 12366 确认</span>' : '');

    $(cfg.listId).innerHTML = items.map((x) => {
      const meta = STATUS_META[x.status] || STATUS_META['继续有效'];
      const isWait = x.status === '待核实';
      const untilTag = '<span class="tag ' + meta.cls + '">' + esc(meta.label(x)) + '</span>';
      const docTag = x.docNo ? '<span class="tag lv">' + esc(x.docNo) + '</span>' : '';
      const basisTag = '<span class="tag lv">' + esc(x.basis) + '</span>';
      const inner = `
        <div class="title">${isWait ? '⚠️ ' : ''}${esc(x.title)}</div>
        <div class="summary">${esc(x.plain || '')}</div>
        <div class="meta">${untilTag}${docTag}${basisTag}</div>`;
      // 法规库确实未收录的条目：不做成链接，避免点开落到官网首页
      if (!x.url) {
        return `<div class="item nolink${isWait ? ' warn' : ''}">${inner}
          <div class="nolink-hint">官方库未收录原文 · 请按文号「${esc(x.docNo || x.basis || '')}」自行核实，或拨 12366 确认</div>
        </div>`;
      }
      return `<a class="item${isWait ? ' warn' : ''}" href="${esc(x.url)}" target="_blank" rel="noopener">${inner}</a>`;
    }).join('') || '<div class="loading">该分类下暂无条目</div>';
  }

  return { load };
}

const vatTab = makeContinuity({
  api: '/api/vat-continuity', listId: 'vatList', keyId: 'vatKey',
  chipsId: 'vatGroupFilters', statsId: 'vatStats',
  keyHtml: (d) =>
    '<strong>' + esc(d.law.lawName) + '</strong> 自 ' + esc(d.law.lawFrom) + ' 起施行。' +
    esc(d.law.keyRule) +
    '<br>依据：<a href="' + esc(d.law.url) + '" target="_blank" rel="noopener">' + esc(d.law.docNo) + ' 原文</a>',
});

const citTab = makeContinuity({
  api: '/api/cit-continuity', listId: 'citList', keyId: 'citKey',
  chipsId: 'citGroupFilters', statsId: 'citStats',
  keyHtml: (d) =>
    '<strong>企业所得税没有整体清理。</strong>' + esc(d.law.note) +
    '<br>法源：<a href="' + esc(d.law.url) + '" target="_blank" rel="noopener">' + esc(d.law.lawName) + '</a>',
});

const iitTab = makeContinuity({
  api: '/api/iit-continuity', listId: 'iitList', keyId: 'iitKey',
  chipsId: 'iitGroupFilters', statsId: 'iitStats',
  keyHtml: (d) =>
    '<strong>' + esc(d.law.lawName) + '</strong> 自 ' + esc(d.law.lawFrom) + ' 起施行。' +
    esc(d.law.keyRule) +
    '<br>依据：<a href="' + esc(d.law.url) + '" target="_blank" rel="noopener">' + esc(d.law.docNo) + '</a>',
});

// ===== Tab 切换 =====
const TABS = [
  { tab: 'tabPolicy', view: 'policyView' },
  { tab: 'tabPacks', view: 'packsView', load: () => loadPacks() },
  { tab: 'tabExpiring', view: 'expiringView', load: () => loadExpiring() },
  { tab: 'tabVat', view: 'vatView', load: () => vatTab.load() },
  { tab: 'tabCit', view: 'citView', load: () => citTab.load() },
  { tab: 'tabIit', view: 'iitView', load: () => iitTab.load() },
];

TABS.forEach((t) => {
  $(t.tab).addEventListener('click', () => {
    TABS.forEach((o) => {
      $(o.tab).classList.toggle('on', o.tab === t.tab);
      $(o.view).style.display = o.tab === t.tab ? '' : 'none';
    });
    if (t.load) t.load();
  });
});

// 启动
loadPage(1);

// 注册 Service Worker（可「添加到主屏幕」+ 离线可开）
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  });
}
