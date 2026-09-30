'use strict';

const $ = (sel) => document.querySelector(sel);
const state = {
  qv: null, page: 1, pageSize: 4, totalPages: 1, zoom: 3,
  list: null, map: null, events: null, stores: [], lastUpdatedAt: null,
  offline: false, selectedEvent: null
};

const CACHE_KEY = 'bookbar:last-successful-query-v1';

function fmt(ms, timeZone) {
  if (!ms) return '—';
  const tz = timeZone || Intl.DateTimeFormat().resolvedOptions().timeZone;
  return new Intl.DateTimeFormat('zh-CN', {
    dateStyle: 'medium', timeStyle: 'short', timeZone: tz, hour12: false
  }).format(new Date(ms));
}
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
async function api(path, options = {}) {
  const res = await fetch(path, {
    ...options,
    headers: { 'content-type': 'application/json', ...(options.headers || {}) }
  });
  let body = null;
  try { body = await res.json(); } catch (_) { body = {}; }
  if (!res.ok) {
    const err = new Error(body.error || `HTTP ${res.status}`);
    err.status = res.status; err.body = body;
    throw err;
  }
  return body;
}
function setOffline(msg) {
  state.offline = true;
  const b = $('#offlineBanner');
  b.hidden = false;
  b.textContent = `${msg} 正在显示本机上次成功更新：${fmt(state.lastUpdatedAt)}（浏览器时区）。该数据只作离线参考，不标作当前营业状态。`;
}
function clearOffline() {
  state.offline = false; $('#offlineBanner').hidden = true;
}
function saveCache() {
  localStorage.setItem(CACHE_KEY, JSON.stringify({ savedAt: Date.now(), state: {
    qv: state.qv, list: state.list, map: state.map, events: state.events
  }}));
  state.lastUpdatedAt = Date.now();
}
function loadCache(msg) {
  const raw = localStorage.getItem(CACHE_KEY);
  if (!raw) { alert(msg); return false; }
  const cached = JSON.parse(raw);
  Object.assign(state, cached.state);
  state.lastUpdatedAt = cached.savedAt;
  setOffline(msg);
  renderAll();
  return true;
}

async function loadStores() {
  const data = await api('/api/stores');
  state.stores = data.items;
  populateStoreControls();
}
function populateStoreControls() {
  const themes = [...new Set(state.stores.filter(s => s.active).flatMap(s => s.themes))].sort();
  $('#theme').innerHTML = '<option value="">全部主题</option>' + themes.map(t => `<option>${esc(t)}</option>`).join('');
  const options = '<option value="">选择门店</option>' + state.stores.filter(s => s.active).map(s => `<option value="${s.id}">${esc(s.name)}</option>`).join('');
  $('#exceptionStore').innerHTML = options;
  $('#renameStore').innerHTML = options;
  const all = state.stores.map(s => `<option value="${s.id}">${esc(s.name)}${s.active ? '' : '（已停用）'}</option>`).join('');
  $('#mergeSource').innerHTML = all;
  $('#mergeTarget').innerHTML = state.stores.filter(s => s.active).map(s => `<option value="${s.id}">${esc(s.name)}</option>`).join('');
}

