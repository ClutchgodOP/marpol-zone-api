from math import asin, cos, pi, radians, sin, sqrt
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
