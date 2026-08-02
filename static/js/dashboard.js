/**
 * dashboard.js — Volteo Maritime MARPOL Compliance Dashboard v3.0
 *
 * Module boundaries:
 *   config | dom-helpers | api | health | views | state | maps | history
 *   panels (zone / slop / route) | nls-toggle | boot
 */

'use strict';

import { GlobeController } from './globe.js';
import { ZonesOverlay }    from './zones-overlay.js';

/* ═══════════════════════════════════════════════════════════════════════
   CONFIG
═══════════════════════════════════════════════════════════════════════ */

const RAILWAY_API    = 'https://volteo-maritime-marpol-zone-api.up.railway.app';
const HEALTH_POLL_MS = 15_000;
const HISTORY_LIMIT  = 30;
const TILE_URL       = 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png';
const TILE_OPTIONS   = { maxZoom: 18, attribution: '© OpenStreetMap contributors' };
const INITIAL_VIEW   = { center: [20, 0], zoom: 2 };
const COLORS         = { safe: '#00e676', warn: '#ff6b35', primary: '#00d4ff' };

/** Resolve API base: prefer explicit override input, then auto-detect origin */
const apiBase = () => {
  const override = document.getElementById('apiBase')?.value?.trim().replace(/\/+$/, '');
  if (override) return override;
  const origin  = window.location.origin;
  const isLocal = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
  return isLocal || origin === RAILWAY_API ? origin : RAILWAY_API;
};

const ENDPOINTS = {
  health:       '/health',
  checkZone:    '/api/v1/check-zone',
  checkSlop:    '/api/v1/check-slop',
  checkRoute:   '/api/v1/check-route',
  zonesGeoJson: '/api/v1/zones/geojson',
};

/* ═══════════════════════════════════════════════════════════════════════
   DOM HELPERS
═══════════════════════════════════════════════════════════════════════ */

const $        = id => document.getElementById(id);
const escHtml  = v  => { const n = document.createElement('div'); n.textContent = String(v ?? ''); return n.innerHTML; };
const fmt      = (v, d = 2) => (v == null || isNaN(+v)) ? '—' : (+v).toFixed(d);
const safeArr  = v  => Array.isArray(v) ? v : [];
const numFrom  = id => { const p = parseFloat($(id)?.value); return isNaN(p) ? null : p; };
const textFrom = (id, fb = '') => $(id)?.value?.trim() || fb;
const boolFrom = id => !!($(id)?.checked);

/* ═══════════════════════════════════════════════════════════════════════
   API LAYER
═══════════════════════════════════════════════════════════════════════ */

class ApiProblem extends Error {
  constructor(problem) {
    super(problem.detail || problem.title || 'Request failed');
    this.name    = 'ApiProblem';
    this.problem = problem;
  }
}

async function request(path, opts = {}) {
  const url = `${apiBase()}${path}`;
  let res;
  try {
    res = await fetch(url, opts);
  } catch (e) {
    throw new ApiProblem({
      type: 'about:blank', title: 'Network error', status: 0,
      detail: `Could not reach API at ${url}. ${e.message}`, instance: path,
    });
  }
  const ct   = res.headers.get('content-type') || '';
  const body = ct.includes('json') ? await res.json().catch(() => null) : null;
  if (res.ok) return body;
  if (body?.title && 'status' in body) throw new ApiProblem(body);
  throw new ApiProblem({
    type: 'about:blank',
    title: `Request failed (${res.status})`,
    status: res.status,
    detail: typeof body?.detail === 'string'
      ? body.detail
      : body?.detail ? JSON.stringify(body.detail) : `HTTP ${res.status}`,
    instance: path,
  });
}

