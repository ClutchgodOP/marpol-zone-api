/**
 * Volteo Maritime MARPOL Compliance dashboard.
 *
 * Vanilla ES6, no framework, no build step. The file is organised as a set of
 * small modules held in closures:
 *
 *   config  → API base resolution and endpoint paths
 *   dom     → element lookup and HTML escaping
 *   auth    → JWT token manager (auto-fetch + cache)
 *   api     → fetch wrapper that understands RFC 7807 problem+json
 *   store   → per-panel state objects + a render function per panel
 *   maps    → the three Leaflet instances and their layers
 *   views   → pure state → HTML functions
 *   panels  → zone / slop / route controllers
 *   history → localStorage-backed session log
 *
 * The rendering contract is one-way: handlers only ever call setState(), and
 * setState() is the only thing that calls a panel's render(). Nothing else
 * touches the DOM of a results panel, so a panel's markup is always a pure
 * function of its state.
 */
'use strict';

/* ─────────────────────────────── config ─────────────────────────────── */

const RAILWAY_API = 'https://volteo-maritime-marpol-zone-api.up.railway.app';

const API_BASE = (() => {
  const origin = window.location.origin;
  const isHttp = origin && origin.startsWith('http');
  const isLocal = isHttp && /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
  if (isLocal || origin === RAILWAY_API) return origin;
  return RAILWAY_API;
})();

const ENDPOINTS = {
  health:      '/health',
  authToken:   '/auth/token',
  checkZone:   '/api/v1/check-zone',
  checkSlop:   '/api/v1/check-slop',
  checkRoute:  '/api/v1/check-route',
  zonesGeoJson:'/api/v1/zones/geojson'
};

const DEMO_API_KEY   = 'volteo-demo-key-2026';
const TILE_URL       = 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png';
const TILE_OPTIONS   = { maxZoom: 18, attribution: '© OpenStreetMap contributors' };
const INITIAL_VIEW   = { center: [20, 0], zoom: 2 };
const HEALTH_POLL_MS = 15000;
const HISTORY_LIMIT  = 30;
const COLORS = {
  primary: '#3d7cff',
  accent:  '#35c5a7',
  danger:  '#ff5d6c',
  warning: '#ffb648'
};

/* ──────────────────────────────── dom ──────────────────────────────── */

const id = elementId => document.getElementById(elementId);

const escapeHtml = value => {
  const node = document.createElement('div');
  node.textContent = value === null || value === undefined ? '' : String(value);
  return node.innerHTML;
};

const formatNum = (value, digits = 2) =>
  value === null || value === undefined || Number.isNaN(Number(value))
    ? '—'
    : Number(value).toFixed(digits);

const safeArray = value => (Array.isArray(value) ? value : []);

const numberFrom = elementId => {
  const parsed = parseFloat(id(elementId).value);
  return Number.isNaN(parsed) ? null : parsed;
};

const textFrom = (elementId, fallback = '') =>
  id(elementId).value.trim() || fallback;

/* ──────────────────────────────── auth ──────────────────────────────── */

/**
 * JWT token manager. Fetches a token from /auth/token using the demo API key,
 * caches it until 30 s before expiry, then auto-refreshes on the next call.
 */
const auth = (() => {
  let _token  = null;
  let _expiry = 0;

  return {
    async getToken() {
      if (_token && Date.now() < _expiry) return _token;

      const base = (() => {
        const override = id('apiBase') && id('apiBase').value.trim().replace(/\/+$/, '');
        return override || API_BASE;
      })();

      const url = `${base}${ENDPOINTS.authToken}?api_key=${DEMO_API_KEY}`;
      let res;
      try {
        res = await fetch(url, { method: 'POST' });
      } catch (e) {
        throw new ApiProblem({
          type:   'about:blank',
          title:  'Auth network error',
          status: 0,
          detail: `Could not reach ${url}. ${e.message}`,
          instance: ENDPOINTS.authToken
        });
      }

      if (!res.ok) {
        throw new ApiProblem({
          type:   'about:blank',
          title:  'Authentication failed',
          status: res.status,
          detail: `POST ${ENDPOINTS.authToken} returned HTTP ${res.status}. Check that DEMO_API_KEY is set on Railway.`,
          instance: ENDPOINTS.authToken
        });
      }

      const data = await res.json();
      _token  = data.access_token;
      // expires_in is in seconds; refresh 30 s early
      _expiry = Date.now() + ((data.expires_in || 900) - 30) * 1000;
      return _token;
    },

    /** Call this to force a fresh token (e.g. after a 401 from the API). */
    invalidate() {
      _token  = null;
      _expiry = 0;
    }
  };
})();

/* ──────────────────────────────── api ──────────────────────────────── */

/** An RFC 7807 problem document raised as an Error. */
class ApiProblem extends Error {
  constructor(problem) {
    super(problem.detail || problem.title || 'Request failed');
    this.name    = 'ApiProblem';
    this.problem = problem;
  }
}

