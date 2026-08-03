/**
 * dashboard.js
 * Main application controller for the Volteo Maritime MARPOL Compliance Dashboard.
 *
 * Boot sequence (all steps wrapped in try/catch — no single failure blocks load):
 *   1. DOMContentLoaded fires
 *   2. Loader shown (already visible in HTML)
 *   3. Tab system initialized
 *   4. Globe initialized (graceful degrade)
 *   5. Leaflet map initialized (graceful degrade)
 *   6. Zone overlay loaded (graceful degrade)
 *   7. API health poll started
 *   8. Event listeners attached
 *   9. History rendered
 *  10. Loader hidden  ← always reaches this step
 */

'use strict';

import { GlobeController } from './globe.js';
import { ZonesOverlay     } from './zones-overlay.js';

// ─── Configuration ────────────────────────────────────────────────────────────

const API_BASE      = 'https://volteo-maritime-marpol-zone-api.up.railway.app';
const HEALTH_POLL_MS = 30_000;
const API_TIMEOUT_MS = 15_000;
const LOADER_MIN_MS  = 900;    // minimum display time so loader doesn't flash

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Typed getElementById — returns null without throwing if missing. */
const $  = (id) => document.getElementById(id);

/** Read a numeric input value; returns NaN if invalid or missing. */
const num = (id) => {
  const el = $(id);
  if (!el) return NaN;
  const v = parseFloat(el.value);
  return isNaN(v) ? NaN : v;
};

/** Read a string input/select value; returns '' if missing. */
const str = (id) => $(id)?.value?.trim() ?? '';

/** Append a class; no-op if element missing. */
const addClass    = (id, cls) => $(id)?.classList.add(cls);
const removeClass = (id, cls) => $(id)?.classList.remove(cls);

/** Fetch with AbortController timeout. */
async function fetchWithTimeout(url, options = {}, timeoutMs = API_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    return res;
  } finally {
    clearTimeout(timer);
  }
}

// ─── State ────────────────────────────────────────────────────────────────────

let sharedMap    = null;   // L.Map instance
let globe        = null;   // GlobeController instance
let zonesOverlay = null;   // ZonesOverlay instance
let sessionStats = { checks: 0, violations: 0 };
let queryHistory = [];

// ─── Boot ────────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', async () => {
  const bootStart = performance.now();
  console.info('[Boot] DOMContentLoaded — starting initialization.');

  // ── 1. Tabs ────────────────────────────────────────────────────────────────
  try {
    initTabs();
    console.info('[Boot] Tabs ready.');
  } catch (err) {
    console.error('[Boot] Tab init failed — continuing.', err);
  }

  // ── 2. Globe ───────────────────────────────────────────────────────────────
  try {
    if ($('globe-canvas')) {
      globe = new GlobeController('globe-canvas');
    }
    console.info('[Boot] Globe ready.');
  } catch (err) {
    console.error('[Boot] Globe init failed — dashboard continues.', err);
    globe = null;
  }

  // ── 3. Leaflet map ────────────────────────────────────────────────────────
  try {
    initMap();
    console.info('[Boot] Map ready.');
  } catch (err) {
    console.error('[Boot] Map init failed — dashboard continues.', err);
    sharedMap = null;
  }

  // ── 4. Zone overlay ───────────────────────────────────────────────────────
  try {
    if (sharedMap) {
      zonesOverlay = new ZonesOverlay(sharedMap, `${API_BASE}/zones/geojson`);
      zonesOverlay.load(); // non-blocking — fire and forget
    }
  } catch (err) {
    console.error('[Boot] Zone overlay failed — continuing.', err);
    zonesOverlay = null;
  }

  // ── 5. API health ─────────────────────────────────────────────────────────
  try {
    pollHealth();
  } catch (err) {
    console.error('[Boot] Health poll failed — continuing.', err);
    setHealthStatus('offline');
  }

  // ── 6. Event listeners ────────────────────────────────────────────────────
  try {
    attachEventListeners();
    console.info('[Boot] Event listeners attached.');
  } catch (err) {
    console.error('[Boot] Event listener setup failed — continuing.', err);
  }

  // ── 7. History ────────────────────────────────────────────────────────────
  try {
    loadHistory();
    renderHistory();
  } catch (err) {
    console.error('[Boot] History init failed — continuing.', err);
  }

  // ── 8. Hide loader — ALWAYS runs ─────────────────────────────────────────
  const elapsed  = performance.now() - bootStart;
  const delay    = Math.max(0, LOADER_MIN_MS - elapsed);

  setTimeout(() => {
    const loader = $('loader');
    if (loader) {
      loader.classList.add('hidden');
      // Remove from DOM after transition so it can't block interactions
      loader.addEventListener('transitionend', () => loader.remove(), { once: true });
      // Safety net: remove after 1.5 s even if transition never fires
      setTimeout(() => loader?.remove(), 1500);
    }
    console.info(`[Boot] Dashboard ready in ${(performance.now() - bootStart).toFixed(0)} ms.`);
  }, delay);
});

