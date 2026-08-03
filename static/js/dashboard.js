/**
 * dashboard.js — Volteo Maritime MARPOL Compliance Dashboard v4.0
 * Module boundaries: config | dom | auth | api | health | views | state
 *                     maps | history | panels | toasts | kpis | boot
 */
'use strict';

import { GlobeController } from './globe.js';
import { ZonesOverlay }    from './zones-overlay.js';

/* ═══════════════════ CONFIG ═══════════════════ */

const RAILWAY_API    = 'https://volteo-maritime-marpol-zone-api.up.railway.app';
const DEMO_API_KEY   = 'volteo-demo-key-2026';
const HEALTH_POLL_MS = 15_000;
const HISTORY_LIMIT  = 30;
const TILE_URL       = 'https://{s}.basemaps.cartocdn.com/dark_matter/{z}/{x}/{y}{r}.png';
const TILE_OPTIONS   = { maxZoom: 19, subdomains: 'abcd', attribution: '&copy; OpenStreetMap &copy; CARTO' };
const INITIAL_VIEW   = { center: [20, 0], zoom: 2 };
const COLORS         = { safe: '#00e676', warn: '#ff6b35', primary: '#00d4ff' };

const apiBase = () => {
  const override = document.getElementById('apiBase')?.value?.trim().replace(/\/+$/, '');
  if (override) return override;
  const origin  = window.location.origin;
  const isLocal = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
  return isLocal || origin === RAILWAY_API ? origin : RAILWAY_API;
};

const ENDPOINTS = {
  health:       '/health',
  authToken:    '/auth/token',
  checkZone:    '/api/v1/check-zone',
  checkSlop:    '/api/v1/check-slop',
  checkRoute:   '/api/v1/check-route',
  zonesGeoJson: '/api/v1/zones/geojson',
};

/* ═══════════════════ DOM HELPERS ═══════════════════ */

const $        = id => document.getElementById(id);
const escHtml  = v  => { const n = document.createElement('div'); n.textContent = String(v ?? ''); return n.innerHTML; };
const fmt      = (v, d = 2) => (v == null || isNaN(+v)) ? '—' : (+v).toFixed(d);
const safeArr  = v  => Array.isArray(v) ? v : [];
const numFrom  = id => { const p = parseFloat($(id)?.value); return isNaN(p) ? null : p; };
const textFrom = (id, fb = '') => $(id)?.value?.trim() || fb;
const boolFrom = id => !!($(id)?.checked);

/* ═══════════════════ TOASTS ═══════════════════ */

function toast(message, type = 'info') {
  const stack = $('toastStack');
  if (!stack) return;
  const el = document.createElement('div');
  el.className = `toast toast-${type}`;
  el.innerHTML = `<span>${escHtml(message)}</span>`;
  stack.appendChild(el);
  requestAnimationFrame(() => el.classList.add('show'));
  setTimeout(() => {
    el.classList.remove('show');
    setTimeout(() => el.remove(), 300);
  }, 4200);
}

/* ═══════════════════ AUTH (JWT) ═══════════════════ */

const auth = (() => {
  let _token = null, _expiry = 0, _inflight = null;

  async function fetchToken() {
    const url = `${apiBase()}${ENDPOINTS.authToken}?api_key=${DEMO_API_KEY}`;
    let res;
    try {
      res = await fetch(url, { method: 'POST' });
    } catch (e) {
      throw new ApiProblem({ type: 'about:blank', title: 'Auth network error', status: 0,
        detail: `Could not reach ${url}. ${e.message}`, instance: ENDPOINTS.authToken });
    }
    if (!res.ok) {
      throw new ApiProblem({ type: 'about:blank', title: 'Authentication failed', status: res.status,
        detail: `POST /auth/token returned HTTP ${res.status}.`, instance: ENDPOINTS.authToken });
    }
    const data = await res.json();
    _token  = data.access_token;
    _expiry = Date.now() + ((data.expires_in || 900) - 30) * 1000;
    return _token;
  }

  return {
    async getToken() {
      if (_token && Date.now() < _expiry) return _token;
      if (!_inflight) _inflight = fetchToken().finally(() => { _inflight = null; });
      return _inflight;
    },
    invalidate() { _token = null; _expiry = 0; },
  };
})();

