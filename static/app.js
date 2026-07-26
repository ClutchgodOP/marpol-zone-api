/**
 * Volteo Maritime MARPOL Compliance dashboard.
 *
 * Vanilla ES6, no framework, no build step. The file is organised as a set of
 * small modules held in closures:
 *
 *   config   → API base resolution and endpoint paths
 *   dom      → element lookup and HTML escaping
 *   api      → fetch wrapper that understands RFC 7807 problem+json
 *   store    → per-panel state objects + a render function per panel
 *   maps     → the three Leaflet instances and their layers
 *   views    → pure state → HTML functions
 *   panels   → zone / slop / route controllers
 *   history  → localStorage-backed session log
 *
 * The rendering contract is one-way: handlers only ever call setState(), and
 * setState() is the only thing that calls a panel's render(). Nothing else
 * touches the DOM of a results panel, so a panel's markup is always a pure
 * function of its state.
 */

'use strict';

/* ─────────────────────────────── config ─────────────────────────────── */

// Deployed backend (Railway). The dashboard itself is hosted separately
// (Vercel / static hosting), so any non-local origin defaults to this API.
const RAILWAY_API = 'https://volteo-maritime-marpol-zone-api.up.railway.app';

// Same-origin when developing locally (uvicorn serves index.html and /static);
// otherwise default to the deployed Railway API. The #apiBase input still
// overrides this at runtime.
const API_BASE = (() => {
  const origin = window.location.origin;
  const isHttp = origin && origin.startsWith('http');
  const isLocal = isHttp && /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
  if (isLocal || origin === RAILWAY_API) return origin;
  return RAILWAY_API;
})();

const ENDPOINTS = {
  health: '/health',
  checkZone: '/api/v1/check-zone',
  checkSlop: '/api/v1/check-slop',
  checkRoute: '/api/v1/check-route',
  zonesGeoJson: '/api/v1/zones/geojson'
};

const TILE_URL = 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png';
const TILE_OPTIONS = { maxZoom: 18, attribution: '© OpenStreetMap contributors' };
const INITIAL_VIEW = { center: [20, 0], zoom: 2 };
const HEALTH_POLL_MS = 15000;
const HISTORY_LIMIT = 30;

const COLORS = {
  primary: '#3d7cff',
  accent: '#35c5a7',
  danger: '#ff5d6c',
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

const textFrom = (elementId, fallback = '') => id(elementId).value.trim() || fallback;

/* ──────────────────────────────── api ──────────────────────────────── */

/** An RFC 7807 problem document raised as an Error. */
class ApiProblem extends Error {
  constructor(problem) {
    super(problem.detail || problem.title || 'Request failed');
    this.name = 'ApiProblem';
    this.problem = problem;
  }
}

const apiBase = () => {
  const override = id('apiBase').value.trim().replace(/\/+$/, '');
  return override || API_BASE;
};

/**
 * Any non-2xx response is turned into an ApiProblem. Servers that speak RFC
 * 7807 give us type/title/status/detail/instance directly; anything else
 * (a proxy error page, FastAPI's legacy {"detail": ...}, a network failure) is
 * normalised into the same shape so callers only handle one error type.
 */
async function request(path, options = {}) {
  const url = `${apiBase()}${path}`;

  let response;
  try {
    response = await fetch(url, options);
  } catch (networkError) {
    throw new ApiProblem({
      type: 'about:blank',
      title: 'Network error',
      status: 0,
      detail: `Could not reach the compliance API at ${url}. ${networkError.message}`,
      instance: path
    });
  }

  const contentType = response.headers.get('content-type') || '';
  const body = contentType.includes('json') ? await response.json().catch(() => null) : null;

  if (response.ok) return body;

  if (body && typeof body === 'object' && typeof body.title === 'string' && 'status' in body) {
    throw new ApiProblem(body);
  }

  const legacyDetail = body && body.detail;
  throw new ApiProblem({
    type: 'about:blank',
    title: `Request failed (${response.status})`,
    status: response.status,
    detail:
      typeof legacyDetail === 'string'
        ? legacyDetail
        : legacyDetail
          ? JSON.stringify(legacyDetail)
          : `The API responded with HTTP ${response.status}.`,
    instance: path
  });
}

const postJson = (path, payload) =>
  request(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });

/** True when a problem document reports a position rejected as being on land. */
const isOnLandProblem = problem =>
  typeof problem.type === 'string' && problem.type.endsWith('/coordinates-on-land');

/* ─────────────────────────────── store ─────────────────────────────── */

const emptyPanel = () => ({ status: 'idle', result: null, problem: null, request: null });

