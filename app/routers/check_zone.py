from typing import Any, List, Optional

from fastapi import APIRouter, Depends, Query, Request
from shapely.geometry import mapping

from app.auth import require_scope
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
from app.rate_limit import limiter
from app.route_checker import evaluate_route
from app.zone_checker import evaluate_ship_zone, evaluate_slop_discharge
from app.zones import MARPOL_ZONES

router = APIRouter(prefix="/api/v1", tags=["MARPOL Compliance"])

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
    validate_coordinates(lat, lon, "ship")
    if is_on_land(lat, lon):
        raise on_land_problem(lat, lon, instance="/api/v1")


# ── /check-zone ───────────────────────────────────────────────────────────────
@router.post("/check-zone", response_model=ComplianceResponse, responses=PROBLEM_RESPONSES)
@limiter.limit("60/minute")
async def check_zone(
    request: Request,
    body: ShipRequest,
    _auth: dict = Depends(require_scope("zone:read")),
) -> Any:
    _reject_if_on_land(body.latitude, body.longitude)

    result = evaluate_ship_zone(
        lat=body.latitude,
        lon=body.longitude,
        waste_type_filter=body.waste_type_filter,
    )
    return {
        "ship_id": body.ship_id,
        "evaluation_type": result["evaluation_type"],
        "latitude": body.latitude,
        "longitude": body.longitude,
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


# ── /check-slop ───────────────────────────────────────────────────────────────
@router.post("/check-slop", response_model=ComplianceResponse, responses=PROBLEM_RESPONSES)
@limiter.limit("60/minute")
async def check_slop(
    request: Request,
    body: SlopCheckRequest,
    _auth: dict = Depends(require_scope("slop:read")),
) -> Any:
    _reject_if_on_land(body.latitude, body.longitude)

    result = evaluate_slop_discharge(
        lat=body.latitude,
        lon=body.longitude,
        ship_speed_knots=body.ship_speed_knots,
        oil_content_ppm=body.oil_content_ppm,
        discharge_rate_lpnm=body.discharge_rate_lpnm,
        tank_capacity_m3=body.tank_capacity_m3,
        odmcs_operational=body.odmcs_operational,
    )
    return {
        "ship_id": body.ship_id,
        "evaluation_type": result["evaluation_type"],
        "latitude": body.latitude,
        "longitude": body.longitude,
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


# ── /check-route ──────────────────────────────────────────────────────────────
@router.post("/check-route", response_model=RouteCheckResponse, responses=PROBLEM_RESPONSES)
@limiter.limit("30/minute")
async def check_route(
    request: Request,
    body: RouteCheckRequest,
    _auth: dict = Depends(require_scope("route:read")),
) -> Any:
    _reject_if_on_land(body.latitude, body.longitude)

    result = evaluate_route(
        ship_id=body.ship_id,
        lat=body.latitude,
        lon=body.longitude,
        origin_port=body.origin_port,
        origin_lat=body.origin_latitude,
        origin_lon=body.origin_longitude,
        destination_port=body.destination_port,
        destination_lat=body.destination_latitude,
        destination_lon=body.destination_longitude,
        corridor_width_nm=body.corridor_width_nm,
    )
    return {
        "ship_id": body.ship_id,
        "latitude": body.latitude,
        "longitude": body.longitude,
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


# ── /ports ────────────────────────────────────────────────────────────────────
@router.get("/ports")
@limiter.limit("120/minute")
async def list_ports(request: Request):
    from app.ports import PORTS
    return [
        {"code": code, "name": info["name"], "latitude": info["lat"], "longitude": info["lon"]}
        for code, info in PORTS.items()
    ]


# ── /zones ────────────────────────────────────────────────────────────────────
@router.get("/zones")
@limiter.limit("120/minute")
async def list_all_zones(request: Request):
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


# ── /zones/geojson ────────────────────────────────────────────────────────────
@router.get("/zones/geojson", responses=PROBLEM_RESPONSES)
@limiter.limit("60/minute")
async def zones_geojson(
    request: Request,
    zone_id: Optional[List[str]] = Query(
        default=None,
        description="Repeatable filter; omit to return every zone polygon.",
    ),
) -> Any:
    """Zone boundaries as a GeoJSON FeatureCollection for map rendering."""
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