const postJson = (path, payload) =>
  request(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

/* ═══════════════════════════════════════════════════════════════════════
   HEALTH POLLING
═══════════════════════════════════════════════════════════════════════ */

async function pollHealth() {
  const dot   = $('healthDot');
  const label = $('healthLabel');
  if (!dot || !label) return;
  try {
    const data = await request(ENDPOINTS.health);
    const ok   = data?.status === 'ok' || data?.status === 'healthy';
    dot.style.background  = ok ? COLORS.safe : COLORS.warn;
    dot.style.boxShadow   = ok ? `0 0 8px ${COLORS.safe}` : `0 0 8px ${COLORS.warn}`;
    label.textContent     = ok ? 'API Online' : 'API Degraded';
    label.style.color     = ok ? COLORS.safe  : COLORS.warn;
  } catch {
    dot.style.background  = COLORS.warn;
    dot.style.boxShadow   = `0 0 8px ${COLORS.warn}`;
    label.textContent     = 'API Offline';
    label.style.color     = COLORS.warn;
  }
}

/* ═══════════════════════════════════════════════════════════════════════
   VIEW RENDERERS (pure HTML builders)
═══════════════════════════════════════════════════════════════════════ */

function statusBadge(status) {
  const safe = (status === 'SAFE');
  return `<span class="status-badge ${safe ? 'badge-safe' : 'badge-restricted'}"
    style="animation: badgePop 0.4s cubic-bezier(.34,1.56,.64,1) both">
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
  if (!zones.length) {
    return '<p class="empty-state">No active MARPOL zones at this position.</p>';
  }
  return `
    <table class="data-table">
      <thead>
        <tr><th>Zone</th><th>Annex</th><th>Waste Type</th><th>Restriction</th></tr>
      </thead>
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
    <div class="disposal-item ${item.allowed ? 'disposal-allowed' : 'disposal-disallowed'}">
      <span class="disposal-icon">${item.allowed ? '✓' : '✗'}</span>
      <div>
        <strong>${escHtml(item.label)}</strong>
        <p>${escHtml(item.reason)}</p>
      </div>
    </div>`).join('');
}

function routeMetrics(d) {
  return `
    <div class="route-metrics">
      <div class="metric-card">
        <span class="metric-label">Cross-track</span>
        <strong class="metric-value">${fmt(d.cross_track_distance_nm)} NM</strong>
      </div>
      <div class="metric-card">
        <span class="metric-label">Progress</span>
        <strong class="metric-value">${fmt(d.route_progress_percent, 1)}%</strong>
      </div>
      <div class="metric-card">
        <span class="metric-label">Route Length</span>
        <strong class="metric-value">${fmt(d.total_route_distance_nm)} NM</strong>
      </div>
      <div class="metric-card">
        <span class="metric-label">Along-track</span>
        <strong class="metric-value">${fmt(d.along_track_distance_nm)} NM</strong>
      </div>
    </div>`;
}

/* ═══════════════════════════════════════════════════════════════════════
   STATE MACHINE (per panel)
═══════════════════════════════════════════════════════════════════════ */

const mkState   = ()            => ({ loading: false, data: null, error: null });
const zoneSt    = mkState();
const slopSt    = mkState();
const routeSt   = mkState();

function setState(st, patch, renderFn) {
  Object.assign(st, patch);
  renderFn(st);
}

/* ═══════════════════════════════════════════════════════════════════════
   LEAFLET MAP INSTANCES
═══════════════════════════════════════════════════════════════════════ */

let zoneMap, slopMap, routeMap;
let zoneMarker, slopMarker, routeMarker, routePolyline;
let deckOverlay;

function initMaps() {
  const tile = () => L.tileLayer(TILE_URL, TILE_OPTIONS);

  zoneMap  = L.map('zoneMap',  INITIAL_VIEW);  tile().addTo(zoneMap);
  slopMap  = L.map('slopMap',  INITIAL_VIEW);  tile().addTo(slopMap);
  routeMap = L.map('routeMap', INITIAL_VIEW);  tile().addTo(routeMap);

  // Click-to-set-coords on zone and slop maps
  zoneMap.on('click', e => {
    if ($('lat')) $('lat').value = e.latlng.lat.toFixed(4);
    if ($('lon')) $('lon').value = e.latlng.lng.toFixed(4);
  });
  slopMap.on('click', e => {
    if ($('slopLat')) $('slopLat').value = e.latlng.lat.toFixed(4);
    if ($('slopLon')) $('slopLon').value = e.latlng.lng.toFixed(4);
  });

  // deck.gl MARPOL zones overlay — loads lazily from API
  deckOverlay = new ZonesOverlay('zoneMap');
}

function loadZonesOverlay() {
  deckOverlay?.load(`${apiBase()}${ENDPOINTS.zonesGeoJson}`);
}

/**
 * Place or move a circle marker on a Leaflet map.
 * Returns the new marker instance.
 */
function placeMarker(map, lat, lon, status, existing) {
  if (existing) map.removeLayer(existing);
  const color = status === 'SAFE' ? COLORS.safe : COLORS.warn;
  const marker = L.circleMarker([lat, lon], {
    radius: 9, fillColor: color, color: '#fff',
    weight: 2.5, fillOpacity: 0.95,
  }).addTo(map);
  map.setView([lat, lon], Math.max(map.getZoom(), 5), { animate: true });
  return marker;
}

/* ═══════════════════════════════════════════════════════════════════════
   HISTORY (localStorage)
═══════════════════════════════════════════════════════════════════════ */

const HISTORY_KEY = 'marpol_history_v3';

function historyLoad() {
  try { return JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]'); } catch { return []; }
}

function historyAdd(entry) {
  const list = [{ ...entry, time: new Date().toLocaleTimeString() }, ...historyLoad()]
    .slice(0, HISTORY_LIMIT);
  localStorage.setItem(HISTORY_KEY, JSON.stringify(list));
  renderHistory();
}

function renderHistory() {
  const el = $('historyList');
  if (!el) return;
  const list = historyLoad();
  if (!list.length) {
    el.innerHTML = '<p class="empty-state">No checks yet. Run a zone, slop, or route check above.</p>';
    return;
  }
  el.innerHTML = list.map(h => `
    <div class="history-item">
      <div class="history-meta">
        <span class="history-type">${escHtml(h.type)}</span>
        <span class="history-time">${escHtml(h.time)}</span>
      </div>
      <div style="margin: 0.25rem 0">${statusBadge(h.status)}</div>
      <div class="history-coords">${fmt(h.lat, 4)}°, ${fmt(h.lon, 4)}°</div>
      <div class="history-summary">${escHtml(h.summary)}</div>
    </div>`).join('');
}

/* ═══════════════════════════════════════════════════════════════════════
   ZONE PANEL
═══════════════════════════════════════════════════════════════════════ */

function renderZone(st) {
  const out = $('zoneResult');
  if (!out) return;
  if (st.loading) { out.innerHTML = '<div class="spinner"></div>'; return; }
  if (st.error)   { out.innerHTML = `<div class="error-box">⚠ ${escHtml(st.error)}</div>`; return; }
  if (!st.data)   { out.innerHTML = ''; return; }
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
  const lat = numFrom('lat');
  const lon = numFrom('lon');
  if (lat == null || lon == null) {
    alert('Please enter valid latitude and longitude.');
    return;
  }

  setState(zoneSt, { loading: true, error: null, data: null }, renderZone);

  try {
    const data = await postJson(ENDPOINTS.checkZone, {
      ship_id:           textFrom('shipId', 'SHIP_001'),
      latitude:          lat,
      longitude:         lon,
      waste_type_filter: textFrom('wasteFilter') || null,
    });

    setState(zoneSt, { loading: false, data, error: null }, renderZone);

    // Globe pin
    globe?.setPin(lat, lon, data.zone_status);

    // deck.gl scatter
    deckOverlay?.setShipPosition(lat, lon, data.zone_status);

    // Leaflet marker — reassign with new marker reference
    zoneMarker = placeMarker(zoneMap, lat, lon, data.zone_status, zoneMarker);

    historyAdd({
      type: 'Zone Check', lat, lon,
      status: data.zone_status,
      summary: data.summary,
    });
  } catch (e) {
    setState(zoneSt, { loading: false, data: null, error: e.message }, renderZone);
  }
}

/* ═══════════════════════════════════════════════════════════════════════
   SLOP PANEL
═══════════════════════════════════════════════════════════════════════ */

function renderSlop(st) {
  const out = $('slopResult');
  if (!out) return;
  if (st.loading) { out.innerHTML = '<div class="spinner"></div>'; return; }
  if (st.error)   { out.innerHTML = `<div class="error-box">⚠ ${escHtml(st.error)}</div>`; return; }
  if (!st.data)   { out.innerHTML = ''; return; }
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
  const lat = numFrom('slopLat');
  const lon = numFrom('slopLon');
  if (lat == null || lon == null) {
    alert('Please enter valid latitude and longitude.');
    return;
  }

  // NLS Annex II fields — always send booleans, never undefined
  const cargo_is_nls = boolFrom('cargoIsNls');
  const nls_category = cargo_is_nls ? (textFrom('nlsCategory') || null) : null;

  setState(slopSt, { loading: true, error: null, data: null }, renderSlop);

  try {
    const data = await postJson(ENDPOINTS.checkSlop, {
      ship_id:             textFrom('slopShipId', 'SHIP_001'),
      latitude:            lat,
      longitude:           lon,
      ship_speed_knots:    numFrom('shipSpeed')    ?? 0,
      oil_content_ppm:     numFrom('oilContent')   ?? 0,
      discharge_rate_lpnm: numFrom('dischargeRate') ?? 0,
      tank_capacity_m3:    numFrom('tankCapacity')  ?? 0,
      odmcs_operational:   boolFrom('odmcsOp'),
      cargo_is_nls:        cargo_is_nls,
      nls_category:        nls_category,
    });

    setState(slopSt, { loading: false, data, error: null }, renderSlop);
    slopMarker = placeMarker(slopMap, lat, lon, data.zone_status, slopMarker);
    historyAdd({
      type: 'Slop Check', lat, lon,
      status: data.zone_status,
      summary: data.summary,
    });
  } catch (e) {
    setState(slopSt, { loading: false, data: null, error: e.message }, renderSlop);
  }
}

/* ═══════════════════════════════════════════════════════════════════════
   ROUTE PANEL
═══════════════════════════════════════════════════════════════════════ */

function renderRoute(st) {
  const out = $('routeResult');
  if (!out) return;
  if (st.loading) { out.innerHTML = '<div class="spinner"></div>'; return; }
  if (st.error)   { out.innerHTML = `<div class="error-box">⚠ ${escHtml(st.error)}</div>`; return; }
  if (!st.data)   { out.innerHTML = ''; return; }
  const d = st.data;
  const routeSafe = (d.route_status === 'ON_ROUTE');

  out.innerHTML = `
    <div class="result-header">
      ${statusBadge(routeSafe ? 'SAFE' : 'RESTRICTED')}
      <span class="result-dist">${escHtml(d.route_status)}</span>
    </div>
    <p class="result-summary">${escHtml(d.summary)}</p>
    ${routeMetrics(d)}
    ${safeArr(d.zones_crossed).length ? `
      <div class="section-label">Zones Crossed</div>
      ${zonesTable(d.zones_crossed)}` : ''}
  `;

  // Draw route polyline on Leaflet
  if (safeArr(d.route_points).length >= 2) {
    if (routePolyline) routeMap.removeLayer(routePolyline);
    // route_points: [[lat, lon], ...] from RouteCheckResponse
    routePolyline = L.polyline(d.route_points, {
      color: COLORS.primary, weight: 3, opacity: 0.85,
    }).addTo(routeMap);
    routeMap.fitBounds(routePolyline.getBounds(), { padding: [40, 40] });
  }

  // Current position marker
  const rLat = numFrom('routeLat');
  const rLon = numFrom('routeLon');
  if (rLat != null && rLon != null) {
    routeMarker = placeMarker(routeMap, rLat, rLon, routeSafe ? 'SAFE' : 'RESTRICTED', routeMarker);
  }
}

async function submitRoute() {
  setState(routeSt, { loading: true, error: null, data: null }, renderRoute);

  try {
    const data = await postJson(ENDPOINTS.checkRoute, {
      ship_id:               textFrom('routeShipId', 'SHIP_001'),
      latitude:              numFrom('routeLat')      ?? 0,
      longitude:             numFrom('routeLon')      ?? 0,
      origin_port:           textFrom('originPort')   || null,
      destination_port:      textFrom('destPort')     || null,
      origin_latitude:       numFrom('originLat'),
      origin_longitude:      numFrom('originLon'),
      destination_latitude:  numFrom('destLat'),
      destination_longitude: numFrom('destLon'),
      corridor_width_nm:     numFrom('corridorWidth') ?? 25,
    });

    setState(routeSt, { loading: false, data, error: null }, renderRoute);
    historyAdd({
      type: 'Route Check',
      lat:  numFrom('routeLat') ?? 0,
      lon:  numFrom('routeLon') ?? 0,
      status:  data.route_status === 'ON_ROUTE' ? 'SAFE' : 'RESTRICTED',
      summary: data.summary,
    });
  } catch (e) {
    setState(routeSt, { loading: false, data: null, error: e.message }, renderRoute);
  }
}

/* ═══════════════════════════════════════════════════════════════════════
   NLS TOGGLE UX
═══════════════════════════════════════════════════════════════════════ */

function bindNlsToggle() {
  const chk = $('cargoIsNls');
  const row = $('nlsCategoryRow');
  if (!chk || !row) return;
  const update = () => {
    row.style.display = chk.checked ? 'flex' : 'none';
  };
  chk.addEventListener('change', update);
  update(); // set initial state
}

/* ═══════════════════════════════════════════════════════════════════════
   TAB SWITCHING
═══════════════════════════════════════════════════════════════════════ */

function initTabs() {
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
      btn.classList.add('active');
      const panel = $(btn.dataset.tab);
      if (panel) panel.classList.add('active');
      // Leaflet requires a size invalidation after display:none → display:block
      setTimeout(() => {
        if (btn.dataset.tab === 'zonePanel')  zoneMap?.invalidateSize();
        if (btn.dataset.tab === 'slopPanel')  slopMap?.invalidateSize();
        if (btn.dataset.tab === 'routePanel') routeMap?.invalidateSize();
      }, 60);
    });
  });
}

/* ═══════════════════════════════════════════════════════════════════════
   BOOT
═══════════════════════════════════════════════════════════════════════ */

document.addEventListener('DOMContentLoaded', () => {

  // 1. Hide loading screen
  setTimeout(() => $('loader')?.classList.add('hidden'), 900);

  // 2. 3D Globe
  const globe = new GlobeController('globe-canvas');

  // 3. Leaflet maps (must happen after DOM is ready)
  initMaps();

  // 4. Load MARPOL zones GeoJSON overlay (after maps init + API base resolved)
  //    Small delay to let the page settle and avoid blocking initial render
  setTimeout(loadZonesOverlay, 1200);

  // 5. Health check
  pollHealth();
  setInterval(pollHealth, HEALTH_POLL_MS);

  // 6. History
  renderHistory();

  // 7. NLS Annex II toggle
  bindNlsToggle();

  // 8. Tab switching
  initTabs();

  // 9. Submit buttons — globe is captured in closure for zone panel
  $('zoneSubmit')?.addEventListener('click',  () => submitZone(globe));
  $('slopSubmit')?.addEventListener('click',  submitSlop);
  $('routeSubmit')?.addEventListener('click', submitRoute);

  // 10. Clear history
  $('clearHistory')?.addEventListener('click', () => {
    localStorage.removeItem(HISTORY_KEY);
    renderHistory();
  });
});
