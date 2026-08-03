/**
 * zones-overlay.js
 * Leaflet-native GeoJSON overlay for MARPOL special areas and SOx ECAs.
 *
 * IMPORTANT: This implementation is deliberately Leaflet-native.
 * The original used deck.gl which was never loaded via CDN.
 * This version uses only L.geoJSON which is always available.
 *
 * Gracefully degrades: if GeoJSON fails to load, the map still works.
 */

'use strict';

const FETCH_TIMEOUT_MS = 12_000;

const ZONE_STYLES = {
  special_area: {
    color       : '#ff6b35',
    weight      : 2,
    opacity     : 0.9,
    fillColor   : '#ff6b35',
    fillOpacity : 0.15,
  },
  eca_sox: {
    color       : '#00d4aa',
    weight      : 2,
    opacity     : 0.9,
    fillColor   : '#00d4aa',
    fillOpacity : 0.12,
  },
  eca_nox: {
    color       : '#4ecdc4',
    weight      : 2,
    opacity     : 0.9,
    fillColor   : '#4ecdc4',
    fillOpacity : 0.12,
  },
  default: {
    color       : '#888888',
    weight      : 1.5,
    opacity     : 0.7,
    fillColor   : '#888888',
    fillOpacity : 0.10,
  },
};

export class ZonesOverlay {
  /**
   * @param {L.Map} map   - Leaflet map instance
   * @param {string} endpoint - GeoJSON endpoint URL
   */
  constructor(map, endpoint) {
    this._map      = map;
    this._endpoint = endpoint;
    this._layers   = {};   // { layerKey: L.GeoJSON }
    this._loaded   = false;
    this._loading  = false;
  }

  // ─── Public API ─────────────────────────────────────────────────────────────

  /**
   * Fetch GeoJSON and render all zone layers.
   * Safe to call multiple times — subsequent calls are no-ops if already loaded.
   */
  async load() {
    if (this._loaded || this._loading) return;
    this._loading = true;

    try {
      const data = await this._fetchWithTimeout(this._endpoint, FETCH_TIMEOUT_MS);
      this._buildLayers(data);
      this._loaded = true;
      console.info(`[ZonesOverlay] Loaded ${data.features?.length ?? 0} zone features.`);
    } catch (err) {
      console.error('[ZonesOverlay] Failed to load zones — map remains functional.', err);
    } finally {
      this._loading = false;
    }
  }

  /**
   * Show a specific zone category layer.
   * @param {string} key - e.g. 'special_area', 'eca_sox'
   */
  show(key) {
    const layer = this._layers[key];
    if (!layer || !this._map) return;
    if (!this._map.hasLayer(layer)) {
      this._map.addLayer(layer);
    }
  }

  /**
   * Hide a specific zone category layer.
   * @param {string} key
   */
  hide(key) {
    const layer = this._layers[key];
    if (!layer || !this._map) return;
    if (this._map.hasLayer(layer)) {
      this._map.removeLayer(layer);
    }
  }

  /**
   * Show all loaded layers.
   */
  showAll() {
    Object.keys(this._layers).forEach(k => this.show(k));
  }

  /**
   * Hide all loaded layers.
   */
  hideAll() {
    Object.keys(this._layers).forEach(k => this.hide(k));
  }

  /**
   * Toggle a layer by key.
   * @param {string} key
   * @returns {boolean} new visibility state
   */
  toggle(key) {
    const layer = this._layers[key];
    if (!layer || !this._map) return false;
    if (this._map.hasLayer(layer)) {
      this._map.removeLayer(layer);
      return false;
    } else {
      this._map.addLayer(layer);
      return true;
    }
  }

  /**
   * Remove all layers and free memory.
   */
  destroy() {
    Object.values(this._layers).forEach(layer => {
      if (this._map?.hasLayer(layer)) {
        this._map.removeLayer(layer);
      }
    });
    this._layers = {};
    this._loaded  = false;
    this._loading = false;
  }

  // ─── Private ────────────────────────────────────────────────────────────────

  async _fetchWithTimeout(url, timeoutMs) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, { signal: controller.signal });
      if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
      return await res.json();
    } finally {
      clearTimeout(timer);
    }
  }

  _buildLayers(geojson) {
    if (!geojson?.features?.length) {
      console.warn('[ZonesOverlay] GeoJSON has no features.');
      return;
    }

    // Group features by zone_type property
    const groups = {};
    for (const feature of geojson.features) {
      const key = feature.properties?.zone_type || 'default';
      if (!groups[key]) groups[key] = [];
      groups[key].push(feature);
    }

    for (const [key, features] of Object.entries(groups)) {
      const style   = ZONE_STYLES[key] ?? ZONE_STYLES.default;
      const fc      = { type: 'FeatureCollection', features };
      const layer   = L.geoJSON(fc, {
        style       : () => style,
        onEachFeature: this._bindPopup.bind(this),
      });
      this._layers[key] = layer;
      this._map.addLayer(layer);
    }
  }

  _bindPopup(feature, layer) {
    const p = feature.properties || {};
    const name     = p.name        || p.zone_name || 'MARPOL Zone';
    const type     = p.zone_type   || 'Special Area';
    const annex    = p.annex       || '—';
    const reg      = p.regulation  || '—';

    layer.bindTooltip(`
      <div style="font-size:12px;line-height:1.5">
        <strong>${name}</strong><br>
        Type: ${type}<br>
        Annex: ${annex} | Reg: ${reg}
      </div>
    `, { sticky: true, opacity: 0.92 });
  }
}
