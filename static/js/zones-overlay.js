/**
 * zones-overlay.js — deck.gl GeoJSON layer rendered over the Leaflet map.
 * Draws MARPOL special-area polygons with annex-based coloring and an
 * interactive filter (via setAnnexFilter). Ship position rendered as a
 * pulsing scatter point.
 */

const { DeckGL, GeoJsonLayer, ScatterplotLayer } = deck;

const ANNEX_COLORS = {
  I:  [255, 107, 53],
  II: [255, 200, 0],
  IV: [0, 200, 255],
  V:  [150, 255, 100],
  VI: [200, 100, 255],
};

function annexKeyOf(annexRaw) {
  const a = (annexRaw || '').toUpperCase();
  if (a.includes('VI'))  return 'VI';
  if (a.includes('IV'))  return 'IV';
  if (a.includes('V'))   return 'V';
  if (a.includes('II'))  return 'II';
  if (a.includes('I'))   return 'I';
  return null;
}

export class ZonesOverlay {
  constructor(mapContainerId) {
    this._containerId   = mapContainerId;
    this._geojson       = null;
    this._highlighted   = null;
    this._shipPoint     = null;
    this._deckInstance  = null;
    this._activeAnnexes = new Set(['I', 'II', 'IV', 'V', 'VI']);
    this._viewState     = { longitude: 0, latitude: 20, zoom: 2, pitch: 0, bearing: 0 };
  }

  async load(endpoint) {
    try {
      const res = await fetch(endpoint);
      this._geojson = await res.json();
      this._render();
    } catch (err) {
      console.warn('[ZonesOverlay] Failed to load GeoJSON:', err.message);
    }
  }

  highlight(zoneId) {
    this._highlighted = zoneId;
    this._render();
  }

  setAnnexFilter(annexSet) {
    this._activeAnnexes = annexSet;
    this._render();
  }

  setShipPosition(lat, lon, status = 'SAFE') {
    this._shipPoint = { lat, lon, status };
    this._render();
  }

  _render() {
    if (!this._geojson) return;
    const container = document.getElementById(this._containerId);
    if (!container) return;

    const layers = [
      new GeoJsonLayer({
        id: 'marpol-zones',
        data: this._geojson,
        pickable: true,
        stroked: true,
        filled: true,
        extruded: false,
        lineWidthMinPixels: 1.5,
        getFillColor: f => {
          const key = annexKeyOf(f.properties?.annex);
          if (!key || !this._activeAnnexes.has(key)) return [0, 0, 0, 0];
          const isHighlighted = f.properties?.zone_id === this._highlighted;
          const [r, g, b] = ANNEX_COLORS[key] || [100, 160, 255];
          return [r, g, b, isHighlighted ? 90 : 40];
        },
        getLineColor: f => {
          const key = annexKeyOf(f.properties?.annex);
          if (!key || !this._activeAnnexes.has(key)) return [0, 0, 0, 0];
          const isHighlighted = f.properties?.zone_id === this._highlighted;
          return isHighlighted ? [0, 212, 255, 255] : [0, 180, 255, 150];
        },
        getLineWidth: f => f.properties?.zone_id === this._highlighted ? 3 : 1.5,
        onHover: ({ object, x, y }) => this._onHover(object, x, y),
        onClick: ({ object }) => this._onClick(object),
        updateTriggers: {
          getFillColor: [this._highlighted, [...this._activeAnnexes].join(',')],
          getLineColor: [this._highlighted, [...this._activeAnnexes].join(',')],
        },
      }),
    ];

    if (this._shipPoint) {
      const { lat, lon, status } = this._shipPoint;
      const color = status === 'SAFE' ? [0, 230, 118, 255] : [255, 107, 53, 255];
      layers.push(
        new ScatterplotLayer({
          id: 'ship-position',
          data: [{ position: [lon, lat] }],
          getPosition: d => d.position,
          getRadius: 18000,
          getFillColor: color,
          getLineColor: [255, 255, 255, 200],
          lineWidthMinPixels: 2,
          stroked: true,
          radiusMinPixels: 7,
          radiusMaxPixels: 18,
        }),
      );
    }

    if (!this._deckInstance) {
      this._deckInstance = new DeckGL({
        container,
        initialViewState: this._viewState,
        controller: false,
        layers,
        style: { position: 'absolute', top: 0, left: 0, pointerEvents: 'none', zIndex: 500 },
        getTooltip: ({ object }) =>
          object && object.properties
            ? {
                html: `
                  <div style="background:#0b1929;border:1px solid #1a3a5c;border-radius:8px;padding:10px 14px;font-size:12px;color:#e0f0ff;line-height:1.6;">
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

  _onHover(_feature, _x, _y) {}

  _onClick(feature) {
    if (feature?.properties?.zone_id) this.highlight(feature.properties.zone_id);
  }

  destroy() {
    if (this._deckInstance) {
      this._deckInstance.finalize();
      this._deckInstance = null;
    }
  }
}
