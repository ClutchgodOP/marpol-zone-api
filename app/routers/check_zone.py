from typing import Any, List, Optional

from fastapi import APIRouter, Query
from shapely.geometry import mapping

from app.geo_utils import is_on_land, validate_coordinates
from app.models import (
    ComplianceResponse,
    ProblemDetail,
    RouteCheckRequest,
    RouteCheckResponse,
    ShipRequest,
    SlopCheckRequest,
)
from app.problem_details import PROBLEM_CONTENT_TYPE, on_land_problem
from app.route_checker import evaluate_route
from app.zone_checker import evaluate_ship_zone, evaluate_slop_discharge
from app.zones import MARPOL_ZONES

router = APIRouter(prefix="/api/v1", tags=["MARPOL Compliance"])

# Attached to every endpoint so the OpenAPI schema advertises problem+json
# rather than FastAPI's default {"detail": ...} error envelope.
PROBLEM_RESPONSES = {
    400: {
        "description": "Rejected position or route definition (RFC 7807)",
        "content": {PROBLEM_CONTENT_TYPE: {"schema": ProblemDetail.model_json_schema()}},
    },
    422: {
        "description": "Request validation failure (RFC 7807)",
        "content": {PROBLEM_CONTENT_TYPE: {"schema": ProblemDetail.model_json_schema()}},
    },
    500: {
        "description": "Unhandled server error (RFC 7807)",
        "content": {PROBLEM_CONTENT_TYPE: {"schema": ProblemDetail.model_json_schema()}},
    },
}


def _reject_if_on_land(lat: float, lon: float) -> None:
    """Raise an RFC 7807 problem (400) if the coordinates fall on land.

    Coordinate range is validated first, so a malformed pair surfaces as an
    'invalid-coordinates' problem instead of being fed to the land mask.
    """
    validate_coordinates(lat, lon, "ship")
    if is_on_land(lat, lon):
        raise on_land_problem(lat, lon, instance="/api/v1")


@router.post("/check-zone", response_model=ComplianceResponse, responses=PROBLEM_RESPONSES)
async def check_zone(request: ShipRequest) -> Any:
    _reject_if_on_land(request.latitude, request.longitude)

    result = evaluate_ship_zone(
        lat=request.latitude,
        lon=request.longitude,
        waste_type_filter=request.waste_type_filter,
    )
    return {
        "ship_id": request.ship_id,
        "evaluation_type": result["evaluation_type"],
        "latitude": request.latitude,
        "longitude": request.longitude,
        "distance_to_nearest_land_nm": result["distance_to_nearest_land_nm"],
        "nearest_land_rule_satisfied": result["nearest_land_rule_satisfied"],
        "in_special_area": result["in_special_area"],
        "zone_status": result["zone_status"],
        "active_zones": result["active_zones"],
        "annex_summary": result["annex_summary"],
        "disposal_assessment": result["disposal_assessment"],
        "rules_checklist": result["rules_checklist"],
        "summary": result["summary"],
        "metadata": result["metadata"],
    }


@router.post("/check-slop", response_model=ComplianceResponse, responses=PROBLEM_RESPONSES)
async def check_slop(request: SlopCheckRequest) -> Any:
    _reject_if_on_land(request.latitude, request.longitude)

    result = evaluate_slop_discharge(
        lat=request.latitude,
        lon=request.longitude,
        ship_speed_knots=request.ship_speed_knots,
        oil_content_ppm=request.oil_content_ppm,
        discharge_rate_lpnm=request.discharge_rate_lpnm,
        tank_capacity_m3=request.tank_capacity_m3,
        odmcs_operational=request.odmcs_operational,
    )
    return {
        "ship_id": request.ship_id,
        "evaluation_type": result["evaluation_type"],
        "latitude": request.latitude,
        "longitude": request.longitude,
        "distance_to_nearest_land_nm": result["distance_to_nearest_land_nm"],
        "nearest_land_rule_satisfied": result["nearest_land_rule_satisfied"],
        "in_special_area": result["in_special_area"],
        "zone_status": result["zone_status"],
        "active_zones": result["active_zones"],
        "annex_summary": result["annex_summary"],
        "disposal_assessment": result["disposal_assessment"],
        "rules_checklist": result["rules_checklist"],
        "summary": result["summary"],
        "metadata": result["metadata"],
    }


@router.post("/check-route", response_model=RouteCheckResponse, responses=PROBLEM_RESPONSES)
async def check_route(request: RouteCheckRequest) -> Any:
    _reject_if_on_land(request.latitude, request.longitude)

    # evaluate_route raises ProblemException for unresolvable ports, incomplete
    # route definitions and degenerate legs; the app-level handler renders them.
    result = evaluate_route(
        ship_id=request.ship_id,
        lat=request.latitude,
        lon=request.longitude,
        origin_port=request.origin_port,
        origin_lat=request.origin_latitude,
        origin_lon=request.origin_longitude,
        destination_port=request.destination_port,
        destination_lat=request.destination_latitude,
        destination_lon=request.destination_longitude,
        corridor_width_nm=request.corridor_width_nm,
    )

    return {
        "ship_id": request.ship_id,
        "latitude": request.latitude,
        "longitude": request.longitude,
        "origin": result["origin"],
        "destination": result["destination"],
        "is_on_route": result["is_on_route"],
        "route_status": result["route_status"],
        "cross_track_distance_nm": result["cross_track_distance_nm"],
        "along_track_distance_nm": result["along_track_distance_nm"],
        "total_route_distance_nm": result["total_route_distance_nm"],
        "route_progress_percent": result["route_progress_percent"],
        "corridor_width_nm": result["corridor_width_nm"],
        "summary": result["summary"],
        "route_points": result["route_points"],
        "zones_crossed": result["zones_crossed"],
    }


@router.get("/ports")
async def list_ports():
    from app.ports import PORTS
    return [
        {"code": code, "name": info["name"], "latitude": info["lat"], "longitude": info["lon"]}
        for code, info in PORTS.items()
    ]


@router.get("/zones")
async def list_all_zones():
    return [
        {
            "zone_id": z["zone_id"],
            "name": z["name"],
            "annex": z["annex"],
            "type": z["type"],
            "restriction": z["restriction"],
            "effective_date": z.get("effective_date"),
            "enforcement_date": z.get("enforcement_date"),
            "guidance": z.get("guidance"),
            "source": z.get("source"),
        }
        for z in MARPOL_ZONES
    ]


@router.get("/zones/geojson", responses=PROBLEM_RESPONSES)
async def zones_geojson(
    zone_id: Optional[List[str]] = Query(
        default=None,
        description="Repeatable filter; omit to return every zone polygon.",
    ),
) -> Any:
    """Zone boundaries as a GeoJSON FeatureCollection for map rendering.

    Geometry is kept out of the compliance responses so those payloads stay
    small on high-frequency position streams; the frontend fetches the polygons
    it needs from here instead.
    """
    wanted = set(zone_id) if zone_id else None
    features = [
        {
            "type": "Feature",
            "geometry": mapping(zone["polygon"]),
            "properties": {
                "zone_id": zone["zone_id"],
                "name": zone["name"],
                "annex": zone["annex"],
                "type": zone["type"],
                "restriction": zone["restriction"],
                "effective_date": zone.get("effective_date"),
                "enforcement_date": zone.get("enforcement_date"),
            },
        }
        for zone in MARPOL_ZONES
        if wanted is None or zone["zone_id"] in wanted
    ]
    return {"type": "FeatureCollection", "features": features}
