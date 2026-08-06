# Architecture — Volteo Maritime MARPOL Compliance API

A FastAPI service that evaluates a ship's position against MARPOL Annex I/II/IV/V/VI
special areas and emission control areas, plus a single-origin Leaflet frontend.

```
app/
  main.py            FastAPI app, CORS, StaticFiles mount, exception handlers, /health
  zones.py           MARPOL_ZONES registry (22 zones, shapely Polygons)
  spatial_index.py   STRtree-backed spatial index (built once at import)
  geo_utils.py       haversine / cross-track / geodesic sampling / coordinate validation
  zone_checker.py    domain layer: zone lookup, rules checklist, disposal assessment
  route_checker.py   corridor deviation check + geodesic track + zones crossed
  problem_details.py RFC 7807 helpers and FastAPI exception handlers
  models.py          Pydantic v2 request/response schemas
  routers/           HTTP layer
static/app.js        modular vanilla ES6 frontend
index.html           markup + CSS, loads /static/app.js
tests/               pytest suites (91 tests)
```

---

## 1. Spatial indexing (`app/spatial_index.py`)

### Before

Every position check ran a linear scan of the registry:

```python
[z for z in MARPOL_ZONES if point_in_polygon(lat, lon, z["polygon"])]
```

That is **O(n)** exact point-in-polygon tests per query, where each test is itself
O(v) in the vertex count of the polygon. With 22 zones this is tolerable; with a
full Appendix VII / IHO-resolution registry (hundreds of multi-thousand-vertex
polygons) it is not, and a route check makes it worse — a 64-segment geodesic
multiplies the cost by 65.

### After

At import time the module builds one immutable index over the registry:

```python
_POLYGONS = [zone["polygon"] for zone in MARPOL_ZONES]
INDEX_BACKEND, _query_candidates = _build_backend()
```

`_build_backend()` picks, in order:

1. **`shapely.STRtree`** (shapely 2.x — the pinned version, 2.1.2). Sort-Tile-Recursive
   packed R-tree over polygon envelopes; `tree.query(geom)` returns candidate *indices*.
2. **`rtree.Index`** — used only if the environment pins shapely 1.x, where `STRtree.query`
   returns geometry objects rather than indices and identity mapping back to zones is brittle.
3. **`linear-scan`** — always-correct fallback so the service never fails to boot.

`INDEX_BACKEND` is exposed (and surfaced on `/health`) so the active strategy is
observable in production rather than inferred.

### Why O(log n) matters here

An STRtree query descends a balanced tree of bounding boxes: the number of nodes
visited is **O(log n)** for the tree walk plus O(k) for the k candidates whose
envelopes actually intersect the query. Only those k candidates get the exact
(expensive) polygon predicate. For MARPOL geography k is almost always 0–3,
because special areas are geographically disjoint by construction.

The value shows up in the target workload: **high-frequency AIS/coordinate streaming**.
A fleet reporting positions at 1 Hz issues millions of point queries a day, and each
one used to touch every polygon in the registry. With the index, cost becomes roughly
constant in registry size — adding the two 2026 ECAs (and any future Appendix VII
zones) does not slow down existing traffic. Route checks benefit multiplicatively:
`query_zones_on_path` walks a sampled geodesic and unions results, so a 65-point
track went from 65 × n exact tests to 65 × (log n + k).

### Correctness contract

The index is a **drop-in accelerator**, not a behaviour change. Three invariants are
enforced and tested (`tests/test_spatial_index.py`):

- **Parity** — for every sample position, `query_zones_at_point` returns exactly what
  an exhaustive linear scan returns (`test_index_matches_linear_scan`).
- **Registry order** — hits are `sorted()` by registry index, so response ordering is
  stable and independent of tree layout.
- **Boundary inclusivity** — `contains(p) or touches(p)`. A ship sitting exactly on a
  zone edge or vertex is *inside*. This is deliberate: MARPOL limits are legal lines,
  and the conservative reading puts a vessel on the line under the stricter regime.

`_query_candidates` is exercised directly by `test_candidate_pruning_beats_full_scan`,
which asserts `0 < candidates < len(MARPOL_ZONES)` — i.e. the pruning that justifies
the index actually happens.

Public API compatibility is preserved: `geo_utils.point_in_polygon` still exists with
its original signature (its docstring now points callers at the index), and
`zone_checker.check_all_zones(lat, lon)` keeps its shape while delegating to the index.