const state = {
  zone: emptyPanel(),
  slop: emptyPanel(),
  route: emptyPanel(),
  api: { status: 'checking', label: 'Checking API' },
  theme: document.documentElement.getAttribute('data-theme') || 'dark',
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
  const layers = { zone: {}, slop: {}, route: {} };

  const landIcon = () =>
    L.divIcon({
      className: '',
      html:
        '<div style="width:28px;height:28px;border-radius:50%;background:' +
        COLORS.danger +
        ';border:3px solid #fff;box-shadow:0 2px 10px rgba(255,93,108,.6);' +
        'display:grid;place-items:center;font-size:14px;line-height:1;">⛔</div>',
      iconSize: [28, 28],
      iconAnchor: [14, 14],
      popupAnchor: [0, -16]
    });

  const portIcon = letter => color =>
    L.divIcon({
      className: '',
      html:
        '<div style="width:26px;height:26px;border-radius:50%;background:' +
        color +
        ';border:3px solid #fff;box-shadow:0 2px 8px rgba(0,0,0,.45);color:#fff;' +
        'display:grid;place-items:center;font-size:12px;font-weight:800;line-height:1;">' +
        letter +
        '</div>',
      iconSize: [26, 26],
      iconAnchor: [13, 13],
      popupAnchor: [0, -14]
    });

  function create(key, containerId) {
    if (instances[key] || !id(containerId)) return instances[key];

    const map = L.map(containerId, { zoomControl: true, attributionControl: true }).setView(
      INITIAL_VIEW.center,
      INITIAL_VIEW.zoom
    );
    L.tileLayer(TILE_URL, TILE_OPTIONS).addTo(map);

    layers[key] = {
      ship: L.marker(INITIAL_VIEW.center).addTo(map).bindPopup('Ship position'),
      radius: L.circle(INITIAL_VIEW.center, {
        radius: 22224, // 12 NM in metres — the nearest-land threshold
        color: COLORS.primary,
        fillColor: COLORS.primary,
        fillOpacity: 0.12,
        weight: 1.5
      }).addTo(map),
      zones: L.layerGroup().addTo(map)
    };

    if (key === 'route') {
      layers.route.origin = L.marker(INITIAL_VIEW.center, { icon: portIcon('O')(COLORS.accent) }).addTo(map);
      layers.route.destination = L.marker(INITIAL_VIEW.center, { icon: portIcon('D')(COLORS.primary) }).addTo(map);
      layers.route.track = L.polyline([], {
        color: COLORS.accent,
        weight: 3,
        opacity: 0.95,
        dashArray: '8 10'
      }).addTo(map);
      map.removeLayer(layers.route.radius);
    }

    instances[key] = map;
    // The container may still be laying out (or hidden) on the first frame;
    // Leaflet projects against a zero-sized viewport if we do not re-measure.
    requestAnimationFrame(() => refresh(key));
    return map;
  }

  function refresh(key) {
    const map = instances[key];
    if (!map) return;
    try {
      map.invalidateSize({ animate: false });
    } catch (error) {
      console.warn(`Map ${key} refresh skipped:`, error.message);
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
    map.setView(coords, Math.max(map.getZoom() || minZoom, minZoom), { animate: true });
  }

  function setShip(key, lat, lon, { label = 'Ship position', onLand = false, open = false } = {}) {
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
      const properties = feature.properties || {};
      L.geoJSON(feature, {
        style: {
          color: COLORS.warning,
          weight: 1.5,
          fillColor: COLORS.warning,
          fillOpacity: 0.08
        }
      })
        .bindPopup(
          `<strong>${escapeHtml(properties.name)}</strong><br>Annex ${escapeHtml(properties.annex)}` +
            `<br><small>${escapeHtml(properties.restriction || '')}</small>`
        )
        .addTo(layers[key].zones);
    });
  }

  function clearZonePolygons(key) {
    if (instances[key]) layers[key].zones.clearLayers();
  }

  function drawRoute(result) {
    const map = instances.route;
    if (!map) return;

    const origin = [Number(result.origin.lat), Number(result.origin.lon)];
    const destination = [Number(result.destination.lat), Number(result.destination.lon)];
    const ship = [Number(result.latitude), Number(result.longitude)];

    layers.route.origin
      .setLatLng(origin)
      .bindPopup(
        `<strong>Origin</strong><br>${escapeHtml(result.origin.label)}` +
          `<br><small>${formatNum(result.origin.lat, 4)}, ${formatNum(result.origin.lon, 4)}</small>`
      );

    layers.route.destination
      .setLatLng(destination)
      .bindPopup(
        `<strong>Destination</strong><br>${escapeHtml(result.destination.label)}` +
          `<br><small>${formatNum(result.destination.lat, 4)}, ${formatNum(result.destination.lon, 4)}</small>`
      );

    // Prefer the geodesic the API sampled; fall back to a straight leg so the
    // polyline still renders against an older backend.
    const track = safeArray(result.route_points);
    layers.route.track.setLatLngs(track.length >= 2 ? track : [origin, destination]);
    layers.route.track.setStyle({ color: result.is_on_route ? COLORS.accent : COLORS.danger });

    setShip('route', ship[0], ship[1], {
      label: result.is_on_route
        ? `<b style="color:${COLORS.accent}">✓ On route</b><br>${escapeHtml(result.ship_id)}`
        : `<b style="color:${COLORS.danger}">⛔ Off route</b><br>${escapeHtml(result.ship_id)}`,
      onLand: !result.is_on_route,
      open: true
    });

    refresh('route');
    if (!hasViewport(map)) return;
    map.flyToBounds(L.latLngBounds([origin, destination, ship]), {
      padding: [40, 40],
      animate: true,
      duration: 0.8
    });
  }

  function reset(key) {
    const map = instances[key];
    if (!map) return;
    map.setView(INITIAL_VIEW.center, INITIAL_VIEW.zoom);
  }

  return {
    create,
    refresh,
    reset,
    setShip,
    setZonePolygons,
    clearZonePolygons,
    drawRoute,
    exists: key => Boolean(instances[key])
  };
})();

/* ─────────────────────────────── views ─────────────────────────────── */

const tag = (text, mode) => `<span class="tag ${mode}">${escapeHtml(text)}</span>`;

const banner = (text, good) =>
  `<div class="info-banner ${good ? 'banner-good' : 'banner-bad'}">${escapeHtml(text)}</div>`;

