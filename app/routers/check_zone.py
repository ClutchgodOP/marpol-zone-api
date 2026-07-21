from typing import Any

from fastapi import APIRouter, HTTPException

from app.geo_utils import is_on_land
from app.models import ComplianceResponse, RouteCheckRequest, RouteCheckResponse, ShipRequest, SlopCheckRequest
from app.route_checker import evaluate_route
from app.zone_checker import evaluate_ship_zone, evaluate_slop_discharge
from app.zones import MARPOL_ZONES

router = APIRouter(prefix="/api/v1", tags=["MARPOL Compliance"])


def _reject_if_on_land(lat: float, lon: float) -> None:
    """Raise 400 immediately if coordinates fall on land."""
    if is_on_land(lat, lon):
        raise HTTPException(
            status_code=400,
            detail=f"Coordinates ({lat}, {lon}) are on land. Please provide valid sea coordinates.",
        )


@router.post("/check-zone", response_model=ComplianceResponse)
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


@router.post("/check-slop", response_model=ComplianceResponse)
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

@router.post("/check-route", response_model=RouteCheckResponse)
async def check_route(request: RouteCheckRequest) -> Any:
    _reject_if_on_land(request.latitude, request.longitude)

    try:
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
    except (KeyError, ValueError) as exc:
        raise HTTPException(status_code=400, detail=str(exc))

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
        }
        for z in MARPOL_ZONES
    ]