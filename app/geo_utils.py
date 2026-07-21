from math import acos, asin, atan2, cos, degrees, pi, radians, sin, sqrt
from typing import List, Tuple

from shapely.geometry import Point

try:
    from global_land_mask import globe as _globe
    _USE_GLOBE = True
except ImportError:
    _globe = None
    _USE_GLOBE = False


def point_in_polygon(lat: float, lon: float, polygon) -> bool:
    ship_point = Point(lon, lat)
    return polygon.contains(ship_point) or polygon.touches(ship_point)


def haversine_nm(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """Great-circle distance in nautical miles."""
    R_km = 6371.0088
    dlat = radians(lat2 - lat1)
    dlon = radians(lon2 - lon1)
    a = (
        sin(dlat / 2) ** 2
        + cos(radians(lat1)) * cos(radians(lat2)) * sin(dlon / 2) ** 2
    )
    return R_km * 2 * asin(sqrt(a)) * 0.539956803


def is_on_land(lat: float, lon: float) -> bool:
    """Returns True if coordinates are on land anywhere on the globe."""
    if _USE_GLOBE:
        return bool(_globe.is_land(lat, lon))
    return False


def nearest_land_distance_nm(lat: float, lon: float) -> float:
    """Distance in NM to nearest land. Uses global grid search when available."""
    if _USE_GLOBE:
        return _globe_nearest_land_nm(lat, lon)
    return _reference_nearest_land_nm(lat, lon)


def _globe_nearest_land_nm(lat: float, lon: float) -> float:
    if _globe.is_land(lat, lon):
        return 0.0
    for step in range(1, 151):               # 0.1° to 15.0° (~900 NM)
        radius_deg = step * 0.1
        n_samples = max(16, int(radius_deg * 40))
        for i in range(n_samples):
            angle = 2 * pi * i / n_samples
            check_lat = max(-90.0, min(90.0, lat + radius_deg * cos(angle)))
            check_lon = (((lon + radius_deg * sin(angle)) + 180.0) % 360.0) - 180.0
            if _globe.is_land(check_lat, check_lon):
                return round(haversine_nm(lat, lon, check_lat, check_lon), 2)
    return 999.0


def _reference_nearest_land_nm(lat: float, lon: float) -> float:
    """Fallback 30-point method — only used if global-land-mask is not installed."""
    LAND_REFERENCE_POINTS: List[Tuple[str, float, float]] = [
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
        min(haversine_nm(lat, lon, rlat, rlon) for _, rlat, rlon in LAND_REFERENCE_POINTS), 2
    )
    
EARTH_RADIUS_NM = 3440.065  # mean Earth radius in nautical miles


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

    d_xt = asin(sin(d13) * sin(theta13 - theta12)) * EARTH_RADIUS_NM
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
    """
    total_route_nm = haversine_nm(origin_lat, origin_lon, dest_lat, dest_lon)

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