/* ═══════════════════ API LAYER ═══════════════════ */

class ApiProblem extends Error {
  constructor(problem) {
    super(problem.detail || problem.title || 'Request failed');
    this.name = 'ApiProblem';
    this.problem = problem;
  }
}

async function request(path, opts = {}, _retry = false) {
  const token = await auth.getToken();
  const url = `${apiBase()}${path}`;
  const headers = Object.assign({ 'Authorization': `Bearer ${token}` }, opts.headers || {});
  const t0 = performance.now();
  let res;
  try {
    res = await fetch(url, { ...opts, headers });
  } catch (e) {
    throw new ApiProblem({ type: 'about:blank', title: 'Network error', status: 0,
      detail: `Could not reach API at ${url}. ${e.message}`, instance: path });
  }
  recordLatency(performance.now() - t0);

  if (res.status === 401 && !_retry) {
    auth.invalidate();
    return request(path, opts, true);
  }

  const ct   = res.headers.get('content-type') || '';
  const body = ct.includes('json') ? await res.json().catch(() => null) : null;
  if (res.ok) return body;
  if (body?.title && 'status' in body) throw new ApiProblem(body);
  throw new ApiProblem({
    type: 'about:blank',
    title: `Request failed (${res.status})`,
    status: res.status,
    detail: typeof body?.detail === 'string' ? body.detail : body?.detail ? JSON.stringify(body.detail) : `HTTP ${res.status}`,
    instance: path,
  });
}

const postJson = (path, payload) =>
  request(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });

/* ═══════════════════ HEALTH + KPIs ═══════════════════ */

let latencySamples = [];
function recordLatency(ms) {
  latencySamples.push(ms);
  if (latencySamples.length > 10) latencySamples.shift();
  const avg = latencySamples.reduce((a, b) => a + b, 0) / latencySamples.length;
  if ($('kpiLatency')) $('kpiLatency').textContent = `${Math.round(avg)} ms`;
}

async function pollHealth() {
  const dot = $('healthDot'), label = $('healthLabel');
  if (!dot || !label) return;
  try {
    const data = await request(ENDPOINTS.health);
    const ok = data?.status === 'ok' || data?.status === 'healthy';
    dot.style.background = ok ? COLORS.safe : COLORS.warn;
    dot.style.boxShadow  = ok ? `0 0 8px ${COLORS.safe}` : `0 0 8px ${COLORS.warn}`;
    label.textContent = ok ? 'API Online' : 'API Degraded';
    label.style.color = ok ? COLORS.safe : COLORS.warn;
  } catch {
    dot.style.background = COLORS.warn;
    dot.style.boxShadow  = `0 0 8px ${COLORS.warn}`;
    label.textContent = 'API Offline';
    label.style.color = COLORS.warn;
    toast('API appears offline. Retrying…', 'warn');
  }
}

function updateKpis() {
  const list = historyLoad();
  const today = new Date().toDateString();
  const todayList = list.filter(h => new Date(h.time && h.timestamp || Date.now()).toDateString() === today);
  const total = list.length;
  const safeCount = list.filter(h => h.status === 'SAFE').length;
  if ($('kpiChecks')) $('kpiChecks').textContent = String(total);
  if ($('kpiCompliance')) $('kpiCompliance').textContent = total ? `${Math.round((safeCount / total) * 100)}%` : '—';
}

/* ═══════════════════ VIEW RENDERERS ═══════════════════ */

function statusBadge(status) {
  const safe = (status === 'SAFE');
  return `<span class="status-badge ${safe ? 'badge-safe' : 'badge-restricted'}">
    ${safe ? '✓ SAFE' : '✗ RESTRICTED'}
  </span>`;
}

function ruleRow(rule) {
  const pass = rule.passed;
  return `
    <div class="rule-row ${pass ? 'rule-pass' : 'rule-fail'}">
      <span class="rule-icon">${pass ? '✓' : '✗'}</span>
      <div class="rule-body">
        <div class="rule-name">${escHtml(rule.rule_name)}</div>
        <div class="rule-vals">
          <span>Got: <strong>${escHtml(rule.actual_value)}</strong></span>
          <span>Req: <strong>${escHtml(rule.required_value)}</strong></span>
        </div>
        ${rule.note ? `<div class="rule-note">${escHtml(rule.note)}</div>` : ''}
      </div>
    </div>`;
}

