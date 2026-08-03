/**
 * dashboard.js — Volteo Maritime MARPOL Compliance Dashboard v5.0
 * Classic script (no ES modules). Depends on: window.L (Leaflet),
 * window.GlobeController (globe.js), window.ZonesOverlay (zones-overlay.js).
 *
 * BootManager guarantees the loader is ALWAYS removed — no single subsystem
 * can block the dashboard from becoming interactive.
 */
(function (global) {
  'use strict';

  /* ═══════════════════ CONFIG ═══════════════════ */

  var RAILWAY_API    = 'https://volteo-maritime-marpol-zone-api.up.railway.app';
  var DEMO_API_KEY   = 'volteo-demo-key-2026';
  var HEALTH_POLL_MS = 15000;
  var HISTORY_LIMIT  = 30;
  var HISTORY_KEY    = 'marpol_history_v4';
  var TILE_URL       = 'https://{s}.basemaps.cartocdn.com/dark_matter/{z}/{x}/{y}{r}.png';
  var TILE_OPTIONS   = { maxZoom: 19, subdomains: 'abcd', attribution: '&copy; OpenStreetMap &copy; CARTO' };
  var INITIAL_VIEW   = { center: [20, 0], zoom: 2 };
  var COLORS         = { safe: '#00e676', warn: '#ff6b35', primary: '#00d4ff' };

  function apiBase() {
    var origin  = window.location.origin;
    var isLocal = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
    return (isLocal || origin === RAILWAY_API) ? origin : RAILWAY_API;
  }

  var ENDPOINTS = {
    health:       '/health',
    authToken:    '/auth/token',
    checkZone:    '/api/v1/check-zone',
    checkSlop:    '/api/v1/check-slop',
    checkRoute:   '/api/v1/check-route',
    zonesGeoJson: '/api/v1/zones/geojson',
  };

  /* ═══════════════════ DOM HELPERS ═══════════════════ */

  function $(id) { return document.getElementById(id); }
  function escHtml(v) {
    var n = document.createElement('div');
    n.textContent = String(v == null ? '' : v);
    return n.innerHTML;
  }
  function fmt(v, d) {
    d = (d == null) ? 2 : d;
    return (v == null || isNaN(+v)) ? '—' : (+v).toFixed(d);
  }
  function safeArr(v) { return Array.isArray(v) ? v : []; }
  function numFrom(id) {
    var el = $(id);
    if (!el) return null;
    var p = parseFloat(el.value);
    return isNaN(p) ? null : p;
  }
  function textFrom(id, fb) {
    var el = $(id);
    var v = el && el.value && el.value.trim();
    return v || (fb || '');
  }
  function boolFrom(id) {
    var el = $(id);
    return !!(el && el.checked);
  }

  /* ═══════════════════ TOASTS ═══════════════════ */

  function toast(message, type) {
    type = type || 'info';
    var stack = $('toastStack');
    if (!stack) return;
    var el = document.createElement('div');
    el.className = 'toast toast-' + type;
    el.innerHTML = '<span>' + escHtml(message) + '</span>';
    stack.appendChild(el);
    requestAnimationFrame(function () { el.classList.add('show'); });
    setTimeout(function () {
      el.classList.remove('show');
      setTimeout(function () { if (el.parentNode) el.parentNode.removeChild(el); }, 300);
    }, 4200);
  }

  /* ═══════════════════ AUTH ═══════════════════ */

  var _authToken  = null;
  var _authExpiry = 0;
  var _authInflight = null;

  function fetchToken() {
    var url = apiBase() + ENDPOINTS.authToken + '?api_key=' + DEMO_API_KEY;
    return fetch(url, { method: 'POST' })
      .then(function (res) {
        if (!res.ok) throw new Error('Auth failed: HTTP ' + res.status);
        return res.json();
      })
      .then(function (data) {
        _authToken  = data.access_token;
        _authExpiry = Date.now() + ((data.expires_in || 900) - 30) * 1000;
        return _authToken;
      });
  }

  function getToken() {
    if (_authToken && Date.now() < _authExpiry) return Promise.resolve(_authToken);
    if (!_authInflight) {
      _authInflight = fetchToken().finally(function () { _authInflight = null; });
    }
    return _authInflight;
  }

  function invalidateToken() { _authToken = null; _authExpiry = 0; }

  /* ═══════════════════ API LAYER ═══════════════════ */

  var latencySamples = [];

  function recordLatency(ms) {
    latencySamples.push(ms);
    if (latencySamples.length > 10) latencySamples.shift();
    var avg = latencySamples.reduce(function (a, b) { return a + b; }, 0) / latencySamples.length;
    var el = $('kpiLatency');
    if (el) el.textContent = Math.round(avg) + ' ms';
  }

  function request(path, opts, _retry) {
    opts = opts || {};
    return getToken().then(function (token) {
      var url     = apiBase() + path;
      var headers = Object.assign({ 'Authorization': 'Bearer ' + token }, opts.headers || {});
      var t0      = performance.now();
      return fetch(url, Object.assign({}, opts, { headers: headers }))
        .then(function (res) {
          recordLatency(performance.now() - t0);
          if (res.status === 401 && !_retry) {
            invalidateToken();
            return request(path, opts, true);
          }
          var ct = res.headers.get('content-type') || '';
          var bodyP = ct.indexOf('json') !== -1 ? res.json().catch(function () { return null; }) : Promise.resolve(null);
          return bodyP.then(function (body) {
            if (res.ok) return body;
            var msg = (body && body.detail) ? body.detail : ('HTTP ' + res.status);
            throw new Error(typeof msg === 'string' ? msg : JSON.stringify(msg));
          });
        })
        .catch(function (err) {
          if (err && err.message && err.message.indexOf('HTTP') !== 0) {
            throw new Error('Network error: ' + err.message);
          }
          throw err;
        });
    });
  }

  function postJson(path, payload) {
    return request(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
  }

  /* ═══════════════════ HEALTH ═══════════════════ */

  function pollHealth() {
    var dot   = $('healthDot');
    var label = $('healthLabel');
    if (!dot || !label) return;
    request(ENDPOINTS.health)
      .then(function (data) {
        var ok = data && (data.status === 'ok' || data.status === 'healthy');
        dot.style.background = ok ? COLORS.safe : COLORS.warn;
        dot.style.boxShadow  = ok ? ('0 0 8px ' + COLORS.safe) : ('0 0 8px ' + COLORS.warn);
        label.textContent    = ok ? 'API Online' : 'API Degraded';
        label.style.color    = ok ? COLORS.safe : COLORS.warn;
      })
      .catch(function () {
        dot.style.background = COLORS.warn;
        dot.style.boxShadow  = '0 0 8px ' + COLORS.warn;
        label.textContent    = 'API Offline';
        label.style.color    = COLORS.warn;
      });
  }

  /* ═══════════════════ KPIs ═══════════════════ */

  function updateKpis() {
    var list      = historyLoad();
    var total     = list.length;
    var safeCount = list.filter(function (h) { return h.status === 'SAFE'; }).length;
    if ($('kpiChecks'))     $('kpiChecks').textContent     = String(total);
    if ($('kpiCompliance')) $('kpiCompliance').textContent = total ? (Math.round((safeCount / total) * 100) + '%') : '—';
  }

  /* ═══════════════════ VIEW RENDERERS ═══════════════════ */

  function statusBadge(status) {
    var safe = (status === 'SAFE');
    return '<span class="verdict-banner ' + (safe ? 'verdict-safe' : 'verdict-warn') + '">' +
      (safe ? '✓ SAFE TO DISCHARGE' : '✗ RESTRICTED') + '</span>';
  }

  function ruleRow(rule) {
    var pass = rule.passed;
    return '<div class="result-row ' + (pass ? '' : 'verdict-warn') + '" style="border-left:3px solid ' + (pass ? COLORS.safe : COLORS.warn) + ';padding-left:0.75rem;margin-bottom:0.5rem;border-radius:4px;">' +
      '<div class="result-label">' + escHtml(rule.rule_name) + '</div>' +
      '<div class="result-value">' + (pass ? '✓ Pass' : '✗ Fail') + ' — Got: <strong>' + escHtml(rule.actual_value) + '</strong> / Req: <strong>' + escHtml(rule.required_value) + '</strong></div>' +
      (rule.note ? '<div style="font-size:0.75rem;color:var(--text-dim);margin-top:0.2rem;">' + escHtml(rule.note) + '</div>' : '') +
      '</div>';
  }

  function zonesTable(zones) {
    if (!zones.length) return '<p class="empty-state" style="padding:1rem 0;">No active MARPOL zones at this position.</p>';
    return '<table class="data-table" style="width:100%;border-collapse:collapse;font-size:0.82rem;margin-top:0.5rem;">' +
      '<thead><tr style="border-bottom:1px solid var(--border);color:var(--text-dim);">' +
      '<th style="text-align:left;padding:0.4rem 0.5rem;">Zone</th>' +
      '<th style="text-align:left;padding:0.4rem 0.5rem;">Annex</th>' +
      '<th style="text-align:left;padding:0.4rem 0.5rem;">Waste Type</th>' +
      '<th style="text-align:left;padding:0.4rem 0.5rem;">Restriction</th>' +
      '</tr></thead><tbody>' +
      zones.map(function (z) {
        return '<tr style="border-bottom:1px solid var(--border-soft);">' +
          '<td style="padding:0.4rem 0.5rem;">' + escHtml(z.zone_name) + '</td>' +
          '<td style="padding:0.4rem 0.5rem;">' + escHtml(z.annex) + '</td>' +
          '<td style="padding:0.4rem 0.5rem;">' + escHtml(z.waste_type) + '</td>' +
          '<td style="padding:0.4rem 0.5rem;">' + escHtml(z.restriction) + '</td>' +
          '</tr>';
      }).join('') +
      '</tbody></table>';
  }

  function disposalList(items) {
    if (!items || !items.length) return '';
    return items.map(function (item) {
      return '<div style="display:flex;gap:0.6rem;align-items:flex-start;padding:0.5rem 0;border-bottom:1px solid var(--border-soft);">' +
        '<span style="color:' + (item.allowed ? COLORS.safe : COLORS.warn) + ';font-size:1.1rem;">' + (item.allowed ? '✓' : '✗') + '</span>' +
        '<div><strong style="font-size:0.85rem;">' + escHtml(item.label) + '</strong>' +
        '<p style="font-size:0.78rem;color:var(--text-dim);margin-top:0.2rem;">' + escHtml(item.reason) + '</p></div></div>';
    }).join('');
  }

  function skeleton() {
    return '<div class="skeleton" style="height:1.2rem;margin-bottom:0.75rem;"></div>' +
      '<div class="skeleton" style="height:1.2rem;width:70%;margin-bottom:0.75rem;"></div>' +
      '<div class="skeleton" style="height:1.2rem;margin-bottom:0.75rem;"></div>';
  }

  /* ═══════════════════ MAP STATE ═══════════════════ */

  var sharedMap    = null;
  var deckOverlay  = null;
  var layerGroups  = { zone: null, slop: null, route: null };
  var markers      = { zone: null, slop: null, route: null };
  var routePolyline = null;
  var activePanel  = 'zone';

  function shipIcon(status) {
    var color = (status === 'SAFE') ? COLORS.safe : COLORS.warn;
    return L.divIcon({
      className: '',
      html: '<div style="width:20px;height:20px;border-radius:50%;background:' + color + ';border:3px solid white;box-shadow:0 0 12px ' + color + ';"></div>',
      iconSize:   [20, 20],
      iconAnchor: [10, 10],
    });
  }

  function initMaps() {
    if (typeof L === 'undefined') {
      console.warn('[Dashboard] Leaflet not available — map disabled.');
      return;
    }
    var mapEl = $('leafletMap');
    if (!mapEl) {
      console.warn('[Dashboard] #leafletMap element not found — map disabled.');
      return;
    }
    sharedMap = L.map('leafletMap', { zoomControl: true, attributionControl: true })
      .setView(INITIAL_VIEW.center, INITIAL_VIEW.zoom);
    L.tileLayer(TILE_URL, TILE_OPTIONS).addTo(sharedMap);

    layerGroups.zone  = L.layerGroup().addTo(sharedMap);
    layerGroups.slop  = L.layerGroup();
    layerGroups.route = L.layerGroup();

    sharedMap.on('click', function (e) {
      var lat = e.latlng.lat.toFixed(4), lon = e.latlng.lng.toFixed(4);
      if (activePanel === 'zone'  && $('lat'))     { $('lat').value = lat;     $('lon').value = lon; }
      if (activePanel === 'slop'  && $('slopLat')) { $('slopLat').value = lat; $('slopLon').value = lon; }
      if (activePanel === 'route' && $('routeLat')){ $('routeLat').value = lat; $('routeLon').value = lon; }
    });

    if (typeof ZonesOverlay !== 'undefined') {
      try {
        deckOverlay = new ZonesOverlay(sharedMap);
        deckOverlay.onLoad = function (zoneCount) {
          var zonesKpi = $('kpiZones');
          if (zonesKpi) zonesKpi.textContent = String(zoneCount);
        };
      } catch (err) {
        console.warn('[Dashboard] ZonesOverlay init failed:', err);
      }
    }
  }

  function loadZonesOverlay() {
    if (deckOverlay) {
      try {
        deckOverlay.load(apiBase() + ENDPOINTS.zonesGeoJson);
      } catch (err) {
        console.warn('[Dashboard] loadZonesOverlay failed:', err);
      }
    }
  }

  function switchPanel(panelKey) {
    if (!sharedMap) return;
    Object.keys(layerGroups).forEach(function (key) {
      var group = layerGroups[key];
      if (!group) return;
      if (key === panelKey) sharedMap.addLayer(group);
      else sharedMap.removeLayer(group);
    });
    activePanel = panelKey;
    setTimeout(function () { if (sharedMap) sharedMap.invalidateSize(); }, 60);
  }

  function placeMarker(group, lat, lon, status, prevKey) {
    if (!sharedMap || !group) return null;
    if (markers[prevKey]) {
      try { group.removeLayer(markers[prevKey]); } catch (e) {}
    }
    var marker = L.marker([lat, lon], { icon: shipIcon(status) }).addTo(group)
      .bindPopup('<strong>' + (status === 'SAFE' ? '✓ SAFE' : '✗ RESTRICTED') + '</strong><br>' +
        fmt(lat, 4) + '°, ' + fmt(lon, 4) + '°');
    markers[prevKey] = marker;
    sharedMap.setView([lat, lon], Math.max(sharedMap.getZoom(), 5), { animate: true });
    return marker;
  }

  /* ═══════════════════ HISTORY ═══════════════════ */

  function historyLoad() {
    try { return JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]'); } catch (e) { return []; }
  }

  function historyAdd(entry) {
    var list = [Object.assign({}, entry, {
      time: new Date().toLocaleTimeString(),
      timestamp: Date.now(),
    })].concat(historyLoad()).slice(0, HISTORY_LIMIT);
    try { localStorage.setItem(HISTORY_KEY, JSON.stringify(list)); } catch (e) {}
    renderHistory();
    updateKpis();
  }

  function renderHistory() {
    var el = $('historyList');
    if (!el) return;
    var list = historyLoad();
    if (!list.length) {
      el.innerHTML = '<div class="empty-state"><div class="empty-icon">📋</div>' +
        '<p>No checks yet. Run a zone, slop, or route check above.</p></div>';
      return;
    }
    el.innerHTML = list.map(function (h, i) {
      var safe = h.status === 'SAFE';
      return '<div class="history-item" data-idx="' + i + '" style="cursor:pointer;display:flex;flex-direction:column;gap:0.25rem;">' +
        '<div style="display:flex;justify-content:space-between;align-items:center;">' +
        '<span style="font-size:0.8rem;font-weight:600;color:var(--text);">' + escHtml(h.type) + '</span>' +
        '<span style="font-size:0.7rem;color:var(--text-dim);">' + escHtml(h.time) + '</span></div>' +
        '<span style="font-size:0.72rem;padding:2px 8px;border-radius:12px;align-self:flex-start;font-weight:600;' +
        'background:' + (safe ? 'rgba(0,230,118,0.12)' : 'rgba(255,107,53,0.12)') + ';' +
        'color:' + (safe ? COLORS.safe : COLORS.warn) + ';border:1px solid ' + (safe ? COLORS.safe : COLORS.warn) + ';">' +
        (safe ? '✓ SAFE' : '✗ RESTRICTED') + '</span>' +
        '<span style="font-size:0.75rem;color:var(--text-dim);font-family:var(--font-mono);">' +
        fmt(h.lat, 4) + '°, ' + fmt(h.lon, 4) + '°</span>' +
        '<span style="font-size:0.78rem;color:var(--text-dim);">' + escHtml(h.summary || '') + '</span>' +
        '</div>';
    }).join('');

    var items = el.querySelectorAll('.history-item');
    items.forEach(function (item) {
      item.addEventListener('click', function () {
        var h = list[+item.dataset.idx];
        if (h && sharedMap) sharedMap.setView([h.lat, h.lon], 6, { animate: true });
      });
    });
  }

  /* ═══════════════════ ZONE PANEL ═══════════════════ */

  var zoneState = { loading: false, data: null, error: null };

  function renderZone() {
    var out = $('zoneResult');
    if (!out) return;
    if (zoneState.loading) { out.innerHTML = skeleton(); return; }
    if (zoneState.error)   { out.innerHTML = '<div class="verdict-banner verdict-warn">⚠ ' + escHtml(zoneState.error) + '</div>'; return; }
    if (!zoneState.data)   { out.innerHTML = '<p class="empty-state">Enter a position and run a check.</p>'; return; }
    var d = zoneState.data;
    out.innerHTML =
      statusBadge(d.zone_status) +
      '<p style="margin:0.75rem 0;font-size:0.88rem;color:var(--text);">' + escHtml(d.summary) + '</p>' +
      '<div class="result-row"><span class="result-label">Distance to nearest land</span>' +
      '<span class="result-value mono">' + fmt(d.distance_to_nearest_land_nm) + ' NM</span></div>' +
      '<div style="margin-top:1rem;"><div class="result-label" style="margin-bottom:0.5rem;">RULES CHECKLIST</div>' +
      (safeArr(d.rules_checklist).map(ruleRow).join('') || '<p class="empty-state">No rules evaluated.</p>') + '</div>' +
      '<div style="margin-top:1rem;"><div class="result-label" style="margin-bottom:0.5rem;">ACTIVE ZONES</div>' +
      zonesTable(safeArr(d.active_zones)) + '</div>' +
      (safeArr(d.disposal_assessment).length ? '<div style="margin-top:1rem;"><div class="result-label" style="margin-bottom:0.5rem;">DISPOSAL ASSESSMENT</div>' + disposalList(safeArr(d.disposal_assessment)) + '</div>' : '');
  }

  function submitZone(globe) {
    var lat = numFrom('lat'), lon = numFrom('lon');
    if (lat == null || lon == null) { toast('Please enter valid latitude and longitude.', 'warn'); return; }

    zoneState.loading = true; zoneState.error = null; zoneState.data = null;
    renderZone();

    postJson(ENDPOINTS.checkZone, {
      ship_id:           textFrom('shipId', 'SHIP_001'),
      latitude:          lat,
      longitude:         lon,
      waste_type_filter: textFrom('wasteFilter') || null,
    })
    .then(function (data) {
      zoneState.loading = false; zoneState.data = data; zoneState.error = null;
      renderZone();
      if (globe) globe.setPin(lat, lon, data.zone_status);
      if (deckOverlay) try { deckOverlay.setShipPosition(lat, lon, data.zone_status); } catch (e) {}
      placeMarker(layerGroups.zone, lat, lon, data.zone_status, 'zone');
      historyAdd({ type: 'Zone Check', lat: lat, lon: lon, status: data.zone_status, summary: data.summary });
      toast('Zone check complete: ' + data.zone_status, data.zone_status === 'SAFE' ? 'success' : 'warn');
    })
    .catch(function (e) {
      zoneState.loading = false; zoneState.data = null; zoneState.error = e.message;
      renderZone();
      toast(e.message, 'error');
    });
  }

  /* ═══════════════════ SLOP PANEL ═══════════════════ */

  var slopState = { loading: false, data: null, error: null };

  function renderSlop() {
    var out = $('slopResult');
    if (!out) return;
    if (slopState.loading) { out.innerHTML = skeleton(); return; }
    if (slopState.error)   { out.innerHTML = '<div class="verdict-banner verdict-warn">⚠ ' + escHtml(slopState.error) + '</div>'; return; }
    if (!slopState.data)   { out.innerHTML = '<p class="empty-state">Enter discharge parameters and run a check.</p>'; return; }
    var d = slopState.data;
    out.innerHTML =
      statusBadge(d.zone_status) +
      '<p style="margin:0.75rem 0;font-size:0.88rem;color:var(--text);">' + escHtml(d.summary) + '</p>' +
      '<div class="result-row"><span class="result-label">Distance to nearest land</span>' +
      '<span class="result-value mono">' + fmt(d.distance_to_nearest_land_nm) + ' NM</span></div>' +
      '<div style="margin-top:1rem;"><div class="result-label" style="margin-bottom:0.5rem;">RULES CHECKLIST</div>' +
      (safeArr(d.rules_checklist).map(ruleRow).join('') || '<p class="empty-state">No rules evaluated.</p>') + '</div>' +
      '<div style="margin-top:1rem;"><div class="result-label" style="margin-bottom:0.5rem;">ACTIVE OIL / NLS ZONES</div>' +
      zonesTable(safeArr(d.active_zones)) + '</div>';
  }

  function submitSlop() {
    var lat = numFrom('slopLat'), lon = numFrom('slopLon');
    if (lat == null || lon == null) { toast('Please enter valid latitude and longitude.', 'warn'); return; }

    var cargo_is_nls = boolFrom('cargoIsNls');

    slopState.loading = true; slopState.error = null; slopState.data = null;
    renderSlop();

    postJson(ENDPOINTS.checkSlop, {
      ship_id:              textFrom('slopShipId', 'SHIP_001'),
      latitude:             lat,
      longitude:            lon,
      ship_speed_knots:     numFrom('shipSpeed')     || 0,
      oil_content_ppm:      numFrom('oilContent')    || 0,
      discharge_rate_lpnm:  numFrom('dischargeRate') || 0,
      tank_capacity_m3:     numFrom('tankCapacity')  || 0,
      odmcs_operational:    boolFrom('odmcsOp'),
      cargo_is_nls:         cargo_is_nls,
      nls_category:         cargo_is_nls ? (textFrom('nlsCategory') || null) : null,
    })
    .then(function (data) {
      slopState.loading = false; slopState.data = data; slopState.error = null;
      renderSlop();
      placeMarker(layerGroups.slop, lat, lon, data.zone_status, 'slop');
      historyAdd({ type: 'Slop Check', lat: lat, lon: lon, status: data.zone_status, summary: data.summary });
      toast('Slop check complete: ' + data.zone_status, data.zone_status === 'SAFE' ? 'success' : 'warn');
    })
    .catch(function (e) {
      slopState.loading = false; slopState.data = null; slopState.error = e.message;
      renderSlop();
      toast(e.message, 'error');
    });
  }

  /* ═══════════════════ ROUTE PANEL ═══════════════════ */

  var routeState = { loading: false, data: null, error: null };

  function renderRoute() {
    var out = $('routeResult');
    if (!out) return;
    if (routeState.loading) { out.innerHTML = skeleton(); return; }
    if (routeState.error)   { out.innerHTML = '<div class="verdict-banner verdict-warn">⚠ ' + escHtml(routeState.error) + '</div>'; return; }
    if (!routeState.data)   { out.innerHTML = '<p class="empty-state">Set position and route endpoints, then run a check.</p>'; return; }
    var d = routeState.data;
    var routeSafe = (d.route_status === 'ON_ROUTE');

    out.innerHTML =
      statusBadge(routeSafe ? 'SAFE' : 'RESTRICTED') +
      '<p style="margin:0.75rem 0;font-size:0.88rem;color:var(--text);">' + escHtml(d.summary) + '</p>' +
      '<div class="result-row"><span class="result-label">Route Status</span><span class="result-value">' + escHtml(d.route_status) + '</span></div>' +
      '<div class="result-row"><span class="result-label">Cross-track Distance</span><span class="result-value mono">' + fmt(d.cross_track_distance_nm) + ' NM</span></div>' +
      '<div class="result-row"><span class="result-label">Route Progress</span><span class="result-value mono">' + fmt(d.route_progress_percent, 1) + '%</span></div>' +
      '<div class="result-row"><span class="result-label">Route Length</span><span class="result-value mono">' + fmt(d.total_route_distance_nm) + ' NM</span></div>' +
      (safeArr(d.zones_crossed).length ?
        '<div style="margin-top:1rem;"><div class="result-label" style="margin-bottom:0.5rem;">ZONES CROSSED</div>' + zonesTable(safeArr(d.zones_crossed)) + '</div>' : '');

    if (sharedMap && safeArr(d.route_points).length >= 2) {
      if (routePolyline) { try { layerGroups.route.removeLayer(routePolyline); } catch(e) {} }
      routePolyline = L.polyline(d.route_points, { color: COLORS.primary, weight: 3, opacity: 0.85 }).addTo(layerGroups.route);
      sharedMap.fitBounds(routePolyline.getBounds(), { padding: [40, 40] });
    }

    var rLat = numFrom('routeLat'), rLon = numFrom('routeLon');
    if (rLat != null && rLon != null) {
      placeMarker(layerGroups.route, rLat, rLon, routeSafe ? 'SAFE' : 'RESTRICTED', 'route');
    }
  }

  function submitRoute() {
    routeState.loading = true; routeState.error = null; routeState.data = null;
    renderRoute();

    postJson(ENDPOINTS.checkRoute, {
      ship_id:               textFrom('routeShipId', 'SHIP_001'),
      latitude:              numFrom('routeLat')  || 0,
      longitude:             numFrom('routeLon')  || 0,
      origin_port:           textFrom('originPort') || null,
      destination_port:      textFrom('destPort')   || null,
      origin_latitude:       numFrom('originLat'),
      origin_longitude:      numFrom('originLon'),
      destination_latitude:  numFrom('destLat'),
      destination_longitude: numFrom('destLon'),
      corridor_width_nm:     numFrom('corridorWidth') || 25,
    })
    .then(function (data) {
      routeState.loading = false; routeState.data = data; routeState.error = null;
      renderRoute();
      historyAdd({
        type: 'Route Check',
        lat:  numFrom('routeLat') || 0,
        lon:  numFrom('routeLon') || 0,
        status:  data.route_status === 'ON_ROUTE' ? 'SAFE' : 'RESTRICTED',
        summary: data.summary,
      });
      toast('Route check complete: ' + data.route_status, data.route_status === 'ON_ROUTE' ? 'success' : 'warn');
    })
    .catch(function (e) {
      routeState.loading = false; routeState.data = null; routeState.error = e.message;
      renderRoute();
      toast(e.message, 'error');
    });
  }

  /* ═══════════════════ NLS TOGGLE ═══════════════════ */

  function bindNlsToggle() {
    var chk = $('cargoIsNls'), row = $('nlsCategoryRow');
    if (!chk || !row) return;
    var update = function () { row.style.display = chk.checked ? 'flex' : 'none'; };
    chk.addEventListener('change', update);
    update();
  }

  /* ═══════════════════ TABS ═══════════════════ */

  var panelMap = { mapPanel: null, zonePanel: 'zone', slopPanel: 'slop', routePanel: 'route', historyPanel: null };

  function initTabs() {
    var tabs = document.querySelectorAll('.tab-btn');
    tabs.forEach(function (btn) {
      btn.addEventListener('click', function () {
        tabs.forEach(function (b) { b.classList.remove('active'); });
        document.querySelectorAll('.tab-panel').forEach(function (p) { p.classList.remove('active'); });
        btn.classList.add('active');
        var panelId = btn.dataset.tab;
        var panel   = $(panelId);
        if (panel) panel.classList.add('active');
        var mapKey  = panelMap[panelId];
        if (mapKey) switchPanel(mapKey);
        if (sharedMap) setTimeout(function () { sharedMap.invalidateSize(); }, 100);
      });
    });
  }

  /* ═══════════════════ BOOT MANAGER ═══════════════════ */

  function hideLoader() {
    var loader = $('loader');
    if (loader) loader.classList.add('hidden');
  }

  function safeRun(name, fn) {
    try {
      fn();
    } catch (err) {
      console.error('[Boot] "' + name + '" failed — continuing in degraded mode.', err);
    }
  }

  function boot() {
    // Hard deadline: loader MUST disappear within 5 seconds regardless of anything.
    var forceHide = setTimeout(hideLoader, 5000);

    var globe = null;

    safeRun('globe', function () {
      if (typeof GlobeController !== 'undefined') {
        globe = new GlobeController('globe-canvas');
      }
    });

    safeRun('maps', function () { initMaps(); });

    safeRun('zonesOverlay', function () {
      setTimeout(loadZonesOverlay, 1500);
    });

    safeRun('health', function () {
      pollHealth();
      setInterval(pollHealth, HEALTH_POLL_MS);
    });

    safeRun('history', function () {
      renderHistory();
      updateKpis();
    });

    safeRun('nlsToggle', function () { bindNlsToggle(); });

    safeRun('tabs', function () { initTabs(); });

    safeRun('buttons', function () {
      var zs = $('zoneSubmit');
      if (zs) zs.addEventListener('click', function () { submitZone(globe); });

      var ss = $('slopSubmit');
      if (ss) ss.addEventListener('click', submitSlop);

      var rs = $('routeSubmit');
      if (rs) rs.addEventListener('click', submitRoute);

      var ch = $('clearHistory');
      if (ch) ch.addEventListener('click', function () {
        try { localStorage.removeItem(HISTORY_KEY); } catch(e) {}
        renderHistory();
        updateKpis();
        toast('History cleared', 'info');
      });
    });

    // All sync setup done — remove the loader.
    clearTimeout(forceHide);
    hideLoader();
  }

  /* ── Entry point ── */
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }

}(window));