// ─── Tab System ───────────────────────────────────────────────────────────────

/**
 * Map each tab button's data-tab value → the corresponding panel element id.
 * Adjust these if HTML ids change.
 */
const TAB_PANEL_MAP = {
  zone    : 'panel-zone',
  slop    : 'panel-slop',
  route   : 'panel-route',
  map     : 'panel-map',
  history : 'panel-history',
};

function initTabs() {
  const buttons = document.querySelectorAll('[data-tab]');
  if (!buttons.length) {
    console.warn('[Tabs] No tab buttons found.');
    return;
  }

  buttons.forEach(btn => {
    btn.addEventListener('click', () => {
      const tab = btn.dataset.tab;
      switchTab(tab, buttons);
    });
  });

  // Activate first tab
  const firstBtn = buttons[0];
  if (firstBtn) switchTab(firstBtn.dataset.tab, buttons);
}

function switchTab(tab, buttons) {
  // Deactivate all buttons
  buttons.forEach(b => b.classList.remove('active'));

  // Activate clicked button
  const activeBtn = document.querySelector(`[data-tab="${tab}"]`);
  if (activeBtn) activeBtn.classList.add('active');

  // Hide all panels
  Object.values(TAB_PANEL_MAP).forEach(panelId => {
    addClass(panelId, 'hidden');
  });

  // Show target panel
  const panelId = TAB_PANEL_MAP[tab];
  if (panelId) {
    removeClass(panelId, 'hidden');
  }

  // Trigger map resize when map tab is activated
  if (tab === 'map' && sharedMap) {
    setTimeout(() => {
      try { sharedMap.invalidateSize(); } catch (_) {}
    }, 50);
  }
}

// ─── Leaflet Map ──────────────────────────────────────────────────────────────

function initMap() {
  // HTML uses id="map"
  const container = $('map');
  if (!container) throw new Error('Map container #map not found in DOM.');
  if (!window.L)  throw new Error('Leaflet not loaded.');

  sharedMap = L.map('map', {
    center        : [20, 0],
    zoom          : 2,
    zoomControl   : true,
    attributionControl: false,
  });

  L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
    maxZoom     : 18,
    attribution : '© OpenStreetMap © CARTO',
  }).addTo(sharedMap);

  sharedMap.whenReady(() => {
    sharedMap.invalidateSize();
    console.info('[Map] Leaflet ready.');
  });

  // Update coordinate display on mouse move
  sharedMap.on('mousemove', (e) => {
    const coordEl = $('mapCoordsBar');
    if (coordEl) {
      coordEl.textContent =
        `${e.latlng.lat.toFixed(4)}° N  ${e.latlng.lng.toFixed(4)}° E`;
    }
  });
}

// ─── Health Polling ───────────────────────────────────────────────────────────