---

## 2. RFC 7807 problem details (`app/problem_details.py`)

Every non-2xx response — domain rejection, validation failure, 404, or unhandled
crash — is a `application/problem+json` document with the five standard members:

```json
{
  "type": "https://volteo-maritime.example/problems/coordinates-on-land",
  "title": "Coordinates are on land",
  "status": 400,
  "detail": "Coordinates (28.6139, 77.209) are on land. Please provide valid sea coordinates.",
  "instance": "/api/v1/check-zone",
  "latitude": 28.6139,
  "longitude": 77.209
}
```

### Design

- **`ProblemException`** — the single domain-layer signal. `geo_utils.validate_coordinates`,
  `route_deviation_check`, and `route_checker._resolve_point` raise it; the HTTP layer
  never has to translate. `instance` is filled in by the handler from the live request
  path, so domain code stays transport-agnostic.
- **Stable `type` URIs** — one slug per failure mode (`coordinates-on-land`,
  `invalid-route-definition`, `port-not-found`, `invalid-coordinates`,
  `request-validation-error`, `internal-server-error`). Clients branch on `type`,
  never on prose in `detail`.
- **Extension members** carry the machine-actionable payload: `latitude`/`longitude`
  for on-land, `field`/`value` for port and route problems, and `errors:
  [{field, message, type}]` for validation — a flattened, stable projection of
  Pydantic's `RequestValidationError`, which is otherwise version-coupled.
- **Four handlers** registered in `main.py` before the routers: `ProblemException`,
  `StarletteHTTPException` (catches 404s and legacy `HTTPException` raises),
  `RequestValidationError` (422), and bare `Exception` (500).
- **No leakage from 500s.** The handler emits a generic `detail` plus
  `exception: "<ClassName>"` only. `test_unhandled_error_returns_problem_json_500`
  asserts the original exception message is absent from the body.
- **Documented in OpenAPI** — a shared `PROBLEM_RESPONSES` dict attaches the 400/422/500
  problem schema to every endpoint, so `/docs` shows the real error contract.

`tests/conftest.py::assert_problem` centralises the shape assertion (content type,
all five members present, `status` matching the HTTP status, non-empty `title`/`detail`,
`instance` path-shaped) and is used by every error test in the suite.

---

## 3. Frontend (`static/app.js`)

Vanilla ES6, no build step, no framework. `index.html` loads Leaflet then
`/static/app.js`. Organised as closure-scoped sections: **config → dom → api →
store → maps → views → panels → history → chrome → init**.

### State management

Three independent panels (zone, slop, route), each with a state object:

```js
state[panel] = { status: 'idle'|'loading'|'success'|'error', result, problem, request }
```

`setState(panel, patch)` is the **only** way to trigger a repaint. It merges the patch
and invokes that panel's renderer; nothing else touches the DOM of a result area.
`createPanelRenderer({spinnerId, resultsId, renderResult})` turns the status field
into UI: spinner visibility, `.banner-good` / `.banner-bad`, `.stat-value` KPI cards,
`.tag.annex` chips, and `.list-item` rule checklists are all derived, never
incrementally mutated. The result is a one-way data flow — a rendering bug can only
be a bug in one pure `render(state) → html` function.

Leaflet instances are the one piece of retained mutable state, isolated in a `maps`
module. Maps are created lazily (a hidden tab has zero size and Leaflet mis-measures
it) and `invalidateSize()` is called on tab activation.

### API and error handling

`API_BASE` resolves to `window.location.origin` when served over http(s), falling back
to `http://localhost:8000` for `file://` use; the `#apiBase` input overrides it.
`request()` normalises three failure modes into one `ApiProblem` shape: an RFC 7807
document, a legacy `{"detail": ...}` body, and a network/CORS failure. `renderProblem()`
puts `problem.detail` into the `.banner-bad` and surfaces `type`/`status` as metadata,
so a new backend problem type renders sensibly without a frontend change.

### Map rendering

After a successful check the frontend plots the ship marker, a 12 NM (22,224 m)
territorial-sea circle, origin/destination port markers, the route polyline built from
the API's `route_points` (a server-sampled geodesic — straight-leg fallback if absent),
and the polygons of the returned active zones, fetched from
`GET /api/v1/zones/geojson?zone_id=…`. Geometry is deliberately kept out of the
compliance responses: those are the high-frequency payloads and must stay small; the
GeoJSON endpoint is a separate, cacheable, filtered call.

