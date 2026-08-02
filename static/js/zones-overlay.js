/**
 * zones-overlay.js — deck.gl GeoJSON layer rendered over the Leaflet map.
 * Draws MARPOL special-area polygons with animated stroke + fill.
 * Requires deck.gl loaded via CDN (see index.html script tag).
 *
 * Usage:
 *   import { ZonesOverlay } from './zones-overlay.js';
 *   const overlay = new ZonesOverlay('leaflet-map-container-id');
 *   overlay.load('/api/v1/zones/geojson');
 *   overlay.highlight('zone_id_string');
 */

const { DeckGL, GeoJsonLayer, ScatterplotLayer } = deck;

export class ZonesOverlay {
  constructor(mapContainerId) {
    this._containerId  = mapContainerId;
    this._geojson      = null;
    this._highlighted  = null;
    this._shipPoint    = null;
    this._deckInstance = null;
    this._viewState    = { longitude: 0, latitude: 20, zoom: 2, pitch: 0, bearing: 0 };
  }

  // ── Load GeoJSON from API ─────────────────────────────────────────────────
  async load(endpoint) {
    try {
      const res  = await fetch(endpoint);
      this._geojson = await res.json();
      this._render();
    } catch (err) {
      console.warn('[ZonesOverlay] Failed to load GeoJSON:', err.message);
    }
  }

  // ── Highlight a specific zone (e.g. after a compliance check) ─────────────
  highlight(zoneId) {
    this._highlighted = zoneId;
    this._render();
  }

  // ── Update ship position scatter point ────────────────────────────────────
  setShipPosition(lat, lon, status = 'SAFE') {
    this._shipPoint = { lat, lon, status };
    this._render();
  }

  // ── Core render ───────────────────────────────────────────────────────────
  _render() {
    if (!this._geojson) return;

    const container = document.getElementById(this._containerId);
    if (!container) return;

    const layers = [
      new GeoJsonLayer({
        id:            'marpol-zones',
        data:          this._geojson,
        pickable:      true,
        stroked:       true,
        filled:        true,
        extruded:      false,
        lineWidthMinPixels: 1.5,
        getFillColor: f => {
          const isHighlighted = f.properties?.zone_id === this._highlighted;
          const annex = (f.properties?.annex || '').toUpperCase();
          const alpha = isHighlighted ? 80 : 35;
          if (annex.includes('I'))   return [255, 107,  53, alpha]; // Annex I  — orange
          if (annex.includes('II'))  return [255, 200,   0, alpha]; // Annex II — yellow
          if (annex.includes('IV'))  return [  0, 200, 255, alpha]; // Annex IV — cyan
          if (annex.includes('V'))   return [150, 255, 100, alpha]; // Annex V  — green
          if (annex.includes('VI'))  return [200, 100, 255, alpha]; // Annex VI — purple
          return [100, 160, 255, alpha];
        },
        getLineColor: f => {
          const isHighlighted = f.properties?.zone_id === this._highlighted;
          return isHighlighted ? [0, 212, 255, 255] : [0, 180, 255, 140];
        },
        getLineWidth: f => f.properties?.zone_id === this._highlighted ? 3 : 1.5,
        onHover: ({ object, x, y }) => this._onHover(object, x, y),
        onClick: ({ object }) => this._onClick(object),
        updateTriggers: { getFillColor: this._highlighted, getLineColor: this._highlighted },
      }),
    ];

    // Ship position scatter layer
    if (this._shipPoint) {
      const { lat, lon, status } = this._shipPoint;
      const color = status === 'SAFE' ? [0, 230, 118, 255] : [255, 107, 53, 255];
      layers.push(
        new ScatterplotLayer({
          id:            'ship-position',
          data:          [{ position: [lon, lat] }],
          getPosition:   d => d.position,
          getRadius:     18000,
          getFillColor:  color,
          getLineColor:  [255, 255, 255, 200],
          lineWidthMinPixels: 2,
          stroked:       true,
          radiusMinPixels: 7,
          radiusMaxPixels: 18,
        }),
      );
    }

    // Create or update the DeckGL overlay
    if (!this._deckInstance) {
      this._deckInstance = new DeckGL({
        container,
        initialViewState: this._viewState,
        controller:       false,   // Leaflet handles pan/zoom
        layers,
        style: {
          position: 'absolute',
          top: 0, left: 0,
          pointerEvents: 'none',
          zIndex: 500,
        },
        getTooltip: ({ object }) =>
          object && object.properties
            ? {
                html: `
                  <div style="
                    background:#0b1929;border:1px solid #1a3a5c;
                    border-radius:8px;padding:10px 14px;
                    font-size:12px;color:#e0f0ff;line-height:1.6;
                  ">
                    <strong style="color:#00d4ff">${object.properties.name || 'Zone'}</strong><br>
                    Annex: ${object.properties.annex || '—'}<br>
                    Type: ${object.properties.type || '—'}<br>
                    Restriction: ${object.properties.restriction || '—'}
                  </div>`,
                style: { background: 'none', border: 'none', padding: '0' },
              }
            : null,
      });
    } else {
      this._deckInstance.setProps({ layers });
    }
  }

  _onHover(feature, x, y) {
    // Override in consuming code if needed
  }

  _onClick(feature) {
    if (feature?.properties?.zone_id) {
      this.highlight(feature.properties.zone_id);
    }
  }

  destroy() {
    if (this._deckInstance) {
      this._deckInstance.finalize();
      this._deckInstance = null;
    }
  }
}