const apiBase = () => {
  const override = id('apiBase').value.trim().replace(/\/+$/, '');
  return override || API_BASE;
};

/**
 * Any non-2xx response is turned into an ApiProblem. Injects the JWT
 * Authorization header automatically. On a 401 the token is invalidated
 * and the request is retried once.
 */
async function request(path, options = {}, _retry = false) {
  let token;
  try {
    token = await auth.getToken();
  } catch (authErr) {
    // Re-throw auth errors directly so they surface as a clear problem
    throw authErr;
  }

  const url = `${apiBase()}${path}`;
  const headers = Object.assign(
    { 'Authorization': `Bearer ${token}` },
    options.headers || {}
  );

  let response;
  try {
    response = await fetch(url, { ...options, headers });
  } catch (networkError) {
    throw new ApiProblem({
      type:   'about:blank',
      title:  'Network error',
      status: 0,
      detail: `Could not reach the compliance API at ${url}. ${networkError.message}`,
      instance: path
    });
  }

  // Auto-retry once on 401 (token may have expired mid-session)
  if (response.status === 401 && !_retry) {
    auth.invalidate();
    return request(path, options, true);
  }

  const contentType = response.headers.get('content-type') || '';
  const body = contentType.includes('json')
    ? await response.json().catch(() => null)
    : null;

  if (response.ok) return body;

  if (body && typeof body === 'object' && typeof body.title === 'string' && 'status' in body) {
    throw new ApiProblem(body);
  }

  const legacyDetail = body && body.detail;
  throw new ApiProblem({
    type:   'about:blank',
    title:  `Request failed (${response.status})`,
    status: response.status,
    detail: typeof legacyDetail === 'string'
      ? legacyDetail
      : legacyDetail
        ? JSON.stringify(legacyDetail)
        : `The API responded with HTTP ${response.status}.`,
    instance: path
  });
}

const postJson = (path, payload) =>
  request(path, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify(payload)
  });

/** True when a problem document reports a position rejected as being on land. */
const isOnLandProblem = problem =>
  typeof problem.type === 'string' && problem.type.endsWith('/coordinates-on-land');

/* ─────────────────────────────── store ─────────────────────────────── */

const emptyPanel = () => ({ status: 'idle', result: null, problem: null, request: null });

const state = {
  zone:    emptyPanel(),
  slop:    emptyPanel(),
  route:   emptyPanel(),
  api:     { status: 'checking', label: 'Checking API…' },
  theme:   document.documentElement.getAttribute('data-theme') || 'dark',
  history: []
};

const renderers = {};

/** The only entry point for mutating panel state; merges then re-renders. */
function setState(panel, patch) {
  state[panel] = Object.assign({}, state[panel], patch);
  const render = renderers[panel];
  if (render) render(state[panel]);
}

/* ─────────────────────────────── maps ─────────────────────────────── */