### Single origin (`app/main.py`)

`app.mount("/static", StaticFiles(...))` and `GET /` → `FileResponse(index.html)`
(falling back to a `/docs` redirect if the file is absent). One origin means no CORS
preflight in production; the CORS middleware is retained for developers running the
page from a different port.

---

## 4. 2026 ECA data provenance

Two zones were added to `app/zones.py`, both designated by **IMO Resolution
MEPC.392(82)** (MEPC 82, adopted 2024), amending MARPOL Annex VI Appendix VII:

| Zone | `zone_id` | Effective | Enforced |
|---|---|---|---|
| Canadian Arctic ECA | `ANNEX6_CANADIAN_ARCTIC_ECA` | 2026-03-01 | 2027-03-01 |
| Norwegian Sea ECA | `ANNEX6_NORWEGIAN_SEA_ECA` | 2026-03-01 | 2027-03-01 |

**SOx.** Fuel oil sulphur content ≤ **0.10 % m/m**. Both entries carry
`effective_date` 2026-03-01 and `enforcement_date` 2027-03-01: MARPOL Annex VI
Reg. 14.7 grants a 12-month grace period after entry into force, so the limit is
enforceable from **1 March 2027**.

**NOx Tier III**, marine diesel engines **> 130 kW**:

- *Canadian Arctic* — applies to ships with **keel laid on or after 1 January 2025**.
- *Norwegian Sea* — the **three-date principle**: construction contract on/after
  **1 March 2026**, or (absent a contract) keel laid on/after **1 September 2026**,
  or delivery on/after **1 March 2030**.

These strings live in each zone's `restriction` and `guidance` fields and are asserted
verbatim by `tests/test_check_zone_api.py`, so a careless edit to the regulatory text
fails the suite.

**Geometry is simplified.** Both polygons are hand-simplified envelopes of the
Appendix VII coordinate lists — adequate for advisory zone screening, *not* for
navigation or enforcement. The Canadian Arctic polygon respects the **137°W** western
limit in the Beaufort Sea (tested at 71.5°N: −133° inside, −145° outside); the
Norwegian Sea polygon starts at **62°N** (tested: 65°N/5°E inside, 61.5°N/4°E outside
and in the pre-existing North Sea SOx ECA only). Each zone dict records `source`
pointing at MEPC.392(82) Appendix VII, and the code comment above the two entries
carries the full citation list.

### Sources

- IMO Resolution MEPC.392(82) — <https://wwwcdn.imo.org/localresources/en/KnowledgeCentre/IndexofIMOResolutions/MEPCDocuments/MEPC.392(82).pdf>
- DNV — new Emission Control Areas in the Norwegian Sea and Canadian Arctic — <https://www.dnv.com/news/new-emission-control-areas-in-the-norwegian-sea-and-canadian-arctic-waters/>
- Lloyd's Register Class News 05/2025 — <https://www.lr.org/en/knowledge/class-news/2025/05-2025/>
- ABS — MEPC 82 regulatory news — <https://ww2.eagle.org/en/rules-and-resources/regulatory-news.html>

---

## 5. Trade-offs

- **Simplified ECA polygons** — the true Appendix VII boundaries follow geodesic arcs
  between dozens of coordinates. The simplified envelopes are conservative-ish but can
  disagree near the edges. Advisory use only.
- **Index built at import, never invalidated** — the registry is a static Python module,
  so this is safe and gives zero query-time build cost. A database-backed registry would
  need a rebuild hook.
- **Boundary-inclusive containment** — a ship exactly on a line is reported inside the
  zone. Stricter than a pure `contains()`, and deliberately so.
- **Geometry excluded from compliance responses** — costs the frontend one extra
  `/zones/geojson` call, keeps the streaming payloads small.
- **`rtree` left uninstalled** — the shapely 2.x path is the one in use; the rtree branch
  exists for shapely-1.x environments and is unexercised by CI. `requirements.txt`
  documents it as an optional pin.
- **Frontend has no test harness** — validated by `node --check` plus a scripted
  cross-reference of every element ID and CSS class it touches against `index.html`.
  No headless browser was available in this environment.