async function createQuery() {
  const payload = {
    q: $('#q').value.trim(),
    themes: $('#theme').value ? [$('#theme').value] : [],
    minSeats: $('#minSeats').value || undefined,
    seatFeatures: $('#seatFeature').value ? [$('#seatFeature').value] : [],
    openNow: $('#openNow').checked,
    eventTitle: $('#eventTitle').value.trim() || undefined,
    authorizedClosedEvents: $('#authorizedOnly').checked
  };
  try {
    state.qv = await api('/api/query-versions', { method: 'POST', body: JSON.stringify(payload) });
    state.page = 1;
    await Promise.all([refreshList(false), refreshMap(false), refreshEvents(false)]);
    clearOffline(); saveCache();
  } catch (err) {
    if (!loadCache('网络失败，无法生成新查询版。')) throw err;
  }
}
async function refreshList(allowCache = true) {
  if (!state.qv) return;
  try {
    state.list = await api(`/api/query-versions/${state.qv.queryVersionId}/stores?page=${state.page}&pageSize=${state.pageSize}`);
    renderList();
  } catch (err) {
    if (err.status === 410) return createQuery();
    if (allowCache && loadCache('网络失败，无法刷新列表。')) return;
    throw err;
  }
}
async function refreshMap(allowCache = true) {
  if (!state.qv) return;
  try {
    state.map = await api(`/api/query-versions/${state.qv.queryVersionId}/map?zoom=${state.zoom}`);
    renderMap();
  } catch (err) {
    if (err.status === 410) return createQuery();
    if (allowCache && loadCache('网络失败，无法刷新地图。')) return;
    throw err;
  }
}
async function refreshEvents(allowCache = true) {
  if (!state.qv) return;
  try {
    state.events = await api(`/api/query-versions/${state.qv.queryVersionId}/events`);
    renderEvents();
  } catch (err) {
    if (err.status === 410) return createQuery();
    if (allowCache && loadCache('网络失败，无法刷新活动。')) return;
    throw err;
  }
}
function renderAll() { renderVersion(); renderList(); renderMap(); renderEvents(); }
function renderVersion() {
  const bar = $('#versionBar');
  if (!state.qv) return;
  const left = Math.max(0, state.qv.expiresAt - Date.now());
  const expireText = fmt(state.qv.expiresAt);
  bar.classList.remove('muted'); bar.classList.add('live');
  bar.innerHTML = `同一查询版 <code>${state.qv.queryVersionId}</code> 同时驱动地图聚合和列表分页；生成于 ${fmt(state.qv.generatedAt)}，精确到期点 ${expireText}（约 ${Math.ceil(left/1000)} 秒）。数据版 ${state.qv.dataVersion} / 排程版 ${state.qv.scheduleVersion}。手工更正会让此版立即失效。`;
  const exportLink = $('#exportLink');
  exportLink.classList.remove('button-disabled');
  exportLink.href = `/api/query-versions/${state.qv.queryVersionId}/export.csv`;
  exportLink.setAttribute('aria-disabled','false');
  exportLink.onclick = null;
}
function statusLabel(status) {
  return status === 'open'
    ? '<span class="status-dot open">营业中（生成时）</span>'
    : '<span class="status-dot closed">休息中（生成时）</span>';
}
function renderList() {
  const el = $('#storeList');
  if (!state.list) { el.className = 'store-list empty'; el.textContent = '请先生成查询。'; return; }
  state.page = state.list.page; state.totalPages = state.list.totalPages;
  $('#pageInfo').textContent = `${state.list.page} / ${state.list.totalPages} · 共 ${state.list.total} 家`;
  $('#prevPage').disabled = state.page <= 1; $('#nextPage').disabled = state.page >= state.totalPages;
  el.className = 'store-list';
  el.innerHTML = state.list.items.map(s => `
    <article class="store-card" tabindex="0" data-id="${s.id}" role="button">
      <div style="display:flex;justify-content:space-between;gap:10px"><h3>${esc(s.name)}</h3>${statusLabel(s.statusAtGeneration)}</div>
      <div class="store-meta">${esc(s.address)} · ${esc(s.timeZone)} · ${s.totalSeats} 个座位</div>
      <div class="tag-row">${s.themes.map(t => `<span class="tag">${esc(t)}</span>`).join('')}</div>
      <div class="store-meta">下次状态变更：${s.stateChangedAt ? fmt(s.stateChangedAt, s.timeZone) : '暂无'}</div>
    </article>`).join('');
  el.querySelectorAll('.store-card').forEach(card => {
    card.onclick = () => showStore(card.dataset.id);
    card.onkeydown = (e) => { if (e.key === 'Enter') showStore(card.dataset.id); };
  });
}
function project(lat, lng) {
  return { x: (lng + 170) / 340 * 1000, y: (82 - lat) / 132 * 520 };
}
function renderMap() {
  const g = $('#markers');
  if (!state.map) { g.innerHTML = ''; return; }
  g.innerHTML = state.map.clusters.map((c, i) => {
    const p = project(c.lat, c.lng);
    if (c.single) {
      const s = c.single;
      return `<g class="marker ${s.statusAtGeneration === 'open' ? 'open' : 'closed'}" data-id="${s.id}" transform="translate(${p.x},${p.y})">
        <circle class="halo" r="20"></circle><path class="pin" d="M0-34C12-34 20-25 20-14 20 2 0 20 0 20S-20 2-20-14C-20-25-12-34 0-34Z" transform="scale(.72)"/>
        <text y="-14">${s.statusAtGeneration === 'open' ? '开' : '休'}</text></g>`;
    }
    return `<g class="marker cluster" data-tip="${c.count} 家书店；${c.openCount} 家生成时营业，共 ${c.totalSeats} 座" transform="translate(${p.x},${p.y})">
      <circle class="pin" r="18"></circle><text>${c.count}</text></g>`;
  }).join('');
  g.querySelectorAll('.marker').forEach(m => {
    m.onmouseenter = () => {
      $('#mapTip').textContent = m.dataset.tip || (m.dataset.id ? '点击查看书店详情' : '');
    };
    if (m.dataset.id) m.onclick = () => showStore(m.dataset.id);
  });
}
function renderEvents() {
  const el = $('#eventList');
  if (!state.events) return;
  if (!state.events.events.length) { el.textContent = '此查询没有匹配活动。'; return; }
  el.innerHTML = state.events.events.map(ev => `
    <article class="event-card">
      <div><h3>${esc(ev.title)}</h3><div class="event-time">${fmt(ev.startsAt)} → ${fmt(ev.endsAt)}</div></div>
      <p class="store-meta">余位 <strong>${ev.remaining}</strong> / ${ev.capacity}</p>
      <div class="tag-row">
        <span class="badge ${ev.access}">${ev.access === 'open' ? '营业时段' : ev.access === 'mixed' ? '部分闭店' : '闭店专场'}</span>
        ${ev.requiresClosedAuthorization ? `<span class="badge ${ev.authorized ? 'authorized' : 'closed'}">${ev.authorized ? '已显式授权' : '未授权：拒绝报名'}</span>` : ''}
      </div>
      <button class="primary" data-event='${esc(JSON.stringify(ev))}'>预约席位</button>
    </article>`).join('');
  el.querySelectorAll('button[data-event]').forEach(btn => btn.onclick = () => openRegister(JSON.parse(btn.dataset.event)));
}
async function showStore(id) {
  try {
    const s = await api(`/api/stores/${id}`);
    const st = s.status;
    $('#storeDetail').innerHTML = `
      <h2>${esc(s.name)}</h2>
      <p class="store-meta">${esc(s.address)} · ${esc(s.timeZone)} · ${fmt(Date.now(), s.timeZone)} 当地时间</p>
      ${s.mergedInto ? `<p class="badge closed">已并入：${esc(s.mergedInto.name)}</p>` : ''}
      <p>${esc(s.description)}</p>
      <div class="detail-hours">
        <strong>服务端实时比较：</strong>${st ? (st.isOpen ? '当前营业' : '当前休息') : '门店已停用'}<br>
        实时状态来源：${st?.source || '—'}；预生成来源：${st?.pregenerated?.source || '—'}；
        一致：${st?.comparison?.matches ? '是' : '否'}；修复：${st?.comparison?.repaired ? '已触发重算' : '否'}<br>
        状态变更点：${st?.stateChangedAt ? fmt(st.stateChangedAt, s.timeZone) : '—'}
      </div>
      <div class="tag-row">${s.themes.map(t => `<span class="tag">${esc(t)}</span>`).join('')}</div>
      <h3>近期活动</h3>${(s.upcomingEvents || []).map(ev => `<div class="event-card"><strong>${esc(ev.title)}</strong><span class="event-time">${fmt(ev.startsAt,s.timeZone)} → ${fmt(ev.endsAt,s.timeZone)}</span><span class="badge ${ev.access.access}">${ev.access.access}</span><button class="ghost" data-event-id="${ev.id}">报名</button></div>`).join('') || '<p>暂无活动</p>'}
    `;
    $('#storeDialog').showModal();
    $('#storeDetail').querySelectorAll('[data-event-id]').forEach(b => b.onclick = async () => {
      const ev = await api(`/api/events/${b.dataset.eventId}`);
      const storeName = s.name;
      openRegister({ id: ev.id, title: ev.title, startsAt: ev.starts_at, endsAt: ev.ends_at, capacity: ev.capacity, remaining: ev.remaining, access: ev.assessment.access, authorized: ev.assessment.authorized, requiresClosedAuthorization: Boolean(ev.requires_closed_authorization), storeName });
    });
  } catch (err) { alert(err.message); }
}
function openRegister(ev) {
  state.selectedEvent = ev;
  $('#registerEventId').value = ev.id;
  $('#registerEventTitle').innerHTML = `${esc(ev.title)}<br><span class="event-time">${fmt(ev.startsAt)} → ${fmt(ev.endsAt)} · 余位 ${ev.remaining}</span>`;
  $('#receipt').innerHTML = ev.requiresClosedAuthorization && !ev.authorized
    ? '<p class="badge closed">闭店专场尚未显式授权。系统不会自动取消，也不会自动放行；请店长授权后再试。</p>' : '';
  $('#registerDialog').showModal();
}
$('#registerForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    const r = await api(`/api/events/${$('#registerEventId').value}/registrations`, {
      method: 'POST',
      body: JSON.stringify({ attendeeName: $('#attendeeName').value, attendeeContact: $('#attendeeContact').value, seats: Number($('#seats').value) })
    });
    const a = r.registration.actualSession;
    $('#receipt').innerHTML = `<div class="receipt-paper"><p class="receipt-code">${r.registration.confirmationCode}</p>
      <p>预约已绑定实际场次，而非仅活动模板：</p>
      <p><strong>${esc(a.storeName)} · ${esc(a.title)}</strong><br>${fmt(a.startsAt,a.timeZone)} → ${fmt(a.endsAt,a.timeZone)}<br>场次版本 ${a.sessionVersion} · ${r.registration.seats} 席 · 剩余 ${r.remaining}</p></div>`;
    await refreshEvents(false);
  } catch (err) {
    $('#receipt').innerHTML = `<p class="badge closed">${esc(err.message)}</p>`;
  }
});