async function pollHealth() {
  let intervalId = null;

  const check = async () => {
    try {
      const t0  = performance.now();
      const res = await fetchWithTimeout(`${API_BASE}/health`, {}, 8_000);
      const ms  = Math.round(performance.now() - t0);

      if (res.ok) {
        setHealthStatus('online');
        const el = $('kpiLatency');
        if (el) el.textContent = `${ms} ms`;
      } else {
        setHealthStatus('degraded');
      }
    } catch (err) {
      console.warn('[Health] API unreachable.', err.message);
      setHealthStatus('offline');
    }
  };

  await check();
  intervalId = setInterval(check, HEALTH_POLL_MS);
  return () => clearInterval(intervalId); // return cleanup fn
}

function setHealthStatus(status) {
  const dot   = $('healthDot');
  const label = $('healthLabel');

  const MAP = {
    online   : { cls: 'online',   text: 'API Online'   },
    degraded : { cls: 'degraded', text: 'API Degraded' },
    offline  : { cls: 'offline',  text: 'API Offline'  },
  };

  const s = MAP[status] ?? MAP.offline;

  if (dot) {
    dot.className = `health-dot ${s.cls}`;
  }
  if (label) {
    label.textContent = s.text;
  }
}

// ─── Event Listeners ─────────────────────────────────────────────────────────

function attachEventListeners() {
  // Tab buttons are wired in initTabs().

  // Clear history button — HTML may use onclick="clearHistory()" OR we wire it here.
  const clearBtn = $('clearHistoryBtn') || document.querySelector('[onclick*="clearHistory"]');
  if (clearBtn) {
    clearBtn.removeAttribute('onclick');
    clearBtn.addEventListener('click', clearHistory);
  }

  // Wire form buttons — these may use inline onclick in the HTML.
  // We expose globals so inline onclick attrs still work even without wiring here.
  window.checkZone  = submitZone;
  window.checkSlop  = submitSlop;
  window.checkRoute = submitRoute;
  window.clearHistory = clearHistory;

  // If buttons exist with IDs, also wire directly for resilience
  $('zoneSubmit') ?.addEventListener('click', submitZone);
  $('slopSubmit') ?.addEventListener('click', submitSlop);
  $('routeSubmit')?.addEventListener('click', submitRoute);
}

// ─── Zone Check ───────────────────────────────────────────────────────────────

async function submitZone() {
  const lat = num('zoneLatInput');
  const lon = num('zoneLonInput');

  if (isNaN(lat) || isNaN(lon)) {
    showResult('zoneResult', 'error', '⚠️ Please enter valid latitude and longitude.');
    return;
  }

  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) {
    showResult('zoneResult', 'error', '⚠️ Coordinates out of range.');
    return;
  }

  showResult('zoneResult', 'loading', 'Checking zone…');

  try {
    const res  = await fetchWithTimeout(
      `${API_BASE}/check-zone?lat=${lat}&lon=${lon}`,
    );
    const data = await res.json();

    if (!res.ok) throw new Error(data.detail || `HTTP ${res.status}`);

    // Update globe
    globe?.setPin(lat, lon);
    globe?.focusOn(lat, lon);

    // Update map
    placeMapMarker(lat, lon, 'zone');

    // Update KPIs
    sessionStats.checks++;
    if (!data.compliant) sessionStats.violations++;
    updateKpis();

    // Record history
    addHistory({ type: 'zone', lat, lon, result: data, ts: Date.now() });

    renderZoneResult(data);
  } catch (err) {
    console.error('[Zone] Check failed.', err);
    showResult('zoneResult', 'error', `❌ Request failed: ${err.message}`);
  }
}

