/**
 * zones-overlay.js — deck.gl GeoJSON layer rendered over the Leaflet map.
 * Classic script (no ES module syntax). Exposes ZonesOverlay globally.
 * Defensive: if deck.gl is missing, ZonesOverlay becomes a no-op stub.
 */
(function (global) {
  'use strict';

  var deckAvailable = (typeof deck !== 'undefined');

  if (!deckAvailable) {
    console.warn('[ZonesOverlay] deck.gl not available — zone overlay disabled.');
    global.ZonesOverlay = function () {
      this.load            = function () {};
      this.highlight       = function () {};
      this.setAnnexFilter  = function () {};
      this.setShipPosition = function () {};
      this.destroy         = function () {};
    };
    return;
  }

  var DeckGL         = deck.DeckGL;
  var GeoJsonLayer   = deck.GeoJsonLayer;
  var ScatterplotLayer = deck.ScatterplotLayer;

  var ANNEX_COLORS = {
    I:  [255, 107, 53],
    II: [255, 200, 0],
    IV: [0, 200, 255],
    V:  [150, 255, 100],
    VI: [200, 100, 255],
  };

  function annexKeyOf(annexRaw) {
    var a = (annexRaw || '').toUpperCase();
    if (a.indexOf('VI') !== -1) return 'VI';
    if (a.indexOf('IV') !== -1) return 'IV';
    if (a.indexOf('V')  !== -1) return 'V';
    if (a.indexOf('II') !== -1) return 'II';
    if (a.indexOf('I')  !== -1) return 'I';
    return null;
  }

  function ZonesOverlay(mapContainerId) {
    this._containerId   = mapContainerId;
    this._geojson       = null;
    this._highlighted   = null;
    this._shipPoint     = null;
    this._deckInstance  = null;
    this._activeAnnexes = new Set(['I', 'II', 'IV', 'V', 'VI']);
    this._viewState     = { longitude: 0, latitude: 20, zoom: 2, pitch: 0, bearing: 0 };
  }

  ZonesOverlay.prototype.load = function (endpoint) {
    var self = this;
    fetch(endpoint)
      .then(function (res) { return res.json(); })
      .then(function (data) { self._geojson = data; self._render(); })
      .catch(function (err) { console.warn('[ZonesOverlay] Failed to load GeoJSON:', err.message); });
  };

  ZonesOverlay.prototype.highlight = function (zoneId) {
    this._highlighted = zoneId;
    this._render();
  };

  ZonesOverlay.prototype.setAnnexFilter = function (annexSet) {
    this._activeAnnexes = annexSet;
    this._render();
  };

  ZonesOverlay.prototype.setShipPosition = function (lat, lon, status) {
    this._shipPoint = { lat: lat, lon: lon, status: status || 'SAFE' };
    this._render();
  };

  ZonesOverlay.prototype._render = function () {
    if (!this._geojson) return;
    var container = document.getElementById(this._containerId);
    if (!container) return;

    var self = this;
    var activeAnnexes = this._activeAnnexes;
    var highlighted   = this._highlighted;

    var layers = [
      new GeoJsonLayer({
        id: 'marpol-zones',
        data: this._geojson,
        pickable: true, stroked: true, filled: true, extruded: false,
        lineWidthMinPixels: 1.5,
        getFillColor: function (f) {
          var key = annexKeyOf(f.properties && f.properties.annex);
          if (!key || !activeAnnexes.has(key)) return [0, 0, 0, 0];
          var isHL = f.properties && f.properties.zone_id === highlighted;
          var rgb  = ANNEX_COLORS[key] || [100, 160, 255];
          return [rgb[0], rgb[1], rgb[2], isHL ? 90 : 40];
        },
        getLineColor: function (f) {
          var key = annexKeyOf(f.properties && f.properties.annex);
          if (!key || !activeAnnexes.has(key)) return [0, 0, 0, 0];
          var isHL = f.properties && f.properties.zone_id === highlighted;
          return isHL ? [0, 212, 255, 255] : [0, 180, 255, 150];
        },
        getLineWidth: function (f) {
          return (f.properties && f.properties.zone_id === highlighted) ? 3 : 1.5;
        },
        onHover: function (info) { self._onHover(info.object, info.x, info.y); },
        onClick: function (info) { self._onClick(info.object); },
        updateTriggers: {
          getFillColor: [highlighted, Array.from(activeAnnexes).join(',')],
          getLineColor: [highlighted, Array.from(activeAnnexes).join(',')],
        },
      }),
    ];

    if (this._shipPoint) {
      var sp    = this._shipPoint;
      var color = (sp.status === 'SAFE') ? [0, 230, 118, 255] : [255, 107, 53, 255];
      layers.push(
        new ScatterplotLayer({
          id: 'ship-position',
          data: [{ position: [sp.lon, sp.lat] }],
          getPosition:  function (d) { return d.position; },
          getRadius:    18000,
          getFillColor: color,
          getLineColor: [255, 255, 255, 200],
          lineWidthMinPixels: 2,
          stroked: true, radiusMinPixels: 7, radiusMaxPixels: 18,
        })
      );
    }

    if (!this._deckInstance) {
      this._deckInstance = new DeckGL({
        container: container,
        initialViewState: this._viewState,
        controller: false,
        layers: layers,
        style: { position: 'absolute', top: 0, left: 0, pointerEvents: 'none', zIndex: 500 },
        getTooltip: function (info) {
          var obj = info.object;
          if (!obj || !obj.properties) return null;
          return {
            html: '<div style="background:#0b1929;border:1px solid #1a3a5c;border-radius:8px;padding:10px 14px;font-size:12px;color:#e0f0ff;line-height:1.6;">' +
              '<strong style="color:#00d4ff">' + (obj.properties.name || 'Zone') + '</strong><br>' +
              'Annex: ' + (obj.properties.annex || '—') + '<br>' +
              'Type: '  + (obj.properties.type  || '—') + '<br>' +
              'Restriction: ' + (obj.properties.restriction || '—') +
              '</div>',
            style: { background: 'none', border: 'none', padding: '0' },
          };
        },
      });
    } else {
      this._deckInstance.setProps({ layers: layers });
    }
  };

  ZonesOverlay.prototype._onHover = function (_feature, _x, _y) {};

  ZonesOverlay.prototype._onClick = function (feature) {
    if (feature && feature.properties && feature.properties.zone_id) {
      this.highlight(feature.properties.zone_id);
    }
  };

  ZonesOverlay.prototype.destroy = function () {
    if (this._deckInstance) {
      this._deckInstance.finalize();
      this._deckInstance = null;
    }
  };

  global.ZonesOverlay = ZonesOverlay;

}(window));
