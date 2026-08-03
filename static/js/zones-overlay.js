/**
 * zones-overlay.js — native Leaflet GeoJSON layer for the live MARPOL map.
 * Classic script (no ES module syntax). Exposes ZonesOverlay globally.
 */
(function (global) {
  'use strict';

  if (typeof L === 'undefined') {
    console.warn('[ZonesOverlay] Leaflet not available — zone overlay disabled.');
    global.ZonesOverlay = function () {
      this.load = this.highlight = this.setAnnexFilter = this.setShipPosition = this.destroy = function () {};
    };
    return;
  }

  var ANNEX_COLORS = { I: '#ff6b35', II: '#ffc800', IV: '#00c8ff', V: '#96ff64', VI: '#c864ff' };

  function annexKeyOf(value) {
    var annex = String(value || '').toUpperCase();
    if (annex.indexOf('VI') !== -1) return 'VI';
    if (annex.indexOf('IV') !== -1) return 'IV';
    if (annex.indexOf('V') !== -1) return 'V';
    if (annex.indexOf('II') !== -1) return 'II';
    if (annex.indexOf('I') !== -1) return 'I';
    return null;
  }

  function escapeHtml(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function ZonesOverlay(map) {
    this._map = map;
    this._geojson = null;
    this._highlighted = null;
    this._shipPoint = null;
    this._layer = null;
    this._shipLayer = null;
    this.onLoad = null;
    this._activeAnnexes = new Set(['I', 'II', 'IV', 'V', 'VI']);
  }

  ZonesOverlay.prototype.load = function (endpoint) {
    var self = this;
    fetch(endpoint)
      .then(function (res) {
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.json();
      })
      .then(function (data) {
        if (!data || !Array.isArray(data.features)) throw new Error('Invalid GeoJSON response');
        self._geojson = data;
        self._render();
        if (typeof self.onLoad === 'function') self.onLoad(data.features.length);
      })
      .catch(function (err) { console.warn('[ZonesOverlay] Failed to load GeoJSON:', err.message); });
  };

  ZonesOverlay.prototype.highlight = function (zoneId) {
    this._highlighted = zoneId;
    this._render();
  };

  ZonesOverlay.prototype.setAnnexFilter = function (annexSet) {
    this._activeAnnexes = annexSet instanceof Set ? annexSet : new Set(annexSet || []);
    this._render();
  };

  ZonesOverlay.prototype.setShipPosition = function (lat, lon, status) {
    this._shipPoint = { lat: lat, lon: lon, status: status || 'SAFE' };
    this._render();
  };

  ZonesOverlay.prototype._render = function () {
    if (!this._geojson || !this._map) return;
    var self = this;
    if (this._layer) this._map.removeLayer(this._layer);
    if (this._shipLayer) this._map.removeLayer(this._shipLayer);

    this._layer = L.geoJSON(this._geojson, {
      style: function (feature) {
        var properties = feature.properties || {};
        var key = annexKeyOf(properties.annex);
        var visible = key && self._activeAnnexes.has(key);
        var highlighted = properties.zone_id === self._highlighted;
        return {
          color: highlighted ? '#00d4ff' : (ANNEX_COLORS[key] || '#64a0ff'),
          weight: highlighted ? 3 : 1.5,
          opacity: visible ? 0.9 : 0,
          fillOpacity: visible ? (highlighted ? 0.34 : 0.16) : 0,
        };
      },
      onEachFeature: function (feature, layer) {
        var p = feature.properties || {};
        layer.bindTooltip('<strong>' + escapeHtml(p.name || 'Zone') + '</strong><br>' +
          'Annex: ' + escapeHtml(p.annex || '—') + '<br>' +
          'Type: ' + escapeHtml(p.type || '—') + '<br>' + escapeHtml(p.restriction || '—'),
          { sticky: true, className: 'zone-tooltip' });
        layer.on('click', function () { self.highlight(p.zone_id); });
      },
    }).addTo(this._map);

    if (this._shipPoint) {
      var ship = this._shipPoint;
      this._shipLayer = L.circleMarker([ship.lat, ship.lon], {
        radius: 8, color: '#ffffff', weight: 2,
        fillColor: ship.status === 'SAFE' ? '#00e676' : '#ff6b35', fillOpacity: 1,
      }).addTo(this._map);
    }
  };

  ZonesOverlay.prototype.destroy = function () {
    if (this._layer) this._map.removeLayer(this._layer);
    if (this._shipLayer) this._map.removeLayer(this._shipLayer);
    this._layer = null;
    this._shipLayer = null;
  };

  global.ZonesOverlay = ZonesOverlay;
}(window));