function zonesTable(zones) {
  if (!zones.length) return '<p class="empty-state">No active MARPOL zones at this position.</p>';
  return `
    <table class="data-table">
      <thead><tr><th>Zone</th><th>Annex</th><th>Waste Type</th><th>Restriction</th></tr></thead>
      <tbody>
        ${zones.map(z => `
          <tr>
            <td>${escHtml(z.zone_name)}</td>
            <td>${escHtml(z.annex)}</td>
            <td>${escHtml(z.waste_type)}</td>
            <td>${escHtml(z.restriction)}</td>
          </tr>`).join('')}
      </tbody>
    </table>`;
}

function disposalList(items) {
  if (!items.length) return '';
  return items.map(item => `
    <div class="disposal-item ${item.allowed ? 'allowed' : 'disallowed'}">
      <span>${item.allowed ? '✓' : '✗'}</span>
      <div><strong>${escHtml(item.label)}</strong><p>${escHtml(item.reason)}</p></div>
    </div>`).join('');
}

function routeMetrics(d) {
  return `
    <div class="route-metrics">
      <div class="metric"><span>Cross-track</span><strong>${fmt(d.cross_track_distance_nm)} NM</strong></div>
      <div class="metric"><span>Progress</span><strong>${fmt(d.route_progress_percent, 1)}%</strong></div>
      <div class="metric"><span>Route Length</span><strong>${fmt(d.total_route_distance_nm)} NM</strong></div>
      <div class="metric"><span>Along-track</span><strong>${fmt(d.along_track_distance_nm)} NM</strong></div>
    </div>`;
}

function skeleton() {
  return `<div class="skeleton-block"></div><div class="skeleton-block short"></div><div class="skeleton-block"></div>`;
}

/* ═══════════════════ STATE MACHINE ═══════════════════ */

const mkState = () => ({ loading: false, data: null, error: null });
const zoneSt  = mkState(), slopSt = mkState(), routeSt = mkState();

function setState(st, patch, renderFn) {
  Object.assign(st, patch);
  renderFn(st);
}

/* ═══════════════════ UNIFIED LEAFLET MAP ═══════════════════ */

let sharedMap, deckOverlay;
const layerGroups = { zone: null, slop: null, route: null };
let markers = { zone: null, slop: null, route: null };
let routePolyline = null;
let activePanel = 'zone';

function shipIcon(status) {
  const color = status === 'SAFE' ? COLORS.safe : COLORS.warn;
  return L.divIcon({
    className: '',
    html: `<div class="ship-marker" style="--c:${color}">
      <div class="ship-pulse"></div>
      <div class="ship-dot"></div>
    </div>`,
    iconSize: [34, 34], iconAnchor: [17, 17],
  });
}

function initMaps() {
  sharedMap = L.map('sharedMap', { zoomControl: true, attributionControl: true }).setView(INITIAL_VIEW.center, INITIAL_VIEW.zoom);
  L.tileLayer(TILE_URL, TILE_OPTIONS).addTo(sharedMap);

  layerGroups.zone  = L.layerGroup().addTo(sharedMap);
  layerGroups.slop  = L.layerGroup();
  layerGroups.route = L.layerGroup();

  sharedMap.on('click', e => {
    const lat = e.latlng.lat.toFixed(4), lon = e.latlng.lng.toFixed(4);
    if (activePanel === 'zone'  && $('lat'))      { $('lat').value = lat;      $('lon').value = lon; }
    if (activePanel === 'slop'  && $('slopLat'))  { $('slopLat').value = lat;  $('slopLon').value = lon; }
    if (activePanel === 'route' && $('routeLat')) { $('routeLat').value = lat; $('routeLon').value = lon; }
  });

  deckOverlay = new ZonesOverlay('sharedMap');
}

function loadZonesOverlay() {
  deckOverlay?.load(`${apiBase()}${ENDPOINTS.zonesGeoJson}`);
}

