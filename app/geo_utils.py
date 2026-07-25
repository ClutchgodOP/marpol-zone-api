"""Geospatial helpers for MARPOL zone/slop/route compliance checks.

Distance, bearing, and route math all use standard spherical-trig formulas
(haversine, initial bearing, cross-track/along-track projection) on a mean
Earth radius. Nearest-land distance uses the ``global_land_mask`` raster
(~1 arc-minute resolution) with an adaptive radial search: a coarse angular
sweep locates the first radius band containing land, then a binary search
along that bearing tightens the distance to within a fraction of a nautical
mile. Results are cached, since the same ship position is frequently
requested more than once in a single session (map sync, zone check, slop
check).
"""

import logging
from functools import lru_cache
from math import acos, asin, atan2, cos, degrees, pi, radians, sin, sqrt
from typing import List, Tuple

from shapely.geometry import Point

from app.problem_details import (
    TYPE_INVALID_COORDINATES,
    TYPE_INVALID_ROUTE,
    ProblemException,
)

logger = logging.getLogger(__name__)

# Mean Earth radius. Used consistently by every distance/bearing helper below
# so haversine_nm, cross_track_distance_nm, and along_track_distance_nm all
# agree with each other to the same precision.
EARTH_RADIUS_KM = 6371.0088
NM_PER_KM = 0.539956803
EARTH_RADIUS_NM = EARTH_RADIUS_KM * NM_PER_KM  # ~3440.065 NM

try:
    from global_land_mask import globe as _globe
    _USE_GLOBE = True
except ImportError:
    _globe = None
    _USE_GLOBE = False
    logger.warning(
        "global_land_mask is not installed; nearest_land_distance_nm() and "
        "is_on_land() are falling back to a 30-point reference-city lookup. "
        "This is far less accurate and should not be relied on in production "
        "install global-land-mask (already pinned in requirements.txt)."
    )


def point_in_polygon(lat: float, lon: float, polygon) -> bool:
    """Boundary-inclusive test against one polygon.

    Retained for backward compatibility and for callers that already hold a
    specific polygon. Multi-zone lookups must go through ``app.spatial_index``,
    which prunes candidates with an R-tree instead of testing every zone.
    """
    ship_point = Point(lon, lat)
    return polygon.contains(ship_point) or polygon.touches(ship_point)


def validate_coordinates(lat: float, lon: float, label: str = "position") -> None:
    """Raise an RFC 7807 problem if a coordinate pair is non-finite or out of range."""
    for value, name, limit in ((lat, "latitude", 90.0), (lon, "longitude", 180.0)):
        if value is None or value != value:  # NaN is the only value != itself
            raise ProblemException(
                status=422,
                title="Invalid coordinates",
                detail=f"The {label} {name} must be a finite number.",
                problem_type=TYPE_INVALID_COORDINATES,
                extensions={"field": name, "value": value},
            )
        if not -limit <= value <= limit:
            raise ProblemException(
                status=422,
                title="Invalid coordinates",
                detail=(
                    f"The {label} {name} must be between -{limit:g} and {limit:g} "
                    f"degrees; received {value}."
                ),
                problem_type=TYPE_INVALID_COORDINATES,
                extensions={"field": name, "value": value},
            )