function renderZoneResult(data) {
  const compliant = data.compliant ?? data.is_compliant ?? true;
  const zones     = data.zones     ?? data.matched_zones ?? [];

  let html = `
    <div class="result-status ${compliant ? 'compliant' : 'violation'}">
      ${compliant
        ? '✅ <strong>COMPLIANT</strong> — Position is outside restricted zones.'
        : '🚫 <strong>VIOLATION</strong> — Position is within a restricted zone.'}
    </div>`;

  if (zones.length) {
    html += '<ul class="zone-list">';
    for (const z of zones) {
      const name = z.name || z.zone_name || z;
      const type = z.zone_type || '';
      html += `<li><strong>${name}</strong>${type ? ` — ${type}` : ''}</li>`;
    }
    html += '</ul>';
  }

  showResult('zoneResult', compliant ? 'compliant' : 'violation', html, true);
}

// ─── Slop Check ───────────────────────────────────────────────────────────────

async function submitSlop() {
  const lat        = num('slopLatInput');
  const lon        = num('slopLonInput');
  const oilContent = num('slopOilContent');

  if (isNaN(lat) || isNaN(lon)) {
    showResult('slopResult', 'error', '⚠️ Please enter valid coordinates.');
    return;
  }

  showResult('slopResult', 'loading', 'Evaluating slop discharge…');

  try {
    const body = {
      lat,
      lon,
      oil_content_ppm : isNaN(oilContent) ? undefined : oilContent,
    };

    const res  = await fetchWithTimeout(`${API_BASE}/check-slop`, {
      method  : 'POST',
      headers : { 'Content-Type': 'application/json' },
      body    : JSON.stringify(body),
    });
    const data = await res.json();

    if (!res.ok) throw new Error(data.detail || `HTTP ${res.status}`);

    globe?.setPin(lat, lon);
    globe?.focusOn(lat, lon);
    placeMapMarker(lat, lon, 'slop');

    sessionStats.checks++;
    if (!(data.compliant ?? data.is_compliant ?? true)) sessionStats.violations++;
    updateKpis();

    addHistory({ type: 'slop', lat, lon, result: data, ts: Date.now() });
    renderSlopResult(data);
  } catch (err) {
    console.error('[Slop] Check failed.', err);
    showResult('slopResult', 'error', `❌ Request failed: ${err.message}`);
  }
}

function renderSlopResult(data) {
  const compliant = data.compliant ?? data.is_compliant ?? true;
  const limit     = data.limit_ppm   ?? data.oil_limit_ppm ?? '—';
  const actual    = data.oil_content_ppm ?? '—';

  const html = `
    <div class="result-status ${compliant ? 'compliant' : 'violation'}">
      ${compliant
        ? '✅ <strong>DISCHARGE PERMITTED</strong>'
        : '🚫 <strong>DISCHARGE PROHIBITED</strong>'}
    </div>
    <div class="result-detail">
      Oil Content: <strong>${actual} ppm</strong> /
      Limit: <strong>${limit} ppm</strong>
    </div>
    ${data.reason ? `<div class="result-reason">${data.reason}</div>` : ''}
  `;

  showResult('slopResult', compliant ? 'compliant' : 'violation', html, true);
}

// ─── Route Check ──────────────────────────────────────────────────────────────

async function submitRoute() {
  // HTML uses a textarea with id="routeWaypoints" containing JSON array or newline coords
  const raw = str('routeWaypoints');

  if (!raw) {
    showResult('routeResult', 'error', '⚠️ Please enter route waypoints.');
    return;
  }

  let waypoints;
  try {
    waypoints = parseWaypoints(raw);
  } catch (err) {
    showResult('routeResult', 'error', `⚠️ Invalid waypoints format: ${err.message}`);
    return;
  }

  if (waypoints.length < 2) {
    showResult('routeResult', 'error', '⚠️ Route requires at least 2 waypoints.');
    return;
  }

  showResult('routeResult', 'loading', 'Analysing route…');

  try {
    const res  = await fetchWithTimeout(`${API_BASE}/check-route`, {
      method  : 'POST',
      headers : { 'Content-Type': 'application/json' },
      body    : JSON.stringify({ waypoints }),
    });
    const data = await res.json();

    if (!res.ok) throw new Error(data.detail || `HTTP ${res.status}`);

    renderRouteOnMap(waypoints);

    sessionStats.checks++;
    if (!(data.compliant ?? true)) sessionStats.violations++;
    updateKpis();

    addHistory({ type: 'route', waypoints, result: data, ts: Date.now() });
    renderRouteResult(data);
  } catch (err) {
    console.error('[Route] Check failed.', err);
    showResult('routeResult', 'error', `❌ Request failed: ${err.message}`);
  }
}

