from math import asin, cos, pi, radians, sin, sqrt
from typing import List, Tuple
import httpx
from shapely.geometry import Point, shape, MultiPolygon
from shapely.prepared import prep

_PREPARED_LAND = None

def point_in_polygon(lat: float, lon: float, polygon) -> bool:
    ship_point = Point(lon, lat)
    return polygon.contains(ship_point) or polygon.touches(ship_point)

def haversine_nm(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    R_km = 6371.0088
    dlat = radians(lat2 - lat1)
    dlon = radians(lon2 - lon1)
    a = (
        sin(dlat / 2) ** 2
        + cos(radians(lat1)) * cos(radians(lat2)) * sin(dlon / 2) ** 2
    )
    return R_km * 2 * asin(sqrt(a)) * 0.539956803

def _load_land_polygon():
    global _PREPARED_LAND
    if _PREPARED_LAND is not None:
        return
    try:
        url = "https://d2ad6b4ur7yvpq.cloudfront.net/naturalearth-3.3.0/ne_110m_land.geojson"
        response = httpx.get(url, timeout=15.0)
        response.raise_for_status()
        
        polygons = []
        for feature in response.json()["features"]:
            geom = shape(feature["geometry"])
            if geom.geom_type == 'Polygon':
                polygons.append(geom)
            elif geom.geom_type == 'MultiPolygon':
                polygons.extend(geom.geoms)
                
        _PREPARED_LAND = prep(MultiPolygon(polygons))
    except Exception as e:
        print(f"Failed to load land polygon: {e}")
        _PREPARED_LAND = False

def is_on_land(lat: float, lon: float) -> bool:
    global _PREPARED_LAND
    if _PREPARED_LAND is None:
        _load_land_polygon()
        
    if _PREPARED_LAND:
        return _PREPARED_LAND.contains(Point(lon, lat))
    return False

def nearest_land_distance_nm(lat: float, lon: float) -> float:
    return _reference_nearest_land_nm(lat, lon)

def _reference_nearest_land_nm(lat: float, lon: float) -> float:
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