def haversine_nm(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """Great-circle distance in nautical miles."""
    dlat = radians(lat2 - lat1)
    dlon = radians(lon2 - lon1)
    a = (
        sin(dlat / 2) ** 2
        + cos(radians(lat1)) * cos(radians(lat2)) * sin(dlon / 2) ** 2
    )
    return EARTH_RADIUS_KM * 2 * asin(sqrt(a)) * NM_PER_KM


def is_on_land(lat: float, lon: float) -> bool:
    """Returns True if coordinates are on land anywhere on the globe."""
    if _USE_GLOBE:
        return bool(_globe.is_land(lat, lon))
    # No land mask available: fail closed on distance (see
    # _reference_nearest_land_nm) rather than silently assuming open water.
    return False


@lru_cache(maxsize=4096)
def nearest_land_distance_nm(lat: float, lon: float) -> float:
    """Distance in NM to nearest land. Uses an adaptive grid search when available.

    Cached on exact (lat, lon) pairs, cheap to keep, since dashboards and
    repeated zone/slop checks routinely re-query the same ship position
    within a session. Callers should round inputs to a sensible precision
    (e.g. 4-5 decimal places, ~1-10 m) upstream if they want cache hits across
    near-duplicate coordinates.
    """
    if _USE_GLOBE:
        return _globe_nearest_land_nm(lat, lon)
    return _reference_nearest_land_nm(lat, lon)


def _globe_nearest_land_nm(lat: float, lon: float) -> float:
    """Adaptive radial search against the global_land_mask raster.

    Two phases:
      1. Coarse sweep: grow the search radius in 0.1 degree steps, sampling
         points around a full circle at each radius, until at least one
         sample lands on land. Sample density scales with radius so the
         angular gap between rays stays roughly constant, which keeps this
         phase from skipping over a nearby coastline that happens to fall
         between two rays.
      2. Binary refinement: once a land hit is found along a specific
         bearing, binary-search the radius between the last confirmed "sea"
         distance and the confirmed "land" distance to tighten the estimate,
         rather than reporting the coarse step size.

    Both phases are still bounded by the raster's own ~1 arc-minute (~1.85 km)
    cell resolution, so results are only as precise as global_land_mask
    itself, this narrows the search error on top of that floor, it does not
    remove it. For sub-cell precision, swap this for a vector coastline
    (Natural Earth/GSHHG) nearest-point query.
    """
    if _globe.is_land(lat, lon):
        return 0.0

    max_radius_deg = 15.0   # ~900 NM search ceiling
    step_deg = 0.1
    steps = int(max_radius_deg / step_deg)

    hit_radius_deg = None
    hit_angle = None

    for step in range(1, steps + 1):
        radius_deg = step * step_deg
        # Keep angular spacing between samples roughly constant as the
        # circle grows, instead of a fixed sample count that thins out at
        # larger radii and can miss a nearby coastline between two rays.
        n_samples = max(16, int(2 * pi * radius_deg / 0.025))
        for i in range(n_samples):
            angle = 2 * pi * i / n_samples
            check_lat = max(-90.0, min(90.0, lat + radius_deg * cos(angle)))
            check_lon = (((lon + radius_deg * sin(angle)) + 180.0) % 360.0) - 180.0
            if _globe.is_land(check_lat, check_lon):
                hit_radius_deg = radius_deg
                hit_angle = angle
                break
        if hit_radius_deg is not None:
            break

    if hit_radius_deg is None:
        return 999.0  # No land found within the search ceiling.

    # Binary refinement along the same bearing: the previous step's radius
    # is a confirmed "sea" bound, hit_radius_deg is a confirmed "land" bound.
    lo = hit_radius_deg - step_deg
    hi = hit_radius_deg
    for _ in range(12):  # tightens well under the raster's own resolution
        mid = (lo + hi) / 2
        mid_lat = max(-90.0, min(90.0, lat + mid * cos(hit_angle)))
        mid_lon = (((lon + mid * sin(hit_angle)) + 180.0) % 360.0) - 180.0
        if _globe.is_land(mid_lat, mid_lon):
            hi = mid
        else:
            lo = mid

    final_lat = max(-90.0, min(90.0, lat + hi * cos(hit_angle)))
    final_lon = (((lon + hi * sin(hit_angle)) + 180.0) % 360.0) - 180.0
    return round(haversine_nm(lat, lon, final_lat, final_lon), 2)


def _reference_nearest_land_nm(lat: float, lon: float) -> float:
    """Fallback 30-point method, only used if global-land-mask is not installed.

    This is a coarse safety net, not an accurate distance calculation: it
    measures distance to the nearest named reference city, not to the
    nearest actual coastline. Treat any result from this path as an upper
    bound at best, and prefer installing global-land-mask.
    """
    land_reference_points: List[Tuple[str, float, float]] = [
        ("Spain", 36.0, -5.6), ("France", 43.0, 5.0),
        ("Italy", 38.0, 15.0), ("Greece", 37.9, 23.7),
        ("Egypt", 31.2, 29.9), ("Saudi Arabia Red Sea", 21.5, 39.2),
        ("Yemen", 12.8, 45.0), ("Oman", 23.6, 58.5),
        ("UAE", 25.2, 55.3), ("India West Coast", 19.0, 72.8),
        ("India East Coast", 13.1, 80.3), ("Sri Lanka", 6.9, 79.9),
        ("South Africa", -34.0, 18.5), ("Brazil", -22.9, -43.2),
        ("US East Coast", 40.7, -74.0), ("US Gulf Coast", 29.3, -94.8),
        ("US West Coast", 34.0, -118.2), ("Alaska", 61.2, -149.9),
        ("Caribbean", 18.4, -66.1), ("Panama", 8.98, -79.5),
        ("UK", 50.0, -5.0), ("Norway", 60.4, 5.3),
        ("Denmark", 57.7, 10.6), ("Sweden", 57.7, 11.9),
        ("Finland", 60.2, 24.9), ("Turkey", 41.0, 29.0),
        ("Argentina", -34.6, -58.4), ("Australia West", -31.95, 115.86),
        ("Australia East", -33.86, 151.2), ("Japan", 35.7, 139.7),
    ]
    return round(
        min(haversine_nm(lat, lon, rlat, rlon) for _, rlat, rlon in land_reference_points),
        2,
    )


def initial_bearing_deg(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """Initial great-circle bearing (degrees, 0-360) from point 1 to point 2."""
    phi1, phi2 = radians(lat1), radians(lat2)
    dlon = radians(lon2 - lon1)
    y = sin(dlon) * cos(phi2)
    x = cos(phi1) * sin(phi2) - sin(phi1) * cos(phi2) * cos(dlon)
    return (degrees(atan2(y, x)) + 360.0) % 360.0


def cross_track_distance_nm(
    lat: float, lon: float,
    origin_lat: float, origin_lon: float,
    dest_lat: float, dest_lon: float,
) -> float:
    """
    Perpendicular (cross-track) distance in NM of point (lat, lon) from the
    great-circle path running from origin -> destination.
    Positive = right of track, negative = left of track.
    """
    d13 = haversine_nm(origin_lat, origin_lon, lat, lon) / EARTH_RADIUS_NM
    theta13 = radians(initial_bearing_deg(origin_lat, origin_lon, lat, lon))
    theta12 = radians(initial_bearing_deg(origin_lat, origin_lon, dest_lat, dest_lon))

    # Clamp before asin(): floating-point error can push this fractionally
    # outside [-1, 1] (e.g. 1.0000000000000002), which raises a domain
    # ValueError. Same guard already used below in along_track_distance_nm.
    sin_component = sin(d13) * sin(theta13 - theta12)
    sin_component = max(-1.0, min(1.0, sin_component))

    d_xt = asin(sin_component) * EARTH_RADIUS_NM
    return d_xt


def along_track_distance_nm(
    lat: float, lon: float,
    origin_lat: float, origin_lon: float,
    dest_lat: float, dest_lon: float,
) -> float:
    """
    Distance in NM measured along the great-circle track from origin to the
    point on the track closest to (lat, lon) (the point's projection).
    Can be negative (before origin) or exceed total route distance (past destination).
    """
    d13 = haversine_nm(origin_lat, origin_lon, lat, lon) / EARTH_RADIUS_NM
    xt = cross_track_distance_nm(lat, lon, origin_lat, origin_lon, dest_lat, dest_lon) / EARTH_RADIUS_NM

    # Guard against tiny floating point issues pushing the value out of [-1, 1]
    cos_ratio = cos(d13) / cos(xt)
    cos_ratio = max(-1.0, min(1.0, cos_ratio))

    d_at = acos(cos_ratio) * EARTH_RADIUS_NM

    # acos() only ever returns a magnitude in [0, pi], it cannot on its own
    # distinguish a point that projects AHEAD of the origin (toward the
    # destination) from one that projects BEHIND it (before departure).
    # Recover the sign by comparing the bearing to the point against the
    # bearing to the destination: if they differ by more than 90 degrees,
    # the point sits behind the origin, so along-track distance is negative.
    theta13 = radians(initial_bearing_deg(origin_lat, origin_lon, lat, lon))
    theta12 = radians(initial_bearing_deg(origin_lat, origin_lon, dest_lat, dest_lon))
    bearing_diff = (theta13 - theta12 + pi) % (2 * pi) - pi  # normalize to [-pi, pi]
    if abs(bearing_diff) > pi / 2:
        d_at = -d_at

    return d_at


def route_deviation_check(
    lat: float, lon: float,
    origin_lat: float, origin_lon: float,
    dest_lat: float, dest_lon: float,
    corridor_width_nm: float = 25.0,
) -> dict:
    """
    Validates whether (lat, lon) is a plausible position for a ship sailing
    from origin to destination.

    A position is VALID only if:
      1. Its perpendicular distance from the great-circle track is within
         +/- corridor_width_nm, AND
      2. Its along-track projection falls between 0 and the total route
         distance (i.e. it's actually between origin and destination, not
         way before departure or way past arrival).

    Raises ``ProblemException`` (rendered as RFC 7807 application/problem+json)
    when the inputs cannot describe a route: out-of-range coordinates, a
    non-positive corridor width, or a degenerate origin == destination leg.
    """
    validate_coordinates(lat, lon, "ship")
    validate_coordinates(origin_lat, origin_lon, "origin")
    validate_coordinates(dest_lat, dest_lon, "destination")

    if corridor_width_nm is None or corridor_width_nm <= 0:
        raise ProblemException(
            status=422,
            title="Invalid route corridor",
            detail=(
                "The route corridor width must be greater than 0 NM; "
                f"received {corridor_width_nm}."
            ),
            problem_type=TYPE_INVALID_ROUTE,
            extensions={"field": "corridor_width_nm", "value": corridor_width_nm},
        )

    total_route_nm = haversine_nm(origin_lat, origin_lon, dest_lat, dest_lon)

    if total_route_nm == 0:
        raise ProblemException(
            status=422,
            title="Degenerate route",
            detail=(
                "Origin and destination resolve to the same position "
                f"({origin_lat}, {origin_lon}); a route requires two distinct points."
            ),
            problem_type=TYPE_INVALID_ROUTE,
            extensions={
                "origin": {"latitude": origin_lat, "longitude": origin_lon},
                "destination": {"latitude": dest_lat, "longitude": dest_lon},
            },
        )

    cross_track_nm = cross_track_distance_nm(
        lat, lon, origin_lat, origin_lon, dest_lat, dest_lon
    )
    along_track_nm = along_track_distance_nm(
        lat, lon, origin_lat, origin_lon, dest_lat, dest_lon
    )

    within_corridor = abs(cross_track_nm) <= corridor_width_nm
    within_route_span = -5.0 <= along_track_nm <= (total_route_nm + 5.0)
    # small +/-5 NM tolerance at the endpoints for port approach/departure slack

    is_on_route = within_corridor and within_route_span

    if along_track_nm < 0:
        progress_pct = 0.0
    elif total_route_nm > 0:
        progress_pct = round(min(100.0, (along_track_nm / total_route_nm) * 100), 2)
    else:
        progress_pct = 0.0

    return {
        "is_on_route": is_on_route,
        "cross_track_distance_nm": round(cross_track_nm, 2),
        "along_track_distance_nm": round(along_track_nm, 2),
        "total_route_distance_nm": round(total_route_nm, 2),
        "route_progress_percent": progress_pct,
        "within_corridor": within_corridor,
        "within_route_span": within_route_span,
        "corridor_width_nm": corridor_width_nm,
    }


def great_circle_points(
    origin_lat: float, origin_lon: float,
    dest_lat: float, dest_lon: float,
    segments: int = 64,
) -> List[List[float]]:
    """Sample the great-circle track as ``segments + 1`` [lat, lon] pairs.

    Spherical linear interpolation (slerp) on the unit sphere, so the samples
    follow the true geodesic rather than the straight line a naive lat/lon
    interpolation would draw on a Mercator map. Consumed by the frontend for the
    route polyline and by the spatial index for route-segment zone screening.
    """
    segments = max(1, int(segments))
    phi1, lambda1 = radians(origin_lat), radians(origin_lon)
    phi2, lambda2 = radians(dest_lat), radians(dest_lon)

    angular = 2 * asin(
        min(1.0, sqrt(
            sin((phi2 - phi1) / 2) ** 2
            + cos(phi1) * cos(phi2) * sin((lambda2 - lambda1) / 2) ** 2
        ))
    )

    if angular == 0:
        return [[origin_lat, origin_lon], [dest_lat, dest_lon]]

    points: List[List[float]] = []
    for step in range(segments + 1):
        fraction = step / segments
        a = sin((1 - fraction) * angular) / sin(angular)
        b = sin(fraction * angular) / sin(angular)
        x = a * cos(phi1) * cos(lambda1) + b * cos(phi2) * cos(lambda2)
        y = a * cos(phi1) * sin(lambda1) + b * cos(phi2) * sin(lambda2)
        z = a * sin(phi1) + b * sin(phi2)
        points.append([
            round(degrees(atan2(z, sqrt(x * x + y * y))), 6),
            round(degrees(atan2(y, x)), 6),
        ])
    return points