/**
 * Parse waypoints from:
 * - JSON array: [[lat,lon],[lat,lon]]
 * - Newline-separated: "lat,lon\nlat,lon"
 */
function parseWaypoints(raw) {
  raw = raw.trim();

  if (raw.startsWith('[')) {
    const parsed = JSON.parse(raw);
    return parsed.map((p, i) => {
      if (Array.isArray(p) && p.length >= 2) return { lat: p[0], lon: p[1] };
      if (typeof p === 'object' && 'lat' in p) return p;
      throw new Error(`Invalid waypoint at index ${i}`);
    });
  }

  // Newline-separated "lat,lon"
  return raw.split('\n').map((line, i) => {
    const parts = line.split(',').map(s => parseFloat(s.trim()));
    if (parts.length < 2 || parts.some(isNaN)) {
      throw new Error(`Invalid waypoint at line ${i + 1}: "${line}"`);
    }
    return { lat: parts[0], lon: parts[1] };
  });
}

function renderRouteResult(data) {
  const compliant  = data.compliant ?? true;
  const violations = data.violations ?? data.zone_violations ?? [];

  let html = `
    <div class="result-status ${compliant ? 'compliant' : 'violation'}">
      ${compliant
        ? '✅ <strong>ROUTE COMPLIANT</strong> — No MARPOL violations detected.'
        : `🚫 <strong>ROUTE VIOLATION</strong> — ${violations.length} segment(s) affected.`}
    </div>`;

  if (violations.length) {
    html += '<ul class="zone-list">';
    for (const v of violations) {
      const zone = v.zone_name || v.zone || v;
      html += `<li>${zone}</li>`;
    }
    html += '</ul>';
  }

  showResult('routeResult', compliant ? 'compliant' : 'violation', html, true);
}

// ─── Map Utilities ────────────────────────────────────────────────────────────

let _mapMarkers = [];
let _routeLayer = null;

function placeMapMarker(lat, lon, type) {
  if (!sharedMap) return;

  try {
    // Remove previous marker of same type
    _mapMarkers = _mapMarkers.filter(({ marker, t }) => {
      if (t === type) {
        sharedMap.removeLayer(marker);
        return false;
      }
      return true;
    });

    const colors = { zone: '#ff6b35', slop: '#00d4aa', route: '#4ecdc4' };
    const color  = colors[type] ?? '#ffffff';

    const icon = L.divIcon({
      className : '',
      html      : `<div style="
        width:14px;height:14px;border-radius:50%;
        background:${color};border:2px solid #fff;
        box-shadow:0 0 8px ${color}88;
      "></div>`,
      iconSize  : [14, 14],
      iconAnchor: [7, 7],
    });

    const marker = L.marker([lat, lon], { icon }).addTo(sharedMap);
    marker.bindPopup(`${type.toUpperCase()}: ${lat.toFixed(4)}, ${lon.toFixed(4)}`);
    _mapMarkers.push({ marker, t: type });

    sharedMap.setView([lat, lon], Math.max(sharedMap.getZoom(), 4), { animate: true });
  } catch (err) {
    console.warn('[Map] placeMapMarker failed.', err);
  }
}