const statCard = (label, value, note) => `
  <div class="stat-card">
    <span class="stat-label">${escapeHtml(label)}</span>
    <div class="stat-value">${value}</div>
    <div class="stat-note">${note}</div>
  </div>`;

const emptyState = message => `<div class="empty-state">${escapeHtml(message)}</div>`;

const cardPanel = (title, inner) => `
  <div class="panel card">
    <div class="section-heading"><div><div class="section-title" style="font-size:1.15rem">${escapeHtml(
      title
    )}</div></div></div>
    ${inner}
  </div>`;

const listItem = ({ icon, iconMode, title, subtitle, meta }) => `
  <div class="list-item">
    <div class="list-icon ${iconMode}">${escapeHtml(icon)}</div>
    <div>
      <div class="list-item-title">${escapeHtml(title)}</div>
      <div class="list-item-subtitle">${escapeHtml(subtitle)}</div>
    </div>
    <div class="list-item-meta">${meta || ''}</div>
  </div>`;

const listWrap = items =>
  items.length ? `<div class="list-wrap">${items.join('')}</div>` : '';

/** Annex chips built from the API's annex_summary (falls back to active_zones). */
function renderAnnexTags(result) {
  const fromSummary = safeArray(result.annex_summary).map(item => `Annex ${item.annex}`);
  const annexes = fromSummary.length
    ? fromSummary
    : Array.from(new Set(safeArray(result.active_zones).map(zone => `Annex ${zone.annex}`)));

  if (!annexes.length) return '';
  return `<div class="tags-wrap">${annexes.map(label => tag(label, 'annex')).join('')}</div>`;
}

function renderZoneList(result) {
  const zones = safeArray(result.active_zones);
  if (!zones.length) {
    return emptyState('No active MARPOL zones were returned for the current coordinates.');
  }

  const chips = zones.map(zone => tag(zone.zone_name || zone.zone_id, 'zone')).join('');

  const items = zones.map(zone => {
    const dates = zone.effective_date
      ? `<div><strong>In force</strong> ${escapeHtml(zone.effective_date)}</div>` +
        (zone.enforcement_date
          ? `<div><strong>Enforced</strong> ${escapeHtml(zone.enforcement_date)}</div>`
          : '')
      : '';

    return listItem({
      icon: '!',
      iconMode: 'no',
      title: zone.zone_name || 'Unnamed MARPOL zone',
      subtitle: zone.guidance || zone.restriction || 'Restriction not available.',
      meta:
        `<div><strong>Annex</strong> ${escapeHtml(zone.annex)}</div>` +
        `<div><strong>Waste</strong> ${escapeHtml(zone.waste_type)}</div>` +
        `<div><strong>ID</strong> ${escapeHtml(zone.zone_id)}</div>` +
        dates
    });
  });

  return `<div class="tags-wrap">${chips}</div>${listWrap(items)}`;
}

function renderAnnexSummary(result) {
  const annexes = safeArray(result.annex_summary);
  if (!annexes.length) {
    return emptyState('Annex summary is empty. This usually means no active zones were found.');
  }

  return listWrap(
    annexes.map(item =>
      listItem({
        icon: 'A',
        iconMode: 'ok',
        title: `Annex ${item.annex}`,
        subtitle: `Waste types: ${safeArray(item.waste_types).join(', ')}`,
        meta: `<div><strong>Zones</strong> ${escapeHtml(item.active_zone_count || 0)}</div>`
      })
    )
  );
}

function renderDisposalAssessment(result) {
  const items = safeArray(result.disposal_assessment);
  if (!items.length) return emptyState('No disposal assessment items were returned.');

  return listWrap(
    items.map(item =>
      listItem({
        icon: item.allowed ? '✓' : '✗',
        iconMode: item.allowed ? 'ok' : 'no',
        title: item.label || item.code || 'Assessment item',
        subtitle: item.reason || 'No explanation returned.',
        meta: item.allowed ? tag('Allowed', 'ok') : tag('Restricted', 'error')
      })
    )
  );
}

function renderRulesChecklist(result) {
  const rules = safeArray(result.rules_checklist);
  if (!rules.length) return emptyState('No rules checklist was returned.');

  return listWrap(
    rules.map(rule =>
      listItem({
        icon: rule.passed ? '✓' : '✗',
        iconMode: rule.passed ? 'ok' : 'no',
        title: rule.rule_name || rule.rule_code || 'Rule',
        subtitle: rule.note || 'No note returned.',
        meta:
          `<div><strong>Actual</strong> ${escapeHtml(rule.actual_value)}</div>` +
          `<div><strong>Required</strong> ${escapeHtml(rule.required_value)}</div>`
      })
    )
  );
}

/** Renders an RFC 7807 problem: detail goes in the .banner-bad, the rest in a list. */
function renderProblem(problem) {
  const validationErrors = safeArray(problem.errors).map(error =>
    listItem({
      icon: '✗',
      iconMode: 'no',
      title: error.field || 'Field',
      subtitle: error.message || 'Invalid value',
      meta: `<div><strong>Type</strong> ${escapeHtml(error.type || '—')}</div>`
    })
  );

  const details = [
    listItem({
      icon: '!',
      iconMode: 'no',
      title: problem.title || 'Request failed',
      subtitle: problem.detail || 'The API returned an error without a description.',
      meta:
        `<div><strong>Status</strong> ${escapeHtml(problem.status)}</div>` +
        `<div><strong>Type</strong> ${escapeHtml(problem.type || 'about:blank')}</div>` +
        (problem.instance ? `<div><strong>Instance</strong> ${escapeHtml(problem.instance)}</div>` : '')
    })
  ];

  return (
    banner(problem.detail || problem.title || 'Request failed', false) +
    cardPanel('Problem details', listWrap(details.concat(validationErrors)))
  );
}