function switchPanel(panelKey) {
  Object.entries(layerGroups).forEach(([key, group]) => {
    if (key === panelKey) sharedMap.addLayer(group);
    else sharedMap.removeLayer(group);
  });
  activePanel = panelKey;
  setTimeout(() => sharedMap.invalidateSize(), 60);
}

function placeMarker(group, lat, lon, status, prevKey) {
  if (markers[prevKey]) group.removeLayer(markers[prevKey]);
  const marker = L.marker([lat, lon], { icon: shipIcon(status) }).addTo(group)
    .bindPopup(`<strong>${status === 'SAFE' ? '✓ SAFE' : '✗ RESTRICTED'}</strong><br>${fmt(lat, 4)}°, ${fmt(lon, 4)}°`);
  markers[prevKey] = marker;
  sharedMap.setView([lat, lon], Math.max(sharedMap.getZoom(), 5), { animate: true });
  return marker;
}

/* ═══════════════════ HISTORY ═══════════════════ */

const HISTORY_KEY = 'marpol_history_v4';

function historyLoad() {
  try { return JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]'); } catch { return []; }
}

function historyAdd(entry) {
  const list = [{ ...entry, time: new Date().toLocaleTimeString(), timestamp: Date.now() }, ...historyLoad()].slice(0, HISTORY_LIMIT);
  localStorage.setItem(HISTORY_KEY, JSON.stringify(list));
  renderHistory();
  updateKpis();
}

function renderHistory() {
  const el = $('historyList');
  if (!el) return;
  const list = historyLoad();
  if (!list.length) {
    el.innerHTML = '<p class="empty-state">No checks yet. Run a zone, slop, or route check above.</p>';
    return;
  }
  el.innerHTML = list.map((h, i) => `
    <div class="history-item" data-idx="${i}">
      <div class="history-meta">
        <span class="history-type">${escHtml(h.type)}</span>
        <span class="history-time">${escHtml(h.time)}</span>
      </div>
      <div style="margin: 0.25rem 0">${statusBadge(h.status)}</div>
      <div class="history-coords">${fmt(h.lat, 4)}°, ${fmt(h.lon, 4)}°</div>
      <div class="history-summary">${escHtml(h.summary)}</div>
    </div>`).join('');

  el.querySelectorAll('.history-item').forEach(item => {
    item.addEventListener('click', () => {
      const h = list[+item.dataset.idx];
      if (h) sharedMap.setView([h.lat, h.lon], 6, { animate: true });
    });
  });
}

/* ═══════════════════ ZONE PANEL ═══════════════════ */

function renderZone(st) {
  const out = $('zoneResult');
  if (!out) return;
  if (st.loading) { out.innerHTML = skeleton(); return; }
  if (st.error)   { out.innerHTML = `<div class="error-box">⚠ ${escHtml(st.error)}</div>`; return; }
  if (!st.data)   { out.innerHTML = '<p class="empty-state">Enter a position and run a check.</p>'; return; }
  const d = st.data;
  out.innerHTML = `
    <div class="result-header">
      ${statusBadge(d.zone_status)}
      <span class="result-dist">${fmt(d.distance_to_nearest_land_nm)} NM from nearest land</span>
    </div>
    <p class="result-summary">${escHtml(d.summary)}</p>
    <div class="section-label">Rules Checklist</div>
    <div class="rule-list">${safeArr(d.rules_checklist).map(ruleRow).join('') || '<p class="empty-state">No rules evaluated.</p>'}</div>
    <div class="section-label">Active Zones</div>
    ${zonesTable(safeArr(d.active_zones))}
    <div class="section-label">Disposal Assessment</div>
    <div class="disposal-list">${disposalList(safeArr(d.disposal_assessment))}</div>
  `;
}

async function submitZone(globe) {
  const lat = numFrom('lat'), lon = numFrom('lon');
  if (lat == null || lon == null) { toast('Please enter valid latitude and longitude.', 'warn'); return; }

  setState(zoneSt, { loading: true, error: null, data: null }, renderZone);
  try {
    const data = await postJson(ENDPOINTS.checkZone, {
      ship_id: textFrom('shipId', 'SHIP_001'), latitude: lat, longitude: lon,
      waste_type_filter: textFrom('wasteFilter') || null,
    });
    setState(zoneSt, { loading: false, data, error: null }, renderZone);
    globe?.setPin(lat, lon, data.zone_status);
    deckOverlay?.setShipPosition(lat, lon, data.zone_status);
    placeMarker(layerGroups.zone, lat, lon, data.zone_status, 'zone');
    historyAdd({ type: 'Zone Check', lat, lon, status: data.zone_status, summary: data.summary });
    toast(`Zone check complete: ${data.zone_status}`, data.zone_status === 'SAFE' ? 'success' : 'warn');
  } catch (e) {
    setState(zoneSt, { loading: false, data: null, error: e.message }, renderZone);
    toast(e.message, 'error');
  }
}