const maps = (() => {
  const instances = { zone: null, slop: null, route: null };
  const layers    = { zone: {}, slop: {}, route: {} };

  const landIcon = () => L.divIcon({
    className: '',
    html: `<div style="width:28px;height:28px;border-radius:50%;background:${COLORS.danger};border:3px solid #fff;box-shadow:0 2px 10px rgba(255,93,108,.6);display:grid;place-items:center;font-size:14px;line-height:1">⚓</div>`,
    iconSize:   [28, 28],
    iconAnchor: [14, 14],
    popupAnchor:[0, -16]
  });

  const portIcon = (letter, color) => L.divIcon({
    className: '',
    html: `<div style="width:26px;height:26px;border-radius:50%;background:${color};border:3px solid #fff;box-shadow:0 2px 8px rgba(0,0,0,.45);color:#fff;display:grid;place-items:center;font-size:12px;font-weight:800;line-height:1">${letter}</div>`,
    iconSize:   [26, 26],
    iconAnchor: [13, 13],
    popupAnchor:[0, -14]
  });

  function create(key, containerId) {
    if (instances[key]) return instances[key];
    if (!id(containerId)) return instances[key];

    const map = L.map(containerId, { zoomControl: true, attributionControl: true })
      .setView(INITIAL_VIEW.center, INITIAL_VIEW.zoom);

    L.tileLayer(TILE_URL, TILE_OPTIONS).addTo(map);

    layers[key].ship   = L.marker(INITIAL_VIEW.center).addTo(map).bindPopup('Ship position');
    layers[key].radius = L.circle(INITIAL_VIEW.center, {
      radius: 22224,          // 12 NM in metres
      color: COLORS.primary, fillColor: COLORS.primary, fillOpacity: 0.12, weight: 1.5
    }).addTo(map);
    layers[key].zones  = L.layerGroup().addTo(map);

    if (key === 'route') {
      layers.route.origin      = L.marker(INITIAL_VIEW.center, { icon: portIcon('O', COLORS.accent) }).addTo(map);
      layers.route.destination = L.marker(INITIAL_VIEW.center, { icon: portIcon('D', COLORS.primary) }).addTo(map);
      layers.route.track       = L.polyline([], {
        color: COLORS.accent, weight: 3, opacity: 0.95, dashArray: '8 10'
      }).addTo(map);
      map.removeLayer(layers.route.radius);
    }

    instances[key] = map;

    requestAnimationFrame(() => refresh(key));
    return map;
  }

  function refresh(key) {
    const map = instances[key];
    if (!map) return;
    try { map.invalidateSize({ animate: false }); } catch (e) {
      console.warn(`Map ${key} refresh skipped:`, e.message);
    }
  }

  function hasViewport(map) {
    const size = map.getSize();
    return size && size.x > 0 && size.y > 0;
  }

  function focus(key, coords, minZoom) {
    const map = instances[key];
    if (!map) return;
    refresh(key);
    if (!hasViewport(map)) return;
    map.setView(coords, Math.max(map.getZoom(), minZoom), { animate: true });
  }

  function setShip(key, lat, lon, label = 'Ship position', { onLand = false, open = false } = {}) {
    const map = instances[key];
    if (!map || lat === null || lon === null) return;
    const coords = [lat, lon];
    const marker = layers[key].ship;
    marker.setIcon(onLand ? landIcon() : new L.Icon.Default());
    marker.setLatLng(coords).bindPopup(label);
    if (open) marker.openPopup();
    if (layers[key].radius) layers[key].radius.setLatLng(coords);
    focus(key, coords, onLand ? 6 : 5);
  }

  function setZonePolygons(key, featureCollection) {
    const map = instances[key];
    if (!map) return;
    layers[key].zones.clearLayers();
    safeArray(featureCollection && featureCollection.features).forEach(feature => {
      const p = feature.properties;
      L.geoJSON(feature, {
        style: { color: COLORS.warning, weight: 1.5, fillColor: COLORS.warning, fillOpacity: 0.08 }
      })
        .bindPopup(`<strong>${escapeHtml(p.name)}</strong><br>Annex ${escapeHtml(p.annex)}<br><small>${escapeHtml(p.restriction)}</small>`)
        .addTo(layers[key].zones);
    });
  }

  function clearZonePolygons(key) {
    if (instances[key]) layers[key].zones.clearLayers();
  }

  function drawRoute(result) {
    const map = instances.route;
    if (!map) return;
    const origin      = [Number(result.origin.lat),      Number(result.origin.lon)];
    const destination = [Number(result.destination.lat), Number(result.destination.lon)];
    const ship        = [Number(result.latitude),         Number(result.longitude)];

    layers.route.origin
      .setLatLng(origin)
      .bindPopup(`<strong>Origin</strong><br>${escapeHtml(result.origin.label)}<br><small>${formatNum(result.origin.lat, 4)}, ${formatNum(result.origin.lon, 4)}</small>`);
    layers.route.destination
      .setLatLng(destination)
      .bindPopup(`<strong>Destination</strong><br>${escapeHtml(result.destination.label)}<br><small>${formatNum(result.destination.lat, 4)}, ${formatNum(result.destination.lon, 4)}</small>`);

    const track = safeArray(result.route_points);
    layers.route.track.setLatLngs(track.length >= 2 ? track : [origin, destination]);
    layers.route.track.setStyle({ color: result.is_on_route ? COLORS.accent : COLORS.danger });

    setShip('route', ship[0], ship[1], {
      label:  result.is_on_route
        ? `<b style="color:${COLORS.accent}">On route</b><br>${escapeHtml(result.ship_id)}`
        : `<b style="color:${COLORS.danger}">Off route</b><br>${escapeHtml(result.ship_id)}`,
      onLand: !result.is_on_route,
      open:   true
    });

    refresh('route');
    if (!hasViewport(map)) return;
    map.flyToBounds(
      L.latLngBounds([origin, destination, ship]),
      { padding: [40, 40], animate: true, duration: 0.8 }
    );
  }

  function reset(key) {
    const map = instances[key];
    if (!map) return;
    map.setView(INITIAL_VIEW.center, INITIAL_VIEW.zoom);
  }

  return { create, refresh, reset, setShip, setZonePolygons, clearZonePolygons, drawRoute,
    exists: key => Boolean(instances[key]) };
})();

/* ─────────────────────────────── views ─────────────────────────────── */

const tag  = (text, mode)  => `<span class="tag ${mode}">${escapeHtml(text)}</span>`;
const banner = (text, good) => `<div class="info-banner ${good ? 'banner-good' : 'banner-bad'}">${escapeHtml(text)}</div>`;

