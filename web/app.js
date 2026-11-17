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

let policies = [];
const state = { q: '', tax: '全部', type: '全部', region: '全部', area: '全部', status: '全部', prefOnly: true };

// ===== 加载 =====
async function load() {
  $('list').innerHTML = '<div class="loading"><div class="spinner"></div>正在同步最新政策…</div>';
  try {
    const r = await fetch('/api/policies', { headers: { Accept: 'application/json' } });
    const d = await r.json();
    policies = (d && Array.isArray(d.items) && d.items.length) ? d.items : FALLBACK;
    updateBadge(d);
  } catch (e) {
    policies = FALLBACK;
    updateBadge({ source: '内置兜底', total: FALLBACK.length, preferenceCount: FALLBACK.length, updatedAt: null });
  }
  buildRegionChips();
  buildAreaChips();
  buildStatusChips();
  buildTypeChips();
  buildTaxChips();
  render();
}

function updateBadge(d) {
  const src = d && d.source === 'chinatax' ? '官方实时' : '内置兜底';
  let t = '—';
  if (d && d.updatedAt) {
    try { t = new Date(d.updatedAt).toLocaleString('zh-CN', { hour12: false }); } catch (e) {}
  }
  $('badge').textContent = `已同步 ${d?.total ?? policies.length} 条 · 优惠 ${d?.preferenceCount ?? '?'} 条 · ${src} · ${t}`;
}

// ===== 筛选 chips 构建 =====
function buildRegionChips() {
  const regions = new Set();
  policies.forEach((p) => { if (p.region) regions.add(p.region); });
  const holder = $('regionFilters');
  holder.innerHTML = '';
  ['全部', ...regions].forEach((r) => {
    const c = document.createElement('div');
    c.className = 'chip' + (r === '全部' ? ' active' : '');
    c.textContent = r;
    c.addEventListener('click', () => {
      state.region = r;
      holder.querySelectorAll('.chip').forEach((x) => x.classList.toggle('active', x.textContent === r));
      render();
    });
    holder.appendChild(c);
  });
}

function buildAreaChips() {
  const areas = new Set();
  policies.forEach((p) => { if (p.area) areas.add(p.area); });
  const holder = $('areaFilters');
  if (!areas.size) { holder.style.display = 'none'; return; }
  holder.style.display = 'flex';
  holder.innerHTML = '';
  ['全部', ...areas].forEach((a) => {
    const c = document.createElement('div');
    c.className = 'chip' + (a === '全部' ? ' active' : '');
    c.textContent = a;
    c.addEventListener('click', () => {
      state.area = a;
      holder.querySelectorAll('.chip').forEach((x) => x.classList.toggle('active', x.textContent === a));
      render();
    });
    holder.appendChild(c);
  });
}

function buildStatusChips() {
  const holder = $('statusFilters');
  const opts = ['全部', '生效中', '即将到期', '已到期', '已废止'];
  holder.innerHTML = '';
  opts.forEach((s) => {
    const c = document.createElement('div');
    c.className = 'chip' + (s === '全部' ? ' active' : '');
    c.textContent = s;
    c.addEventListener('click', () => {
      state.status = s;
      holder.querySelectorAll('.chip').forEach((x) => x.classList.toggle('active', x.textContent === s));
      render();
    });
    holder.appendChild(c);
  });
}

function buildTypeChips() {
  const types = new Set();
  policies.forEach((p) => { if (p.isPreference && p.prefType) types.add(p.prefType); });
  const holder = $('prefFilters');
  // 保留「只看优惠」开关，清除其余，重建类型 chips
  const toggle = $('prefToggle');
  holder.innerHTML = '';
  holder.appendChild(toggle);
  ['全部', ...types].forEach((t) => {
    const c = document.createElement('div');
    c.className = 'chip' + (t === '全部' ? ' active' : '');
    c.textContent = t;
    c.addEventListener('click', () => {
      state.type = t;
      holder.querySelectorAll('.chip').forEach((x) => x.classList.toggle('active', x.textContent === t));
      render();
    });
    holder.appendChild(c);
  });
}