/* ═══════════════════ SLOP PANEL ═══════════════════ */

function renderSlop(st) {
  const out = $('slopResult');
  if (!out) return;
  if (st.loading) { out.innerHTML = skeleton(); return; }
  if (st.error)   { out.innerHTML = `<div class="error-box">⚠ ${escHtml(st.error)}</div>`; return; }
  if (!st.data)   { out.innerHTML = '<p class="empty-state">Enter discharge parameters and run a check.</p>'; return; }
  const d = st.data;
  out.innerHTML = `
    <div class="result-header">
      ${statusBadge(d.zone_status)}
      <span class="result-dist">${fmt(d.distance_to_nearest_land_nm)} NM from nearest land</span>
    </div>
    <p class="result-summary">${escHtml(d.summary)}</p>
    <div class="section-label">Rules Checklist</div>
    <div class="rule-list">${safeArr(d.rules_checklist).map(ruleRow).join('') || '<p class="empty-state">No rules evaluated.</p>'}</div>
    <div class="section-label">Active Oil / NLS Zones</div>
    ${zonesTable(safeArr(d.active_zones))}
  `;
}

async function submitSlop() {
  const lat = numFrom('slopLat'), lon = numFrom('slopLon');
  if (lat == null || lon == null) { toast('Please enter valid latitude and longitude.', 'warn'); return; }

  const cargo_is_nls = boolFrom('cargoIsNls');
  const nls_category = cargo_is_nls ? (textFrom('nlsCategory') || null) : null;

  setState(slopSt, { loading: true, error: null, data: null }, renderSlop);
  try {
    const data = await postJson(ENDPOINTS.checkSlop, {
      ship_id: textFrom('slopShipId', 'SHIP_001'), latitude: lat, longitude: lon,
      ship_speed_knots: numFrom('shipSpeed') ?? 0,
      oil_content_ppm: numFrom('oilContent') ?? 0,
      discharge_rate_lpnm: numFrom('dischargeRate') ?? 0,
      tank_capacity_m3: numFrom('tankCapacity') ?? 0,
      odmcs_operational: boolFrom('odmcsOp'),
      cargo_is_nls, nls_category,
    });
    setState(slopSt, { loading: false, data, error: null }, renderSlop);
    placeMarker(layerGroups.slop, lat, lon, data.zone_status, 'slop');
    historyAdd({ type: 'Slop Check', lat, lon, status: data.zone_status, summary: data.summary });
    toast(`Slop check complete: ${data.zone_status}`, data.zone_status === 'SAFE' ? 'success' : 'warn');
  } catch (e) {
    setState(slopSt, { loading: false, data: null, error: e.message }, renderSlop);
    toast(e.message, 'error');
  }
}

/* ═══════════════════ ROUTE PANEL ═══════════════════ */

function renderRoute(st) {
  const out = $('routeResult');
  if (!out) return;
  if (st.loading) { out.innerHTML = skeleton(); return; }
  if (st.error)   { out.innerHTML = `<div class="error-box">⚠ ${escHtml(st.error)}</div>`; return; }
  if (!st.data)   { out.innerHTML = '<p class="empty-state">Set current position and route endpoints, then run a check.</p>'; return; }
  const d = st.data;
  const routeSafe = (d.route_status === 'ON_ROUTE');

  out.innerHTML = `
    <div class="result-header">
      ${statusBadge(routeSafe ? 'SAFE' : 'RESTRICTED')}
      <span class="result-dist">${escHtml(d.route_status)}</span>
    </div>
    <p class="result-summary">${escHtml(d.summary)}</p>
    ${routeMetrics(d)}
    ${safeArr(d.zones_crossed).length ? `<div class="section-label">Zones Crossed</div>${zonesTable(d.zones_crossed)}` : ''}
  `;

  if (safeArr(d.route_points).length >= 2) {
    if (routePolyline) layerGroups.route.removeLayer(routePolyline);
    routePolyline = L.polyline(d.route_points, { color: COLORS.primary, weight: 3, opacity: 0.85 }).addTo(layerGroups.route);
    sharedMap.fitBounds(routePolyline.getBounds(), { padding: [40, 40] });
  }

  const rLat = numFrom('routeLat'), rLon = numFrom('routeLon');
  if (rLat != null && rLon != null) {
    placeMarker(layerGroups.route, rLat, rLon, routeSafe ? 'SAFE' : 'RESTRICTED', 'route');
  }
}