const statCard = (label, value, note) =>
  `<div class="stat-card">
    <span class="stat-label">${escapeHtml(label)}</span>
    <div class="stat-value">${value}</div>
    <div class="stat-note">${note}</div>
  </div>`;

const emptyState = message => `<div class="empty-state">${escapeHtml(message)}</div>`;

const cardPanel = (title, inner) =>
  `<div class="panel card">
    <div class="section-heading"><div></div><div class="section-title" style="font-size:1.15rem">${escapeHtml(title)}</div></div>
    ${inner}
  </div>`;

const listItem = (icon, iconMode, title, subtitle, meta) =>
  `<div class="list-item">
    <div class="list-icon ${iconMode}">${escapeHtml(icon)}</div>
    <div>
      <div class="list-item-title">${escapeHtml(title)}</div>
      <div class="list-item-subtitle">${escapeHtml(subtitle)}</div>
    </div>
    <div class="list-item-meta">${meta}</div>
  </div>`;

const listWrap = items =>
  items.length ? `<div class="list-wrap">${items.join('')}</div>` : '';

function renderAnnexTags(result) {
  const fromSummary = safeArray(result.annex_summary).map(item => `Annex ${item.annex}`);
  const annexes = fromSummary.length
    ? fromSummary
    : Array.from(new Set(safeArray(result.active_zones).map(z => `Annex ${z.annex}`)));
  if (!annexes.length) return '';
  return `<div class="tags-wrap">${annexes.map(label => tag(label, 'annex')).join('')}</div>`;
}

function renderZoneList(result) {
  const zones = safeArray(result.active_zones);
  if (!zones.length) return emptyState('No active MARPOL zones were returned for the current coordinates.');
  const chips = zones.map(z => tag(`${z.zone_name} ${z.zone_id}`, z.annex));
  const items = zones.map(z => {
    const dates = [
      z.effective_date   ? `<div><strong>In force</strong> ${escapeHtml(z.effective_date)}</div>`   : '',
      z.enforcement_date ? `<div><strong>Enforced</strong> ${escapeHtml(z.enforcement_date)}</div>` : ''
    ].join('');
    return listItem(
      '!', 'no',
      z.zone_name || 'Unnamed MARPOL zone',
      z.guidance || z.restriction || 'Restriction not available.',
      `<div><strong>Annex</strong> ${escapeHtml(z.annex)}</div>
       <div><strong>Waste</strong> ${escapeHtml(z.waste_type)}</div>
       <div><strong>ID</strong> ${escapeHtml(z.zone_id)}</div>${dates}`
    );
  });
  return `<div class="tags-wrap">${chips.join('')}</div>${listWrap(items)}`;
}

function renderAnnexSummary(result) {
  const annexes = safeArray(result.annex_summary);
  if (!annexes.length) return emptyState('Annex summary is empty. This usually means no active zones were found.');
  return listWrap(annexes.map(item =>
    listItem('A', 'ok', `Annex ${item.annex}`,
      `Waste types: ${safeArray(item.waste_types).join(', ')}`,
      `<div><strong>Zones</strong> ${escapeHtml(item.active_zone_count || 0)}</div>`
    )
  ));
}

function renderDisposalAssessment(result) {
  const items = safeArray(result.disposal_assessment);
  if (!items.length) return emptyState('No disposal assessment items were returned.');
  return listWrap(items.map(item =>
    listItem(
      item.allowed ? '✓' : '✗',
      item.allowed ? 'ok' : 'no',
      item.label || item.code || 'Assessment item',
      item.reason || 'No explanation returned.',
      item.allowed ? tag('Allowed', 'ok') : tag('Restricted', 'error')
    )
  ));
}

function renderRulesChecklist(result) {
  const rules = safeArray(result.rules_checklist);
  if (!rules.length) return emptyState('No rules checklist was returned.');
  return listWrap(rules.map(rule =>
    listItem(
      rule.passed ? '✓' : '✗',
      rule.passed ? 'ok' : 'no',
      rule.rule_name || rule.rule_code || 'Rule',
      rule.note || 'No note returned.',
      `<div><strong>Actual</strong> ${escapeHtml(rule.actual_value)}</div>
       <div><strong>Required</strong> ${escapeHtml(rule.required_value)}</div>`
    )
  ));
}

function renderProblem(problem) {
  const validationErrors = safeArray(problem.errors).map(error =>
    listItem('✗', 'no',
      error.field || 'Field',
      error.message || 'Invalid value',
      `<div><strong>Type</strong> ${escapeHtml(error.type)}</div>`
    )
  );
  const details = listItem('!', 'no',
    problem.title || 'Request failed',
    problem.detail || 'The API returned an error without a description.',
    `<div><strong>Status</strong> ${escapeHtml(problem.status)}</div>
     <div><strong>Type</strong> ${escapeHtml(problem.type || 'about:blank')}</div>
     ${problem.instance ? `<div><strong>Instance</strong> ${escapeHtml(problem.instance)}</div>` : ''}`
  );
  return banner(problem.detail || problem.title || 'Request failed', false) +
    cardPanel('Problem details', listWrap([details].concat(validationErrors)));
}

