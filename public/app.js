const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

const state = {
  queryId: null,
  catalogVersion: null,
  filters: {},
  page: 1,
  pageSize: 6,
  total: 0,
  cache: {
    query: null,
    list: null,
    map: null
  }
};

const form = $('#search-form');
const listEl = $('#store-list');
const pageLabel = $('#page-label');
const prevBtn = $('#prev-page');
const nextBtn = $('#next-page');
const banner = $('#offline-banner');
const serverStatus = $('#server-status');
const clusterLayer = $('#cluster-layer');
const toastEl = $('#toast');
const dialog = $('#store-dialog');
const detailEl = $('#store-detail');

function toast(message) {
  toastEl.textContent = message;
  toastEl.classList.add('show');
  clearTimeout(toastEl._timer);
  toastEl._timer = setTimeout(() => toastEl.classList.remove('show'), 3200);
}

function formatTime(ms) {
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'UTC', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false
  }).format(new Date(ms)) + ' UTC';
}

function formatLocal(session) {
  return `${session.startsLocal}–${session.endsLocal.slice(-5)}（${session.timezone}）`;
}

async function api(path, options = {}) {
  const res = await fetch(path, {
    headers: { 'content-type': 'application/json', ...(options.headers || {}) },
    ...options
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const error = new Error(body.error?.message || `请求失败 ${res.status}`);
    error.status = res.status;
    error.code = body.error?.code;
    error.body = body.error;
    throw error;
  }
  return body;
}

async function loadFacets() {
  try {
    const facets = await api('/api/facets');
    const city = form.elements.city;
    const theme = form.elements.theme;
    const seat = form.elements.seat;
    city.innerHTML = '<option value="">全部城市</option>' + facets.cities.map(c => `<option>${c.city}</option>`).join('');
    theme.innerHTML = '<option value="">全部主题</option>' + facets.themes.map(t => `<option>${t.theme}</option>`).join('');
    seat.innerHTML = '<option value="">不限座位</option>' + facets.seatTypes.map(s => `<option>${s.seat_type}</option>`).join('');
  } catch {
    toast('筛选条件加载失败，将使用上次页面版本');
  }
}

function readFilters() {
  return {
    q: form.elements.q.value.trim(),
    city: form.elements.city.value,
    theme: form.elements.theme.value,
    seat: form.elements.seat.value,
    openOnly: form.elements.openOnly.checked,
    upcomingEvents: form.elements.upcomingEvents.checked
  };
}

function saveCache(name, value) {
  state.cache[name] = { value, savedAt: Date.now(), serverAsOf: value.asOf || Date.now() };
}

function cachedWarning() {
  const parts = Object.entries(state.cache)
    .filter(([, v]) => v)
    .map(([k, v]) => `${k === 'list' ? '列表' : k === 'map' ? '地图' : '查询'} ${new Date(v.savedAt).toLocaleString()} 更新`);
  if (!parts.length) return '网络不可用，且本机没有可展示的上次结果。';
  return `网络失败，正在显示上次结果（${parts.join('；')}）。状态不再标记为实时。`;
}

async function ensureQuery(filters) {
  try {
    const query = await api('/api/queries', { method: 'POST', body: JSON.stringify(filters) });
    state.queryId = query.queryId;
    state.catalogVersion = query.catalogVersion;
    state.filters = query.filters;
    saveCache('query', query);
    $('#query-meta').textContent = `queryId ${query.queryId} · 目录 v${query.catalogVersion}`;
    return query;
  } catch (error) {
    if (state.cache.query) {
      const old = state.cache.query.value;
      state.queryId = old.queryId;
      state.catalogVersion = old.catalogVersion;
      banner.textContent = cachedWarning();
      banner.classList.remove('hidden');
      return old;
    }
    throw error;
  }
}

async function fetchList() {
  const params = new URLSearchParams({ queryId: state.queryId, page: state.page, pageSize: state.pageSize });
  try {
    const data = await api(`/api/stores?${params}`);
    saveCache('list', data);
    banner.classList.add('hidden');
    renderList(data);
  } catch (error) {
    if (error.code === 'QUERY_VERSION_STALE') {
      await refreshAfterCorrection();
      return fetchList();
    }
    if (state.cache.list) {
      banner.textContent = cachedWarning();
      banner.classList.remove('hidden');
      renderList(state.cache.list.value, true);
    } else toast(error.message);
  }
}

async function fetchMap() {
  const params = new URLSearchParams({ queryId: state.queryId, zoom: 9 });
  try {
    const data = await api(`/api/map?${params}`);
    saveCache('map', data);
    renderMap(data);
  } catch (error) {
    if (error.code === 'QUERY_VERSION_STALE') {
      await refreshAfterCorrection();
      return fetchMap();
    }
    if (state.cache.map) {
      banner.textContent = cachedWarning();
      banner.classList.remove('hidden');
      renderMap(state.cache.map.value, true);
    }
  }
}

async function refreshAfterCorrection() {
  toast('检测到手工更正，正在切换新查询版');
  const query = await ensureQuery(state.filters || readFilters());
  state.page = 1;
  return query;
}

async function runSearch() {
  state.page = 1;
  serverStatus.textContent = '计算中…';
  await ensureQuery(readFilters());
  await Promise.all([fetchList(), fetchMap()]);
  serverStatus.textContent = `目录 v${state.catalogVersion} · 已同步`;
  serverStatus.classList.remove('stale');
}

function statusLabel(store, stale) {
  const labelBase = store.status.state === 'open' ? '营业中' : '闭店中';
  const label = store.status.historical
    ? `历史状态·${labelBase}`
    : stale ? `${labelBase}（缓存非实时）` : labelBase;
  return { label, className: store.status.state + ((stale || store.status.historical) ? ' stale' : '') };
}

function renderList(data, stale = false) {
  state.total = data.total;
  pageLabel.textContent = `${data.page} / ${Math.max(1, Math.ceil(data.total / data.pageSize))}`;
  prevBtn.disabled = data.page <= 1;
  nextBtn.disabled = !data.hasMore;
  if (!data.items.length) {
    listEl.innerHTML = '<div class="empty">没有匹配门店。可尝试放宽主题、座位或活动条件。</div>';
    return;
  }
  listEl.innerHTML = data.items.map(s => {
    const badge = statusLabel(s, stale);
    return `<article class="store-card" data-id="${s.id}">
      <div class="store-top">
        <div><h3>${s.name}</h3><p class="address">${s.city} · ${s.address} · ${s.timezone}</p></div>
        <span class="open-badge ${badge.className}">${badge.label}</span>
      </div>
      <div class="tags">${s.themes.map(t => `<span class="tag">${t}</span>`).join('')}</div>
      <div class="tags">${Object.entries(s.seats).map(([k, v]) => `<span class="tag">${k} × ${v}</span>`).join('')}</div>
      <div class="card-meta"><span>下次状态变化：${formatTime(s.status.nextChange)}</span><span>${s.upcomingEvents.length} 场近期活动</span></div>
    </article>`;
  }).join('');
}

function project(lat, lng) {
  return { x: (lng + 180) / 360 * 1000, y: (82 - lat) / 150 * 560 };
}

function renderMap(data, stale = false) {
  clusterLayer.innerHTML = data.clusters.map((c, i) => {
    const p = project(c.lat, c.lng);
    const r = 13 + Math.min(24, Math.sqrt(c.count) * 4);
    const cls = c.count > 1 ? 'cluster' : `cluster ${c.openCount === 1 ? 'open-all' : 'closed-all'}`;
    return `<g class="${cls}" tabindex="0" data-index="${i}" transform="translate(${p.x},${p.y})">
      <circle r="${r}"></circle><text y="1" font-size="${c.count > 99 ? 14 : 16}">${c.count}</text>
    </g>`;
  }).join('');
  $$('#cluster-layer .cluster').forEach(el => {
    const activate = () => {
      const c = data.clusters[Number(el.dataset.index)];
      if (c.storeIds.length === 1) openStore(c.storeIds[0]);
      else showClusterPreview(c, stale);
    };
    el.addEventListener('click', activate);
    el.addEventListener('keydown', e => e.key === 'Enter' && activate());
  });
}

function showClusterPreview(cluster, stale) {
  detailEl.innerHTML = `<div class="dialog-head"><div><h3>附近 ${cluster.count} 家书店</h3><p>${stale ? '缓存结果，不代表实时状态' : '同一查询版聚合结果'}</p></div><button class="close" data-close>关闭</button></div>
    <div class="detail-block">${cluster.preview.map(s => `<button class="ghost-link" style="color:#102033;border-color:#c9b48e" data-store="${s.id}">${s.name} · ${s.status === 'open' ? '营业' : '闭店'}</button>`).join('')}</div>`;
  dialog.showModal();
}

async function openStore(id) {
  dialog.showModal();
  detailEl.innerHTML = '<div class="empty">正在读取服务端计算的状态和场次…</div>';
  try {
    const data = await api(`/api/stores/${encodeURIComponent(id)}`);
    renderStoreDetail(data);
  } catch (error) {
    if (error.code === 'STORE_MERGED') {
      detailEl.innerHTML = `<div class="empty">门店已合并到 <b>${error.body.message}</b>，正在打开承接门店…</div>`;
      setTimeout(() => openStore(error.body.redirectStoreId), 800);
    } else {
      detailEl.innerHTML = `<div class="empty">${error.message}</div>`;
    }
  }
}

function renderStoreDetail({ store, status, sessions }) {
  const isOpen = status?.state === 'open';
  detailEl.innerHTML = `<div class="dialog-head">
    <div><h3>${store.name}</h3><p>${store.city} · ${store.address}</p></div>
    <button class="close" data-close>关闭</button>
  </div>
  <p>${store.description}</p>
  <div class="detail-block">
    <h4>服务端营业状态</h4>
    <span class="open-badge ${isOpen ? 'open' : 'closed'}">${isOpen ? '营业中' : '闭店中'}</span>
    <p class="address">状态基准 ${status ? new Date(status.valid_at_ms || status.computed_at_ms).toISOString() : ''}；下次变化 ${status ? new Date(status.next_change_ms).toISOString() : ''}；缓存到期点与下次变化一致。</p>
  </div>
  <div class="detail-block"><h4>近期场次</h4>
    ${sessions.length ? sessions.map(eventHtml).join('') : '<div class="empty">暂无可报名场次</div>'}
  </div>`;
}

function eventHtml(e) {
  const closed = e.closedRequired && !e.authorized;
  const full = e.remaining <= 0;
  const expired = e.endsAt <= Date.now();
  const warning = closed ? ' warning' : '';
  const note = closed
    ? '<b>闭店专场：等待显式授权，不会自动取消，也不会自动放行。</b>'
    : e.closedRequired
      ? `<b>闭店私场已显式授权：</b>${e.authorizationNote || ''}`
      : '营业时段活动';
  const button = expired ? '<button disabled>已结束</button>' : closed
    ? '<button disabled>待授权</button>'
    : full ? '<button disabled>已满</button>'
    : '<button type="submit">抢占席位</button>';
  return `<div class="event${warning}" data-session="${e.id}">
    <b>${e.title}</b>
    <p class="address">${formatLocal(e)}${e.dstRepeated ? ` · DST ${e.dstChoice === 'second' ? '第二个重复时段' : '第一个重复时段'}` : ''}${e.dstGap ? ' · 春季不存在时间，顺延' : ''}</p>
    <p class="address">${note} · 剩余 ${e.remaining}/${e.capacity}</p>
    ${expired || closed || full ? button : `<form data-booking="${e.id}">
      <input name="contactName" placeholder="姓名" required />
      <input name="contactEmail" type="email" placeholder="邮箱" required />
      ${button}
    </form>`}
  </div>`;
}

listEl.addEventListener('click', e => {
  const card = e.target.closest('.store-card');
  if (card) openStore(card.dataset.id);
});
prevBtn.addEventListener('click', async () => { if (state.page > 1) { state.page--; await fetchList(); } });
nextBtn.addEventListener('click', async () => { if (state.page < Math.ceil(state.total / state.pageSize)) { state.page++; await fetchList(); } });
form.addEventListener('submit', async e => { e.preventDefault(); await runSearch(); });

detailEl.addEventListener('click', e => {
  if (e.target.matches('[data-close]')) dialog.close();
  const storeBtn = e.target.closest('[data-store]');
  if (storeBtn) openStore(storeBtn.dataset.store);
});
detailEl.addEventListener('submit', async e => {
  const formEl = e.target.closest('form[data-booking]');
  if (!formEl) return;
  e.preventDefault();
  const sessionId = formEl.dataset.booking;
  const payload = Object.fromEntries(new FormData(formEl).entries());
  payload.seats = 1;
  try {
    const result = await api(`/api/sessions/${sessionId}/bookings`, {
      method: 'POST', body: JSON.stringify(payload)
    });
    toast(`报名成功，回执码 ${result.code}，剩余 ${result.remaining} 席`);
    await openStore(result.receipt.actual_session ? sessionId : sessionId);
  } catch (error) {
    toast(error.message);
    const open = await api(`/api/sessions/${sessionId}`);
    formEl.closest('.event').outerHTML = eventHtml({ ...open });
  }
});

$('#receipt-form').addEventListener('submit', async e => {
  e.preventDefault();
  const code = new FormData(e.currentTarget).get('code').trim();
  const out = $('#receipt-result');
  try {
    const data = await api(`/api/bookings/${encodeURIComponent(code)}`);
    const r = data.receipt;
    out.innerHTML = `<b>${r.event_title}</b><br>回执码：${r.code}<br>
      实际场次：${r.actual_session.starts_local} → ${r.actual_session.ends_local}（${r.actual_session.timezone}）<br>
      UTC：${new Date(r.actual_session.starts_ms).toISOString()} → ${new Date(r.actual_session.ends_ms).toISOString()}<br>
      门店：${r.store.name}（合并/更名后回执仍保留原名快照；当前名：${data.currentStoreName}）<br>
      席位：${r.seats} · 闭店授权：${r.closure_authorized ? '已显式授权' : '不适用'}<br>
      绑定校验：${data.actualBindingCheck.startsMsMatchesReceipt && data.actualBindingCheck.endsMsMatchesReceipt ? '通过' : '失败'}`;
  } catch (error) { out.textContent = error.message; }
});

loadFacets();