async function submitRoute() {
  setState(routeSt, { loading: true, error: null, data: null }, renderRoute);
  try {
    const data = await postJson(ENDPOINTS.checkRoute, {
      ship_id: textFrom('routeShipId', 'SHIP_001'),
      latitude: numFrom('routeLat') ?? 0, longitude: numFrom('routeLon') ?? 0,
      origin_port: textFrom('originPort') || null, destination_port: textFrom('destPort') || null,
      origin_latitude: numFrom('originLat'), origin_longitude: numFrom('originLon'),
      destination_latitude: numFrom('destLat'), destination_longitude: numFrom('destLon'),
      corridor_width_nm: numFrom('corridorWidth') ?? 25,
    });
    setState(routeSt, { loading: false, data, error: null }, renderRoute);
    historyAdd({
      type: 'Route Check', lat: numFrom('routeLat') ?? 0, lon: numFrom('routeLon') ?? 0,
      status: data.route_status === 'ON_ROUTE' ? 'SAFE' : 'RESTRICTED', summary: data.summary,
    });
    toast(`Route check complete: ${data.route_status}`, data.route_status === 'ON_ROUTE' ? 'success' : 'warn');
  } catch (e) {
    setState(routeSt, { loading: false, data: null, error: e.message }, renderRoute);
    toast(e.message, 'error');
  }
}

/* ═══════════════════ LEGEND / FILTER ═══════════════════ */

function bindLegend() {
  const boxes = document.querySelectorAll('#zoneLegend input[type=checkbox]');
  const apply = () => {
    const active = new Set([...document.querySelectorAll('#zoneLegend input:checked')].map(c => c.dataset.annex));
    deckOverlay?.setAnnexFilter(active);
  };
  boxes.forEach(cb => cb.addEventListener('change', apply));
}

/* ═══════════════════ NLS TOGGLE ═══════════════════ */

function bindNlsToggle() {
  const chk = $('cargoIsNls'), row = $('nlsCategoryRow');
  if (!chk || !row) return;
  const update = () => { row.style.display = chk.checked ? 'flex' : 'none'; };
  chk.addEventListener('change', update);
  update();
}

/* ═══════════════════ TABS ═══════════════════ */

function initTabs() {
  const panelMap = { zonePanel: 'zone', slopPanel: 'slop', routePanel: 'route' };
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
      btn.classList.add('active');
      const panel = $(btn.dataset.tab);
      if (panel) panel.classList.add('active');
      switchPanel(panelMap[btn.dataset.tab] || 'zone');
    });
  });
}

/* ═══════════════════ BOOT ═══════════════════ */

document.addEventListener('DOMContentLoaded', () => {
  setTimeout(() => $('loader')?.classList.add('hidden'), 900);

  const globe = new GlobeController('globe-canvas');
  initMaps();
  setTimeout(loadZonesOverlay, 1200);

  pollHealth();
  setInterval(pollHealth, HEALTH_POLL_MS);

  renderHistory();
  updateKpis();
  bindNlsToggle();
  bindLegend();
  initTabs();

  $('zoneSubmit')?.addEventListener('click', () => submitZone(globe));
  $('slopSubmit')?.addEventListener('click', submitSlop);
  $('routeSubmit')?.addEventListener('click', submitRoute);

  $('clearHistory')?.addEventListener('click', () => {
    localStorage.removeItem(HISTORY_KEY);
    renderHistory();
    updateKpis();
    toast('History cleared', 'info');
  });
});