function renderZoneView(result) {
  const safe = result.zone_status === 'SAFE' || result.nearest_land_rule_satisfied;
  return `
    <div class="stats-grid">
      ${statCard('Zone status', escapeHtml(result.zone_status || 'UNKNOWN'),
          result.in_special_area ? 'At least one MARPOL special area is active.' : 'No MARPOL special area is active here.')}
      ${statCard('Distance to nearest land', `${formatNum(result.distance_to_nearest_land_nm, 2)} NM`,
          result.nearest_land_rule_satisfied ? '12 NM rule satisfied.' : 'Below the 12 NM threshold.')}
      ${statCard('Active zones', safeArray(result.active_zones).length,
          `${safeArray(result.annex_summary).length} annexes engaged.`)}
      ${statCard('Disposal items', safeArray(result.disposal_assessment).length,
          `${safeArray(result.disposal_assessment).filter(i => i.allowed).length} currently permitted.`)}
    </div>
    ${banner(result.summary, safe)}
    ${renderAnnexTags(result)}
    <div class="panel-grid">
      ${cardPanel('Active MARPOL zones', renderZoneList(result))}
      ${cardPanel('Annex summary', renderAnnexSummary(result))}
    </div>
    <div class="panel-grid">
      ${cardPanel('Disposal assessment', renderDisposalAssessment(result))}
      ${cardPanel('Rules checklist', renderRulesChecklist(result))}
    </div>`;
}

function renderSlopView(result) {
  const decision = safeArray(result.disposal_assessment)[0];
  const allowed  = Boolean(decision && decision.allowed);
  const rules    = safeArray(result.rules_checklist);
  const passed   = rules.filter(r => r.passed).length;
  return `
    <div class="stats-grid">
      ${statCard('Overall slop status', allowed ? 'PERMITTED' : 'NOT PERMITTED',
          'Operational result from the Annex I rule set.')}
      ${statCard('Distance to nearest land', `${formatNum(result.distance_to_nearest_land_nm, 2)} NM`,
          result.nearest_land_rule_satisfied ? '12 NM rule satisfied.' : 'Below the 12 NM threshold.')}
      ${statCard('Rules passed', `${passed}/${rules.length}`,
          allowed ? 'Every Annex I rule passed.' : 'One or more rules failed.')}
      ${statCard('Active oil zones', safeArray(result.active_zones).length,
          result.in_special_area ? 'Inside an Annex I special area.' : 'Outside Annex I special areas.')}
    </div>
    ${banner(result.summary, allowed)}
    ${renderAnnexTags(result)}
    <div class="subgrid">
      ${cardPanel('Slop decision', `
        <div class="tags-wrap">
          ${tag(allowed ? 'PERMITTED' : 'NOT PERMITTED', allowed ? 'ok' : 'error')}
          ${tag(result.in_special_area ? 'In special area' : 'Outside special area', result.in_special_area ? 'error' : 'ok')}
          ${tag(result.nearest_land_rule_satisfied ? '≥12 NM from land' : '<12 NM from land', result.nearest_land_rule_satisfied ? 'ok' : 'warning')}
        </div>
        ${renderDisposalAssessment(result)}`)}
      ${cardPanel('Slop rules checklist', renderRulesChecklist(result))}
    </div>
    ${cardPanel('Active oil zones', renderZoneList(result))}`;
}