function renderZoneView(result) {
  const safe = result.zone_status === 'SAFE' && result.nearest_land_rule_satisfied;

  return `
    <div class="stats-grid">
      ${statCard(
        'Zone status',
        escapeHtml(result.zone_status || 'UNKNOWN'),
        result.in_special_area
          ? 'At least one MARPOL special area is active.'
          : 'No MARPOL special area is active here.'
      )}
      ${statCard(
        'Distance to nearest land',
        `${formatNum(result.distance_to_nearest_land_nm, 2)} NM`,
        result.nearest_land_rule_satisfied ? '✅ 12 NM rule satisfied.' : '⚠️ Below the 12 NM threshold.'
      )}
      ${statCard(
        'Active zones',
        safeArray(result.active_zones).length,
        `${safeArray(result.annex_summary).length} annex(es) engaged.`
      )}
      ${statCard(
        'Disposal items',
        safeArray(result.disposal_assessment).length,
        `${safeArray(result.disposal_assessment).filter(item => item.allowed).length} currently permitted.`
      )}
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
  const decision = safeArray(result.disposal_assessment)[0] || {};
  const allowed = Boolean(decision.allowed);
  const rules = safeArray(result.rules_checklist);
  const passed = rules.filter(rule => rule.passed).length;

  return `
    <div class="stats-grid">
      ${statCard(
        'Overall slop status',
        allowed ? 'PERMITTED' : 'NOT PERMITTED',
        'Operational result from the Annex I rule set.'
      )}
      ${statCard(
        'Distance to nearest land',
        `${formatNum(result.distance_to_nearest_land_nm, 2)} NM`,
        result.nearest_land_rule_satisfied ? '✅ 12 NM rule satisfied.' : '⚠️ Below the 12 NM threshold.'
      )}
      ${statCard(
        'Rules passed',
        `${passed}/${rules.length}`,
        allowed ? 'Every Annex I rule passed.' : 'One or more rules failed.'
      )}
      ${statCard(
        'Active oil zones',
        safeArray(result.active_zones).length,
        result.in_special_area ? 'Inside an Annex I special area.' : 'Outside Annex I special areas.'
      )}
    </div>
    ${banner(result.summary, allowed)}
    ${renderAnnexTags(result)}
    <div class="subgrid">
      ${cardPanel(
        'Slop decision',
        `<div class="tags-wrap">
          ${tag(allowed ? 'PERMITTED' : 'NOT PERMITTED', allowed ? 'ok' : 'error')}
          ${tag(
            result.in_special_area ? 'In special area' : 'Outside special area',
            result.in_special_area ? 'error' : 'ok'
          )}
          ${tag(
            result.nearest_land_rule_satisfied ? '≥12 NM from land' : '<12 NM from land',
            result.nearest_land_rule_satisfied ? 'ok' : 'warning'
          )}
        </div>${renderDisposalAssessment(result)}`
      )}
      ${cardPanel('Slop rules checklist', renderRulesChecklist(result))}
    </div>
    ${cardPanel('Active oil zones', renderZoneList(result))}`;
}

function renderRouteView(result) {
  const crossed = safeArray(result.zones_crossed);

  const endpointCard = (title, point, letter) =>
    cardPanel(
      title,
      listWrap([
        listItem({
          icon: letter,
          iconMode: 'ok',
          title: (point && point.label) || title,
          subtitle: `${formatNum(point && point.lat, 4)}, ${formatNum(point && point.lon, 4)}`,
          meta: `<div><strong>Source</strong> ${escapeHtml((point && point.source) || '—')}</div>`
        })
      ])
    );

  const crossedCard = cardPanel(
    'MARPOL zones crossed by this voyage',
    crossed.length
      ? `<div class="tags-wrap">${crossed
          .map(zone => tag(`Annex ${zone.annex}`, 'annex'))
          .join('')}</div>` +
          listWrap(
            crossed.map(zone =>
              listItem({
                icon: '!',
                iconMode: 'no',
                title: zone.zone_name,
                subtitle: zone.restriction,
                meta: `<div><strong>Waste</strong> ${escapeHtml(zone.waste_type)}</div>`
              })
            )
          )
      : emptyState('The planned track does not cross any registered MARPOL special area.')
  );

  return `
    <div class="stats-grid">
      ${statCard(
        'Route status',
        escapeHtml(result.route_status),
        result.is_on_route
          ? 'Ship position matches the intended corridor.'
          : 'Ship position is outside the allowed corridor or span.'
      )}
      ${statCard(
        'Cross-track distance',
        `${formatNum(Math.abs(Number(result.cross_track_distance_nm || 0)), 2)} NM`,
        'Perpendicular distance from the planned great-circle track.'
      )}
      ${statCard(
        'Route progress',
        `${formatNum(result.route_progress_percent, 1)}%`,
        'Estimated completion between origin and destination.'
      )}
      ${statCard(
        'Zones crossed',
        crossed.length,
        `${Array.from(new Set(crossed.map(zone => zone.annex))).length} annex(es) along this route.`
      )}
    </div>
    ${banner(result.summary, result.is_on_route)}
    <div class="tags-wrap">
      ${tag(result.is_on_route ? 'On route' : 'Off route', result.is_on_route ? 'ok' : 'error')}
      ${tag(`${formatNum(Math.abs(Number(result.cross_track_distance_nm || 0)), 2)} NM off track`,
        result.is_on_route ? 'ok' : 'error')}
      ${tag(`${formatNum(result.route_progress_percent, 1)}% progress`, 'warning')}
    </div>
    <div class="panel-grid">
      ${endpointCard('Origin', result.origin, 'O')}
      ${endpointCard('Destination', result.destination, 'D')}
    </div>
    ${crossedCard}`;
}

/* ────────────────────────────── panels ────────────────────────────── */

/**
 * Binds one panel's state to the DOM: spinner visibility, results container,
 * and (on success) the panel-specific view. Registered in `renderers` so that
 * setState() is the single path from state change to repaint.
 */
function createPanelRenderer({ spinnerId, resultsId, renderResult }) {
  return function render(panelState) {
    id(spinnerId).style.display = panelState.status === 'loading' ? 'block' : 'none';

    const container = id(resultsId);
    if (panelState.status === 'loading') {
      container.innerHTML = `<div class="empty-state">Contacting the compliance API…</div>`;
      return;
    }
    if (panelState.status === 'error') {
      container.innerHTML = renderProblem(panelState.problem);
      return;
    }
    container.innerHTML = renderResult(panelState.result);
  };
}

renderers.zone = createPanelRenderer({
  spinnerId: 'zoneSpinner',
  resultsId: 'zoneResults',
  renderResult: renderZoneView
});

renderers.slop = createPanelRenderer({
  spinnerId: 'slopSpinner',
  resultsId: 'slopResults',
  renderResult: renderSlopView
});

renderers.route = createPanelRenderer({
  spinnerId: 'routeSpinner',
  resultsId: 'routeResults',
  renderResult: renderRouteView
});

/** Fetch and draw the polygons of the zones the ship is currently inside. */
async function drawActiveZonePolygons(mapKey, activeZones) {
  const zoneIds = safeArray(activeZones).map(zone => zone.zone_id);
  if (!zoneIds.length) {
    maps.clearZonePolygons(mapKey);
    return;
  }

  const query = zoneIds.map(zoneId => `zone_id=${encodeURIComponent(zoneId)}`).join('&');
  try {
    maps.setZonePolygons(mapKey, await request(`${ENDPOINTS.zonesGeoJson}?${query}`));
  } catch (error) {
    // Non-fatal: the compliance verdict is already rendered without the overlay.
    console.warn('Zone polygon overlay unavailable:', error.message);
    maps.clearZonePolygons(mapKey);
  }
}

/* ---- Operations Bar sync (additive: feeds the new live KPI cards) ---- */
function updateOpsBar(patch) {
  const map = {
    opsApiHealth: patch.apiHealth,
    opsApiHealthSub: patch.apiHealthSub,
    opsCurrentZone: patch.currentZone,
    opsActiveVessel: patch.activeVessel,
    opsConfidence: patch.confidence
  };
  Object.entries(map).forEach(([elementId, value]) => {
    if (value === undefined) return;
    const el = id(elementId);
    if (el) el.textContent = value;
  });
}

async function runZoneCheck() {
  const latitude = numberFrom('z_lat');
  const longitude = numberFrom('z_lon');
  const shipId = textFrom('z_ship', 'SHIP_101');
  const wasteTypeFilter = id('z_filter').value;

  if (latitude === null || longitude === null) {
    setState('zone', { status: 'error', result: null, problem: localCoordinateProblem() });
    return;
  }

  const payload = { ship_id: shipId, latitude, longitude };
  if (wasteTypeFilter) payload.waste_type_filter = wasteTypeFilter;

  setState('zone', { status: 'loading', problem: null, request: payload });
  maps.setShip('zone', latitude, longitude, { label: `${shipId} — evaluating…` });
  updateOpsBar({ activeVessel: shipId });

  try {
    const result = await postJson(ENDPOINTS.checkZone, payload);
    setState('zone', { status: 'ready', result, problem: null });

    maps.setShip('zone', latitude, longitude, {
      label: `<b>${escapeHtml(shipId)}</b><br>${escapeHtml(result.zone_status)} — ${formatNum(
        result.distance_to_nearest_land_nm,
        2
      )} NM from land`,
      open: true
    });
    await drawActiveZonePolygons('zone', result.active_zones);

    const inZone = Boolean(result.in_special_area);
    updateOpsBar({
      currentZone: inZone ? (safeArray(result.active_zones)[0]?.zone_name || 'Inside special area') : 'Outside',
      confidence: result.nearest_land_rule_satisfied ? '92%' : '68%'
    });

    addHistoryRecord({
      type: 'Zone',
      ship_id: shipId,
      coords: `${latitude}, ${longitude}`,
      distance: result.distance_to_nearest_land_nm,
      status: result.zone_status,
      summary: result.summary
    });
  } catch (error) {
    handlePanelError('zone', error, { shipId, latitude, longitude });
  }
}

async function runSlopCheck() {
  const latitude = numberFrom('s_lat');
  const longitude = numberFrom('s_lon');
  const shipId = textFrom('s_ship', 'SHIP_101');

  if (latitude === null || longitude === null) {
    setState('slop', { status: 'error', result: null, problem: localCoordinateProblem() });
    return;
  }

  const payload = {
    ship_id: shipId,
    latitude,
    longitude,
    ship_speed_knots: numberFrom('s_speed') || 0,
    oil_content_ppm: numberFrom('s_ppm') || 0,
    discharge_rate_lpnm: numberFrom('s_rate') || 0,
    tank_capacity_m3: numberFrom('s_tank') || 0,
    odmcs_operational: id('s_odmcs').value === 'true'
  };

  setState('slop', { status: 'loading', problem: null, request: payload });
  maps.setShip('slop', latitude, longitude, { label: `${shipId} — evaluating…` });

  try {
    const result = await postJson(ENDPOINTS.checkSlop, payload);
    setState('slop', { status: 'ready', result, problem: null });

    const allowed = Boolean(safeArray(result.disposal_assessment)[0]?.allowed);
    maps.setShip('slop', latitude, longitude, {
      label: `<b>${escapeHtml(shipId)}</b><br>Slop discharge ${allowed ? 'PERMITTED' : 'NOT PERMITTED'}`,
      onLand: false,
      open: true
    });
    await drawActiveZonePolygons('slop', result.active_zones);

    addHistoryRecord({
      type: 'Slop',
      ship_id: shipId,
      coords: `${latitude}, ${longitude}`,
      distance: result.distance_to_nearest_land_nm,
      status: allowed ? 'PERMITTED' : 'NOT PERMITTED',
      summary: result.summary
    });
  } catch (error) {
    handlePanelError('slop', error, { shipId, latitude, longitude });
  }
}

async function runRouteCheck() {
  const latitude = numberFrom('r_lat');
  const longitude = numberFrom('r_lon');
  const shipId = textFrom('r_ship', 'SHIP_101');

  if (latitude === null || longitude === null) {
    setState('route', { status: 'error', result: null, problem: localCoordinateProblem() });
    return;
  }

  const payload = {
    ship_id: shipId,
    latitude,
    longitude,
    origin_port: textFrom('r_origin_port') || null,
    destination_port: textFrom('r_dest_port') || null,
    corridor_width_nm: numberFrom('r_corridor') || 25
  };

  setState('route', { status: 'loading', problem: null, request: payload });

  try {
    const result = await postJson(ENDPOINTS.checkRoute, payload);
    setState('route', { status: 'ready', result, problem: null });

    maps.drawRoute(result);
    await drawActiveZonePolygons('route', result.zones_crossed);

    addHistoryRecord({
      type: 'Route',
      ship_id: shipId,
      coords: `${latitude}, ${longitude}`,
      distance: result.cross_track_distance_nm,
      status: result.route_status,
      summary: result.summary
    });
  } catch (error) {
    handlePanelError('route', error, { shipId, latitude, longitude });
  }
}

const localCoordinateProblem = () => ({
  type: 'about:blank',
  title: 'Invalid coordinates',
  status: 0,
  detail: 'Enter a numeric latitude and longitude before running the check.',
  instance: 'client'
});

function handlePanelError(panel, error, context) {
  const problem =
    error instanceof ApiProblem
      ? error.problem
      : {
          type: 'about:blank',
          title: 'Unexpected client error',
          status: 0,
          detail: error.message,
          instance: 'client'
        };

  setState(panel, { status: 'error', result: null, problem });

  const mapKey = panel;
  if (maps.exists(mapKey) && context.latitude !== null && context.longitude !== null) {
    maps.clearZonePolygons(mapKey);
    maps.setShip(mapKey, context.latitude, context.longitude, {
      label: `<b style="color:${COLORS.danger}">${escapeHtml(problem.title)}</b><br>${escapeHtml(
        context.shipId
      )}`,
      onLand: isOnLandProblem(problem),
      open: true
    });
  }

  addHistoryRecord({
    type: panel.charAt(0).toUpperCase() + panel.slice(1),
    ship_id: context.shipId,
    coords: `${context.latitude}, ${context.longitude}`,
    distance: null,
    status: 'ERROR',
    summary: problem.detail
  });
}

/* ────────────────────────────── history ────────────────────────────── */

function loadHistory() {
  try {
    const stored = JSON.parse(localStorage.getItem('marpol_history'));
    state.history = Array.isArray(stored) ? stored : [];
  } catch (error) {
    state.history = [];
  }
}

function addHistoryRecord(record) {
  state.history = [
    Object.assign({ time: new Date().toLocaleTimeString() }, record)
  ].concat(state.history).slice(0, HISTORY_LIMIT);

  try {
    localStorage.setItem('marpol_history', JSON.stringify(state.history));
  } catch (error) {
    console.warn('History could not be persisted:', error.message);
  }
  renderHistory();

  const feed = id('activityFeed');
  if (feed) {
    const mode = /permit|safe|on_route/i.test(record.status)
      ? 'ok'
      : /restricted|not|off_route|error/i.test(record.status)
        ? 'bad'
        : 'info';
    const row = document.createElement('div');
    row.className = 'activity-row fade-in';
    row.innerHTML = `
      <span class="activity-dot ${mode}"></span>
      <span class="activity-time">${escapeHtml(new Date().toLocaleTimeString())}</span>
      <span class="activity-text">${escapeHtml(record.type)} check — ${escapeHtml(record.ship_id)} (${escapeHtml(record.status)})</span>
      <span class="activity-tag">${escapeHtml(record.type)}</span>`;
    feed.insertBefore(row, feed.firstChild);
    while (feed.children.length > 40) feed.removeChild(feed.lastChild);
  }

  const opsChecks = id('opsChecksToday');
  if (opsChecks) {
    const current = parseInt(opsChecks.textContent, 10) || 0;
    opsChecks.textContent = String(current + 1);
  }
}

function renderHistory() {
  const tbody = id('historyBody');
  if (!state.history.length) {
    tbody.innerHTML = `<tr><td colspan="7"><div class="empty-state">No requests yet. Run a zone check, slop check, or route check to populate the session history.</div></td></tr>`;
    return;
  }

  tbody.innerHTML = state.history
    .map(item => {
      const mode = /permit|safe|on_route/i.test(item.status)
        ? 'ok'
        : /restricted|not|off_route|error/i.test(item.status)
          ? 'bad'
          : 'warn';

      return `<tr>
        <td>${escapeHtml(item.time)}</td>
        <td>${escapeHtml(item.ship_id)}</td>
        <td>${escapeHtml(item.type)}</td>
        <td>${escapeHtml(item.coords)}</td>
        <td>${escapeHtml(formatNum(item.distance, 2))} NM</td>
        <td><span class="history-status ${mode}">${escapeHtml(item.status)}</span></td>
        <td>${escapeHtml(item.summary)}</td>
      </tr>`;
    })
    .join('');
}

function clearHistory() {
  state.history = [];
  localStorage.removeItem('marpol_history');
  renderHistory();
}

/* ──────────────────────────── chrome / shell ──────────────────────────── */

const TABS = ['zone', 'slop', 'route', 'history'];

function showTab(tabName) {
  TABS.forEach(name => {
    const section = id(`tab-${name}`);
    const navButton = document.querySelector(`[data-tab-btn="${name}"]`);
    if (section) section.classList.toggle('hidden', name !== tabName);
    if (navButton) navButton.classList.toggle('active', name === tabName);
  });

  // Maps in initially hidden tabs are created on first reveal: Leaflet cannot
  // project against a display:none container.
  if (tabName === 'route') {
    if (!maps.exists('route')) {
      maps.create('route', 'routeMap');
      syncMapFromRoute();
    }
    setTimeout(() => maps.refresh('route'), 120);
  }
  if (tabName === 'slop') {
    if (!maps.exists('slop')) {
      maps.create('slop', 'slopMap');
      syncSlopMapFromInputs();
    }
    setTimeout(() => maps.refresh('slop'), 120);
  }
  if (tabName === 'zone') setTimeout(() => maps.refresh('zone'), 120);
}

function setTheme(theme) {
  state.theme = theme;
  document.documentElement.setAttribute('data-theme', theme);
  id('themeIcon').textContent = theme === 'dark' ? '☀️' : '🌙';
  id('themeLabel').textContent = 'Switch theme';
}

function toggleTheme() {
  setTheme(state.theme === 'dark' ? 'light' : 'dark');
}

function renderApiStatus() {
  const pill = id('apiStatusPill');
  pill.classList.remove('ok', 'warn', 'bad');
  pill.classList.add(state.api.status === 'ok' ? 'ok' : state.api.status === 'checking' ? 'warn' : 'bad');
  id('apiStatusText').textContent = state.api.label;
}

async function checkHealth() {
  try {
    const health = await request(ENDPOINTS.health);
    const backend = health.spatial_index ? ` (${health.spatial_index.backend})` : '';
    state.api = { status: 'ok', label: `${health.service} — connected${backend}` };
    updateOpsBar({ apiHealth: 'Healthy', apiHealthSub: `Connected${backend} — no incidents` });
  } catch (error) {
    state.api = { status: 'bad', label: 'API offline or blocked' };
    updateOpsBar({ apiHealth: 'Offline', apiHealthSub: 'Unreachable — check API base URL' });
  }
  renderApiStatus();
}

/* ─────────────────────── map sync button handlers ─────────────────────── */

const syncMapFromZone = () => maps.setShip('zone', numberFrom('z_lat'), numberFrom('z_lon'), {
  label: `Zone check position`
});

const syncMapFromSlop = () => maps.setShip('zone', numberFrom('s_lat'), numberFrom('s_lon'), {
  label: `Slop check position`
});

const syncSlopMapFromInputs = () => maps.setShip('slop', numberFrom('s_lat'), numberFrom('s_lon'), {
  label: `Slop check position`
});

const syncMapFromRoute = () => maps.setShip('route', numberFrom('r_lat'), numberFrom('r_lon'), {
  label: `Route check position`
});

const resetMapView = () => maps.reset('zone');
const resetSlopMapView = () => maps.reset('slop');
const resetRouteMapView = () => maps.reset('route');

/* ──────────────────────────────── init ──────────────────────────────── */

function init() {
  const apiBaseInput = id('apiBase');
  if (!apiBaseInput.value.trim()) apiBaseInput.value = API_BASE;
  apiBaseInput.placeholder = API_BASE;

  setTheme(state.theme);
  renderApiStatus();

  loadHistory();
  renderHistory();

  maps.create('zone', 'map');
  syncMapFromZone();

  // Paint the initial (idle) state of every panel through the same path a
  // response would take, so the spinners start hidden and panels start empty.
  TABS.filter(name => name !== 'history').forEach(name => setState(name, {}));

  checkHealth();
  setInterval(checkHealth, HEALTH_POLL_MS);
}

// The markup uses inline onclick attributes, so the handlers must be reachable
// as globals.
Object.assign(window, {
  showTab,
  toggleTheme,
  runZoneCheck,
  runSlopCheck,
  runRouteCheck,
  syncMapFromZone,
  syncMapFromSlop,
  syncSlopMapFromInputs,
  syncMapFromRoute,
  resetMapView,
  resetSlopMapView,
  resetRouteMapView,
  clearHistory
});

window.addEventListener('DOMContentLoaded', init);

/* ============ UI POLISH LAYER (append-only, no edits to existing code) ============ */

/* ---- Animated counters ---- */
function animateCounter(el, targetText, duration = 900) {
  const match = String(targetText).match(/-?\d+(\.\d+)?/);
  if (!match) { el.textContent = targetText; return; }
  const target = parseFloat(match[0]);
  const suffix = String(targetText).slice(match.index + match[0].length);
  const prefix = String(targetText).slice(0, match.index);
  const decimals = (match[0].split('.')[1] || '').length;
  const start = performance.now();
  const from = 0;
  function tick(now) {
    const progress = Math.min(1, (now - start) / duration);
    const eased = 1 - Math.pow(1 - progress, 3);
    const value = (from + (target - from) * eased).toFixed(decimals);
    el.textContent = `${prefix}${value}${suffix}`;
    if (progress < 1) requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);
}

function animateAllCounters(scope = document) {
  scope.querySelectorAll('.kpi-value, .stat-value').forEach(el => {
    if (el.dataset.counted) return;
    el.dataset.counted = '1';
    const original = el.textContent;
    animateCounter(el, original);
  });
}

/* ---- Skeleton loaders (overrides loading branch visually) ---- */
function skeletonStackHtml() {
  return `<div class="skeleton-stack">
    <div class="skeleton-row">
      <div class="skeleton-block"></div><div class="skeleton-block"></div>
      <div class="skeleton-block"></div><div class="skeleton-block"></div>
    </div>
    <div class="skeleton-block" style="height:160px;"></div>
  </div>`;
}

const originalResultIds = ['zoneResults', 'slopResults', 'routeResults'];
const skeletonObserver = new MutationObserver(() => {
  originalResultIds.forEach(rid => {
    const el = id(rid);
    if (el && el.innerHTML.includes('Contacting the compliance API')) {
      el.innerHTML = skeletonStackHtml();
    }
  });
  animateAllCounters(document);
});
originalResultIds.forEach(rid => {
  const el = id(rid);
  if (el) skeletonObserver.observe(el, { childList: true });
});

/* ---- Keyboard shortcuts ---- */
document.addEventListener('keydown', (event) => {
  const tag = (event.target.tagName || '').toLowerCase();
  const typing = tag === 'input' || tag === 'textarea' || tag === 'select';

  if (event.key === '/' && !typing) {
    event.preventDefault();
    const search = id('historySearch') || id('drawerSearch');
    if (search) search.focus();
    return;
  }
  if (typing) return;

  if (['1', '2', '3', '4'].includes(event.key)) {
    const tabMap = { '1': 'zone', '2': 'slop', '3': 'route', '4': 'history' };
    const target = tabMap[event.key];
    const btn = document.querySelector(`[data-tab-btn="${target}"]`);
    if (btn) showTab(target, btn);
  }
  if (event.key.toLowerCase() === 'd') toggleDrawer();
  if (event.key.toLowerCase() === 't') toggleTheme();
  if (event.key === 'Escape') {
    const drawer = id('historyDrawer');
    if (drawer && drawer.classList.contains('open')) toggleDrawer();
  }
});

/* ---- Recent history drawer ---- */
function toggleDrawer() {
  const drawer = id('historyDrawer');
  const overlay = id('drawerOverlay');
  if (!drawer || !overlay) return;
  const opening = !drawer.classList.contains('open');
  drawer.classList.toggle('open', opening);
  overlay.classList.toggle('open', opening);
  if (opening) renderDrawer();
}

function renderDrawer() {
  const list = id('drawerList');
  if (!list) return;
  const query = (id('drawerSearch').value || '').toLowerCase();
  const items = (state.history || []).filter(item =>
    !query ||
    String(item.ship_id).toLowerCase().includes(query) ||
    String(item.type).toLowerCase().includes(query) ||
    String(item.status).toLowerCase().includes(query)
  );

  if (!items.length) {
    list.innerHTML = `<div class="empty-state">No matching recent activity.</div>`;
    return;
  }

  list.innerHTML = items.map((item, index) => `
    <div class="drawer-item" style="animation-delay:${index * 40}ms;">
      <div class="di-top">
        <span>${escapeHtml(item.time)}</span>
        <span>${escapeHtml(item.type)}</span>
      </div>
      <div class="di-summary"><strong>${escapeHtml(item.ship_id)}</strong> — ${escapeHtml(item.status)}</div>
    </div>
  `).join('');
}

/* ---- Searchable request history (main History tab table) ---- */
function filterHistory(query) {
  const tbody = id('historyBody');
  if (!tbody) return;
  const term = (query || '').toLowerCase();
  const filtered = !term
    ? state.history
    : state.history.filter(item =>
        String(item.ship_id).toLowerCase().includes(term) ||
        String(item.type).toLowerCase().includes(term) ||
        String(item.status).toLowerCase().includes(term) ||
        String(item.summary).toLowerCase().includes(term)
      );

  if (!filtered.length) {
    tbody.innerHTML = `<tr><td colspan="7"><div class="empty-state">No matching history entries.</div></td></tr>`;
    return;
  }

  tbody.innerHTML = filtered.map(item => {
    const mode = /permit|safe|on_route/i.test(item.status)
      ? 'ok'
      : /restricted|not|off_route|error/i.test(item.status)
        ? 'bad'
        : 'warn';
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

Object.assign(window, { filterHistory, toggleDrawer, renderDrawer });

/* ---- Kick off counters on hero KPIs at load ---- */
window.addEventListener('load', () => animateAllCounters(document));
