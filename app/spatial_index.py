"""Spatial index over the MARPOL zone registry.

The registry is static for the lifetime of the process, so the index is built
exactly once at import time and reused by every request. Point-in-zone and
route-segment queries first ask the R-tree for candidate polygons whose bounding
boxes intersect the query geometry (O(log n)), then run the exact — and far more
expensive — geometric predicate on that short candidate list only. This replaces
the previous linear scan that ran a full point-in-polygon test against every zone
on every request.

shapely 2.x ships ``shapely.STRtree``; on shapely 1.x ``STRtree.query`` returns
geometries rather than indices and has no ``predicate`` argument, so the module
falls back to the standalone ``rtree`` package, and finally to a brute-force scan
if neither is available. All three paths expose the same API and return results
in registry order.
"""

from typing import Dict, List, Optional, Sequence

from shapely.geometry import LineString, Point, Polygon

from app.zones import MARPOL_ZONES

_POLYGONS: List[Polygon] = [zone["polygon"] for zone in MARPOL_ZONES]


def _build_backend():
    """Return (backend_name, query_callable). The callable maps a geometry to
    candidate indices into ``_POLYGONS``."""
    try:
        from shapely import STRtree  # shapely >= 2.0

        tree = STRtree(_POLYGONS)

        def query(geometry) -> Sequence[int]:
            return tree.query(geometry)

        return "shapely.STRtree", query
    except ImportError:
        pass

    try:
        from rtree import index as rtree_index  # shapely 1.x fallback

        idx = rtree_index.Index()
        for position, polygon in enumerate(_POLYGONS):
            idx.insert(position, polygon.bounds)

        def query(geometry) -> Sequence[int]:
            return list(idx.intersection(geometry.bounds))

        return "rtree.Index", query
    except ImportError:
        pass

    def query(geometry) -> Sequence[int]:
        return range(len(_POLYGONS))

    return "linear-scan", query


INDEX_BACKEND, _query_candidates = _build_backend()


def _matches(lat: float, lon: float, polygon: Polygon) -> bool:
    """Boundary-inclusive containment: a ship sitting exactly on a zone edge or
    vertex is treated as being inside the zone."""
    point = Point(lon, lat)
    return polygon.contains(point) or polygon.touches(point)


def query_zones_at_point(lat: float, lon: float) -> List[Dict]:
    """Registry entries whose polygon contains (or touches) the position."""
    point = Point(lon, lat)
    hits = sorted(_query_candidates(point))
    return [MARPOL_ZONES[i] for i in hits if _matches(lat, lon, _POLYGONS[i])]


def query_zones_on_segment(
    start_lat: float,
    start_lon: float,
    end_lat: float,
    end_lon: float,
) -> List[Dict]:
    """Registry entries whose polygon is crossed by the straight segment between
    two positions. Used for route screening: the segment is evaluated in
    plate-carrée (lon/lat) space, consistent with how the registry polygons are
    defined."""
    segment = LineString([(start_lon, start_lat), (end_lon, end_lat)])
    hits = sorted(_query_candidates(segment))
    return [MARPOL_ZONES[i] for i in hits if _POLYGONS[i].intersects(segment)]


def query_zones_on_path(points: Sequence[Sequence[float]]) -> List[Dict]:
    """Registry entries crossed by a multi-point (lat, lon) path. Returns each
    zone at most once, in registry order."""
    if len(points) < 2:
        if len(points) == 1:
            return query_zones_at_point(points[0][0], points[0][1])
        return []

    path = LineString([(lon, lat) for lat, lon in points])
    hits = sorted(_query_candidates(path))
    return [MARPOL_ZONES[i] for i in hits if _POLYGONS[i].intersects(path)]


def zone_by_id(zone_id: str) -> Optional[Dict]:
    for zone in MARPOL_ZONES:
        if zone["zone_id"] == zone_id:
            return zone
    return None


def index_stats() -> Dict:
    """Diagnostics for the /health endpoint."""
    return {"backend": INDEX_BACKEND, "indexed_zones": len(_POLYGONS)}