function renderRouteView(result) {
  const crossed = safeArray(result.zones_crossed);
  const endpointCard = (title, point, letter) =>
    cardPanel(title, listWrap([listItem(letter, 'ok',
      point && point.label ? point.label : title,
      `${formatNum(point && point.lat, 4)}, ${formatNum(point && point.lon, 4)}`,
      `<div><strong>Source</strong> ${escapeHtml(point && point.source)}</div>`
    )]));
  const crossedCard = cardPanel(
    'MARPOL zones crossed by this voyage',
    crossed.length
      ? `<div class="tags-wrap">${crossed.map(z => tag(`Annex ${z.annex}`, 'annex')).join('')}</div>` +
        listWrap(crossed.map(z => listItem('!', 'no', z.zone_name, z.restriction,
          `<div><strong>Waste</strong> ${escapeHtml(z.waste_type)}</div>`)))
      : emptyState('The planned track does not cross any registered MARPOL special area.')
  );
  return `
    <div class="stats-grid">
      ${statCard('Route status', escapeHtml(result.route_status),
          result.is_on_route ? 'Ship position matches the intended corridor.' : 'Ship position is outside the allowed corridor.')}
      ${statCard('Cross-track distance', `${formatNum(result.cross_track_distance_nm, 2)} NM`,
          `Allowed corridor: ${formatNum(result.corridor_width_nm, 0)} NM.`)}
      ${statCard('Route progress', `${formatNum(result.route_progress_percent, 1)}%`,
          `${formatNum(result.along_track_distance_nm, 1)} NM along the track.`)}
      ${statCard('Total route distance', `${formatNum(result.total_route_distance_nm, 1)} NM`,
          `${safeArray(result.route_points).length} sampled geodesic points.`)}
    </div>
    ${banner(result.summary, result.is_on_route)}
    <div class="tags-wrap">
      ${tag(result.is_on_route ? 'On route' : 'Off route', result.is_on_route ? 'ok' : 'error')}
      ${tag(`${formatNum(Math.abs(Number(result.cross_track_distance_nm) || 0), 2)} NM off track`, result.is_on_route ? 'ok' : 'error')}
      ${tag(`${formatNum(result.route_progress_percent, 1)}% progress`, 'warning')}
    </div>
    <div class="panel-grid">
      ${endpointCard('Origin', result.origin, 'O')}
      ${endpointCard('Destination', result.destination, 'D')}
    </div>
    ${crossedCard}`;
}

/* ─────────────────────────────── panels ─────────────────────────────── */

function createPanelRenderer(spinnerId, resultsId, renderResult) {
  return function render(panelState) {
    id(spinnerId).style.display = panelState.status === 'loading' ? 'block' : 'none';
    const container = id(resultsId);
    if (panelState.status === 'idle')    { container.innerHTML = ''; return; }
    if (panelState.status === 'loading') { container.innerHTML = `<div class="empty-state">Contacting the compliance API…</div>`; return; }
    if (panelState.status === 'error')   { container.innerHTML = renderProblem(panelState.problem); return; }
    container.innerHTML = renderResult(panelState.result);
  };
}

renderers.zone  = createPanelRenderer('zoneSpinner',  'zoneResults',  renderZoneView);
renderers.slop  = createPanelRenderer('slopSpinner',  'slopResults',  renderSlopView);
renderers.route = createPanelRenderer('routeSpinner', 'routeResults', renderRouteView);

async function drawActiveZonePolygons(mapKey, activeZones) {
  const zoneIds = safeArray(activeZones).map(z => z.zone_id);
  if (!zoneIds.length) { maps.clearZonePolygons(mapKey); return; }
  const query = zoneIds.map(zoneId => `zone_id=${encodeURIComponent(zoneId)}`).join('&');
  try {
    maps.setZonePolygons(mapKey, await request(`${ENDPOINTS.zonesGeoJson}?${query}`));
  } catch (error) {
    console.warn('Zone polygon overlay unavailable:', error.message);
    maps.clearZonePolygons(mapKey);
  }
}

async function runZoneCheck() {
  const latitude  = numberFrom('zlat');
  const longitude = numberFrom('zlon');
  const shipId    = textFrom('zship', 'SHIP_101');
  const wasteTypeFilter = id('zfilter').value;

  if (latitude === null || longitude === null) {
    setState('zone', { status: 'error', result: null, problem: localCoordinateProblem });
    return;
  }
  const payload = { ship_id: shipId, latitude, longitude };
  if (wasteTypeFilter) payload.waste_type_filter = wasteTypeFilter;

  setState('zone', { status: 'loading', problem: null, request: payload });
  maps.setShip('zone', latitude, longitude, shipId + ' — evaluating…');

  try {
    const result = await postJson(ENDPOINTS.checkZone, payload);
    setState('zone', { status: 'ready', result, problem: null });
    maps.setShip('zone', latitude, longitude,
      `<b>${escapeHtml(shipId)}</b><br>${escapeHtml(result.zone_status)} — ${formatNum(result.distance_to_nearest_land_nm, 2)} NM from land`,
      { open: true });
    await drawActiveZonePolygons('zone', result.active_zones);
    addHistoryRecord({ type: 'Zone', ship_id: shipId, coords: `${latitude}, ${longitude}`,
      distance: result.distance_to_nearest_land_nm, status: result.zone_status, summary: result.summary });
  } catch (error) {
    handlePanelError('zone', error, { shipId, latitude, longitude });
  }
}