$('#searchForm').addEventListener('submit', (e) => { e.preventDefault(); createQuery(); });
$('#prevPage').onclick = async () => { state.page -= 1; await refreshList(); };
$('#nextPage').onclick = async () => { state.page += 1; await refreshList(); };
$('#zoomIn').onclick = () => { state.zoom = Math.min(12, state.zoom + 1); refreshMap(); };
$('#zoomOut').onclick = () => { state.zoom = Math.max(0, state.zoom - 1); refreshMap(); };
$('#adminToggle').onclick = () => { $('#adminPanel').hidden = !$('#adminPanel').hidden; $('#adminPanel').scrollIntoView({ behavior: 'smooth' }); };
$('#tokenForm').addEventListener('submit', e => { e.preventDefault(); localStorage.setItem('adminToken', $('#adminToken').value); alert('令牌已保存'); });
$('#adminToken').value = localStorage.getItem('adminToken') || 'dev-manager-token';
async function adminFetch(path, method = 'POST', body) {
  const res = await fetch(path, { method, headers: { 'content-type': 'application/json', 'x-admin-token': localStorage.getItem('adminToken') }, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json(); if (!res.ok) throw Object.assign(new Error(data.error), { data });
  return data;
}
function showAdmin(data) { $('#adminResult').textContent = JSON.stringify(data, null, 2); }
$('#exceptionForm').addEventListener('submit', async e => {
  e.preventDefault();
  try {
    const kind = $('#exceptionKind').value;
    const body = { localDate: $('#exceptionDate').value, kind, reason: $('#exceptionReason').value };
    if (kind === 'modified') { body.startMinute = Number($('#exceptionStart').value); body.endMinute = Number($('#exceptionEnd').value); }
    showAdmin(await adminFetch(`/api/admin/stores/${$('#exceptionStore').value}/exceptions`, 'POST', body));
    await loadStores(); await createQuery();
  } catch (err) { showAdmin({ error: err.message, details: err.data }); }
});
$('#renameForm').addEventListener('submit', async e => { e.preventDefault(); try { showAdmin(await adminFetch(`/api/admin/stores/${$('#renameStore').value}/rename`, 'POST', { name: $('#newName').value })); await loadStores(); await createQuery(); } catch(err){showAdmin({error:err.message});} });
$('#mergeForm').addEventListener('submit', async e => { e.preventDefault(); try { showAdmin(await adminFetch('/api/admin/merge','POST',{ sourceId: $('#mergeSource').value,targetId: $('#mergeTarget').value })); await loadStores(); await createQuery(); } catch(err){showAdmin({error:err.message});} });
$('#authForm').addEventListener('submit', async e => { e.preventDefault(); try { showAdmin(await adminFetch(`/api/admin/events/${$('#authEventId').value.trim()}/authorize`,'POST',{ note: $('#authNote').value })); await createQuery(); } catch(err){showAdmin({error:err.message});} });
$('#rebuildBtn').onclick = async () => { try { showAdmin(await adminFetch('/api/admin/schedules/rebuild','POST',{})); await createQuery(); } catch(err){showAdmin({error:err.message});} };

$('#exportLink').addEventListener('click', (e) => {
  if ($('#exportLink').classList.contains('button-disabled')) e.preventDefault();
});

(async function init() {
  try { await loadStores(); } catch (err) { console.warn(err); }
  const cached = JSON.parse(localStorage.getItem(CACHE_KEY) || 'null');
  if (cached) {
    Object.assign(state, cached.state); state.lastUpdatedAt = cached.savedAt;
    setOffline('已载入上次离线缓存。');
  }
  renderAll();
})();