function buildTaxChips() {
  const taxes = new Set();
  policies.forEach((p) => (p.taxTypes || []).forEach((t) => taxes.add(t)));
  const holder = $('taxFilters');
  holder.innerHTML = '';
  ['全部', ...taxes].forEach((t) => {
    const c = document.createElement('div');
    c.className = 'chip' + (t === '全部' ? ' active' : '');
    c.textContent = t;
    c.addEventListener('click', () => {
      state.tax = t;
      holder.querySelectorAll('.chip').forEach((x) => x.classList.toggle('active', x.textContent === t));
      render();
    });
    holder.appendChild(c);
  });
}

// ===== 渲染 =====
function render() {
  const q = state.q.trim().toLowerCase();
  const filtered = policies.filter((p) => {
    if (state.prefOnly && !p.isPreference) return false;
    if (state.region !== '全部' && p.region !== state.region) return false;
    if (state.area !== '全部' && p.area !== state.area) return false;
    if (state.status !== '全部' && p.status !== state.status) return false;
    if (state.tax !== '全部' && !(p.taxTypes || []).includes(state.tax)) return false;
    if (state.type !== '全部' && p.prefType !== state.type) return false;
    if (q && !`${p.title} ${p.docNo}`.toLowerCase().includes(q)) return false;
    return true;
  });

  const prefCount = filtered.filter((p) => p.isPreference).length;
  $('stats').innerHTML = `共 <b>${filtered.length}</b> 条${state.prefOnly ? '（仅优惠）' : ''} · 其中优惠 <b>${prefCount}</b> 条`;

  if (!filtered.length) {
    $('list').innerHTML = '<div class="empty"><div class="emoji">🔍</div>没有匹配的政策，换个关键词或筛选条件试试</div>';
    return;
  }

  $('list').innerHTML = filtered.map((p) => {
    const taxTags = (p.taxTypes || []).slice(0, 3).map((t) => `<span class="tag">${esc(t)}</span>`).join('');
    const prefTag = p.isPreference && p.prefType ? `<span class="tag pref">${esc(p.prefType)}</span>` : '';
    const regionTag = p.region ? `<span class="tag region">${esc(p.region)}</span>` : '';
    const areaTag = p.area ? `<span class="tag area">${esc(p.area)}</span>` : '';
    const stCls = { '生效中': 'st-valid', '即将到期': 'st-soon', '已到期': 'st-expired', '已废止': 'st-revoked' }[p.status] || '';
    const statusTag = (p.status && p.status !== '未标注')
      ? `<span class="tag status ${stCls}">${esc(p.status)}${p.expiry ? ' ' + esc(p.expiry) : ''}</span>` : '';
    const lvTag = p.effectLevel ? `<span class="tag lv">${esc(p.effectLevel)}</span>` : '';
    const summary = p.summary ? `<div class="summary">${esc(p.summary)}</div>` : '';
    const docDate = [p.docNo, p.date].filter(Boolean).join(' · ');
    const dept = p.department ? esc(p.department) : esc(p.column || '');
    return `
      <a class="item" href="${esc(p.url || 'https://fgk.chinatax.gov.cn/')}" target="_blank" rel="noopener">
        <div class="title">${esc(p.title)}</div>
        ${summary}
        <div class="meta">${statusTag}${regionTag}${areaTag}${prefTag}${taxTags}${lvTag}</div>
        <div class="sub"><span>${esc(docDate)}</span><span>${dept} <span class="arrow">›</span></span></div>
      </a>`;
  }).join('');
}

// ===== 事件绑定 =====
$('prefToggle').addEventListener('click', function () {
  state.prefOnly = !state.prefOnly;
  this.classList.toggle('on', state.prefOnly);
  render();
});

let debounceTimer;
$('searchInput').addEventListener('input', (e) => {
  clearTimeout(debounceTimer);
  $('clearBtn').style.display = e.target.value ? 'block' : 'none';
  debounceTimer = setTimeout(() => { state.q = e.target.value; render(); }, 250);
});
$('clearBtn').addEventListener('click', () => {
  $('searchInput').value = '';
  $('clearBtn').style.display = 'none';
  state.q = '';
  render();
});

// 启动
load();