async function runSlopCheck() {
  const latitude  = numberFrom('slat');
  const longitude = numberFrom('slon');
  const shipId    = textFrom('sship', 'SHIP_101');

  if (latitude === null || longitude === null) {
    setState('slop', { status: 'error', result: null, problem: localCoordinateProblem });
    return;
  }
  const payload = {
    ship_id:              shipId,
    latitude,
    longitude,
    ship_speed_knots:     numberFrom('sspeed')  || 0,
    oil_content_ppm:      numberFrom('sppm')    || 0,
    discharge_rate_l_p_nm:numberFrom('srate')   || 0,
    tank_capacity_m3:     numberFrom('stank')   || 0,
    odmc_s_operational:   id('sodmcs').value === 'true'
  };

  setState('slop', { status: 'loading', problem: null, request: payload });
  maps.setShip('slop', latitude, longitude, shipId + ' — evaluating…');

  try {
    const result = await postJson(ENDPOINTS.checkSlop, payload);
    setState('slop', { status: 'ready', result, problem: null });
    const allowed = Boolean(safeArray(result.disposal_assessment)[0]?.allowed);
    maps.setShip('slop', latitude, longitude,
      `<b>${escapeHtml(shipId)}</b><br>Slop discharge: ${allowed ? 'PERMITTED' : 'NOT PERMITTED'}`,
      { onLand: false, open: true });
    await drawActiveZonePolygons('slop', result.active_zones);
    addHistoryRecord({ type: 'Slop', ship_id: shipId, coords: `${latitude}, ${longitude}`,
      distance: result.distance_to_nearest_land_nm, status: allowed ? 'PERMITTED' : 'NOT PERMITTED', summary: result.summary });
  } catch (error) {
    handlePanelError('slop', error, { shipId, latitude, longitude });
  }
}

async function runRouteCheck() {
  const latitude  = numberFrom('rlat');
  const longitude = numberFrom('rlon');
  const shipId    = textFrom('rship', 'SHIP_101');

  if (latitude === null || longitude === null) {
    setState('route', { status: 'error', result: null, problem: localCoordinateProblem });
    return;
  }
  const payload = {
    ship_id:           shipId,
    latitude,
    longitude,
    origin_port:       textFrom('roriginport')  || null,
    destination_port:  textFrom('rdestport')    || null,
    corridor_width_nm: numberFrom('rcorridor')  || 25
  };

  setState('route', { status: 'loading', problem: null, request: payload });

  try {
    const result = await postJson(ENDPOINTS.checkRoute, payload);
    setState('route', { status: 'ready', result, problem: null });
    maps.drawRoute(result);
    await drawActiveZonePolygons('route', result.zones_crossed);
    addHistoryRecord({ type: 'Route', ship_id: shipId, coords: `${latitude}, ${longitude}`,
      distance: result.cross_track_distance_nm, status: result.route_status, summary: result.summary });
  } catch (error) {
    handlePanelError('route', error, { shipId, latitude, longitude });
  }
}

const localCoordinateProblem = {
  type: 'about:blank', title: 'Invalid coordinates', status: 0,
  detail: 'Enter a numeric latitude and longitude before running the check.', instance: 'client'
};

function handlePanelError(panel, error, context) {
  const problem = error instanceof ApiProblem
    ? error.problem
    : { type: 'about:blank', title: 'Unexpected client error', status: 0, detail: error.message, instance: 'client' };
  setState(panel, { status: 'error', result: null, problem });
  const mapKey = panel;
  if (maps.exists(mapKey) && context.latitude !== null && context.longitude !== null) {
    maps.clearZonePolygons(mapKey);
    maps.setShip(mapKey, context.latitude, context.longitude,
      `<b style="color:${COLORS.danger}">${escapeHtml(problem.title)}</b><br>${escapeHtml(context.shipId)}`,
      { onLand: isOnLandProblem(problem), open: true });
  }
  addHistoryRecord({ type: panel.charAt(0).toUpperCase() + panel.slice(1),
    ship_id: context.shipId, coords: `${context.latitude}, ${context.longitude}`,
    distance: null, status: 'ERROR', summary: problem.detail });
}

/* ─────────────────────────────── history ─────────────────────────────── */

function loadHistory() {
  try {
    const stored = JSON.parse(localStorage.getItem('marpol_history'));
    state.history = Array.isArray(stored) ? stored : [];
  } catch (e) { state.history = []; }
}

function addHistoryRecord(record) {
  state.history = [Object.assign({ time: new Date().toLocaleTimeString() }, record)]
    .concat(state.history.slice(0, HISTORY_LIMIT));
  try { localStorage.setItem('marpol_history', JSON.stringify(state.history)); }
  catch (e) { console.warn('History could not be persisted:', e.message); }
  renderHistory();
  const lastCheckNode = id('heroLastCheck');
  if (lastCheckNode) lastCheckNode.textContent = `${record.type} — ${new Date().toLocaleTimeString()}`;
  const lastCheckDot = id('heroLastCheckDot');
  if (lastCheckDot) lastCheckDot.className = `hero-status-dot ${/ERROR|NOT|off/i.test(record.status) ? 'bad' : 'ok'}`;
}