function renderRouteOnMap(waypoints) {
  if (!sharedMap) return;

  try {
    if (_routeLayer) {
      sharedMap.removeLayer(_routeLayer);
      _routeLayer = null;
    }

    const latlngs = waypoints.map(wp => [wp.lat, wp.lon]);
    _routeLayer = L.polyline(latlngs, {
      color  : '#00d4aa',
      weight : 3,
      opacity: 0.85,
      dashArray: '6 4',
    }).addTo(sharedMap);

    sharedMap.fitBounds(_routeLayer.getBounds(), { padding: [30, 30] });
  } catch (err) {
    console.warn('[Map] renderRouteOnMap failed.', err);
  }
}

// ─── KPI Updates ──────────────────────────────────────────────────────────────

function updateKpis() {
  const checksEl     = $('kpiChecks');
  const violationsEl = $('kpiViolations');
  const zonesEl      = $('kpiZones');

  if (checksEl)     checksEl.textContent     = sessionStats.checks;
  if (violationsEl) violationsEl.textContent = sessionStats.violations;
  if (zonesEl)      zonesEl.textContent      = sessionStats.checks - sessionStats.violations;
}

// ─── Result Card Helper ───────────────────────────────────────────────────────

/**
 * @param {string}  cardId   - element ID of the result card
 * @param {string}  state    - 'loading' | 'error' | 'compliant' | 'violation'
 * @param {string}  html     - inner HTML to render
 * @param {boolean} [raw]    - if true, html is already safe markup (not escaped)
 */
function showResult(cardId, state, html, raw = false) {
  const el = $(cardId);
  if (!el) return;

  el.className = `result-card ${state}`;
  el.classList.remove('hidden');

  const inner = raw ? html : `<p>${html}</p>`;

  if (state === 'loading') {
    el.innerHTML = `
      <div class="result-loading">
        <span class="spinner"></span>
        <span>${html}</span>
      </div>`;
  } else {
    el.innerHTML = inner;
  }
}

// ─── History ──────────────────────────────────────────────────────────────────

const HISTORY_KEY    = 'marpol_history';
const HISTORY_LIMIT  = 50;

function loadHistory() {
  try {
    const raw = localStorage.getItem(HISTORY_KEY);
    queryHistory = raw ? JSON.parse(raw) : [];
  } catch {
    queryHistory = [];
  }
}

function saveHistory() {
  try {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(queryHistory.slice(0, HISTORY_LIMIT)));
  } catch (err) {
    console.warn('[History] localStorage write failed.', err);
  }
}

function addHistory(entry) {
  queryHistory.unshift(entry);
  if (queryHistory.length > HISTORY_LIMIT) queryHistory.length = HISTORY_LIMIT;
  saveHistory();
  renderHistory();
}

function clearHistory() {
  queryHistory = [];
  saveHistory();
  renderHistory();
}

function renderHistory() {
  const el = $('historyList');
  if (!el) return;

  if (!queryHistory.length) {
    el.innerHTML = '<p class="history-empty">No queries yet. Run a check to see history.</p>';
    return;
  }

  el.innerHTML = queryHistory.map((entry, i) => {
    const date     = new Date(entry.ts).toLocaleString();
    const compliant = entry.result?.compliant ?? entry.result?.is_compliant ?? true;
    const badge    = compliant
      ? '<span class="badge compliant">✅ COMPLIANT</span>'
      : '<span class="badge violation">🚫 VIOLATION</span>';

    let detail = '';
    if (entry.type === 'zone' || entry.type === 'slop') {
      detail = `${entry.lat?.toFixed(4) ?? '—'}°, ${entry.lon?.toFixed(4) ?? '—'}°`;
    } else if (entry.type === 'route') {
      detail = `${entry.waypoints?.length ?? 0} waypoints`;
    }

    return `
      <div class="history-item" data-index="${i}">
        <div class="history-meta">
          <span class="history-type">${entry.type.toUpperCase()}</span>
          ${badge}
          <span class="history-time">${date}</span>
        </div>
        <div class="history-detail">${detail}</div>
      </div>`;
  }).join('');
}