function renderHistory() {
  const tbody = id('historyBody');
  if (!state.history.length) {
    tbody.innerHTML = `<tr><td colspan="7"><div class="empty-state">No requests yet. Run a zone check, slop check, or route check to populate the session history.</div></td></tr>`;
    return;
  }
  tbody.innerHTML = state.history.map(item => {
    const mode = /permit|safe|on.?route/i.test(item.status) ? 'ok'
               : /restrict|not|off.?route|error/i.test(item.status) ? 'bad' : 'warn';
    return `<tr>
      <td>${escapeHtml(item.time)}</td>
      <td>${escapeHtml(item.ship_id)}</td>
      <td>${escapeHtml(item.type)}</td>
      <td>${escapeHtml(item.coords)}</td>
      <td>${escapeHtml(formatNum(item.distance, 2))} NM</td>
      <td><span class="history-status ${mode}">${escapeHtml(item.status)}</span></td>
      <td>${escapeHtml(item.summary)}</td>
    </tr>`;
  }).join('');
}

function clearHistory() {
  state.history = [];
  localStorage.removeItem('marpol_history');
  renderHistory();
}

/* ───────────────────────────── chrome / shell ───────────────────────── */

const TABS = ['zone', 'slop', 'route', 'history'];

function showTab(tabName) {
  TABS.forEach(name => {
    const section   = id(`tab-${name}`);
    const navButton = document.querySelector(`[data-tab-btn="${name}"]`);
    if (section)   section.classList.toggle('hidden', name !== tabName);
    if (navButton) navButton.classList.toggle('active', name === tabName);
  });
  if (tabName === 'route') {
    if (!maps.exists('route')) { maps.create('route', 'routeMap'); syncMapFromRoute(); }
    setTimeout(() => maps.refresh('route'), 120);
  }
  if (tabName === 'slop') {
    if (!maps.exists('slop')) { maps.create('slop', 'slopMap'); syncSlopMapFromInputs(); }
    setTimeout(() => maps.refresh('slop'), 120);
  }
  if (tabName === 'zone') setTimeout(() => maps.refresh('zone'), 120);
}

function setTheme(theme) {
  state.theme = theme;
  document.documentElement.setAttribute('data-theme', theme);
  id('themeIcon').textContent  = theme === 'dark' ? '☀️' : '🌙';
  id('themeLabel').textContent = 'Switch theme';
}

function toggleTheme() { setTheme(state.theme === 'dark' ? 'light' : 'dark'); }

function renderApiStatus() {
  const pill = id('apiStatusPill');
  pill.classList.remove('ok', 'warn', 'bad');
  pill.classList.add(state.api.status === 'ok' ? 'ok' : state.api.status === 'checking' ? 'warn' : 'bad');
  id('apiStatusText').textContent = state.api.label;
}

async function pollHealth() {
  try {
    // Health endpoint is unauthenticated — use plain fetch, not request()
    const base = apiBase();
    const res  = await fetch(`${base}${ENDPOINTS.health}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json().catch(() => ({}));
    state.api = { status: 'ok', label: `API Online · v${data.version || '?'}` };
  } catch (e) {
    state.api = { status: 'bad', label: 'API Offline' };
  }
  renderApiStatus();
  setTimeout(pollHealth, HEALTH_POLL_MS);
}

/* ──── map → form sync helpers ──── */

function syncMapFromRoute() {
  // keep map centre in sync when user changes lat/lon inputs
  ['rlat', 'rlon'].forEach(fieldId => {
    const el = id(fieldId);
    if (el) el.addEventListener('change', () => {
      const lat = numberFrom('rlat');
      const lon = numberFrom('rlon');
      if (lat !== null && lon !== null) maps.setShip('route', lat, lon, 'Current position');
    });
  });
}

function syncSlopMapFromInputs() {
  ['slat', 'slon'].forEach(fieldId => {
    const el = id(fieldId);
    if (el) el.addEventListener('change', () => {
      const lat = numberFrom('slat');
      const lon = numberFrom('slon');
      if (lat !== null && lon !== null) maps.setShip('slop', lat, lon, 'Current position');
    });
  });
}

/* ─────────────────────────── boot ─────────────────────────── */

(function boot() {
  loadHistory();
  renderHistory();

  // Zone map is visible on load — create immediately
  maps.create('zone', 'zoneMap');

  // Wire up tab buttons
  document.querySelectorAll('[data-tab-btn]').forEach(btn => {
    btn.addEventListener('click', () => showTab(btn.dataset.tabBtn));
  });

  // Wire up action buttons
  const wire = (btnId, fn) => { const el = id(btnId); if (el) el.addEventListener('click', fn); };
  wire('runZoneCheck',  runZoneCheck);
  wire('runSlopCheck',  runSlopCheck);
  wire('runRouteCheck', runRouteCheck);
  wire('clearHistory',  clearHistory);
  wire('themeToggle',   toggleTheme);

  // Theme
  setTheme(state.theme);

  // Start health polling (first call is immediate)
  pollHealth();

  // Show default tab
  showTab('zone');
})();
