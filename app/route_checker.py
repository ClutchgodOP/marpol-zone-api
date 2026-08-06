# app/route_checker.py
from typing import Optional

from app.geo_utils import great_circle_points, maritime_route_points, route_deviation_check
from app.ports import get_port
from app.problem_details import (
    TYPE_INVALID_ROUTE,
    TYPE_PORT_NOT_FOUND,
    ProblemException,
)
from app.zone_checker import check_zones_along_path

ROUTE_TRACK_SEGMENTS = 64


def _resolve_point(
    port_ref: Optional[str],
    lat: Optional[float],
    lon: Optional[float],
    label: str,
) -> dict:
    """Resolve an origin/destination point from either a port reference or raw coordinates."""
    if port_ref:
        try:
            port = get_port(port_ref)
        except KeyError as exc:
            raise ProblemException(
                status=400,
                title="Port not found",
                detail=str(exc.args[0]) if exc.args else f"Port '{port_ref}' not found.",
                problem_type=TYPE_PORT_NOT_FOUND,
                extensions={"field": f"{label}_port", "value": port_ref},
            ) from exc
        return {"label": port["name"], "lat": port["lat"], "lon": port["lon"], "source": "port_registry"}

    if lat is not None and lon is not None:
        return {"label": f"Custom {label} ({lat}, {lon})", "lat": lat, "lon": lon, "source": "custom_coordinates"}

    raise ProblemException(
        status=400,
        title="Incomplete route definition",
        detail=(
            f"Provide either '{label}_port' (a port name/code) or both "
            f"'{label}_latitude' and '{label}_longitude'."
        ),
        problem_type=TYPE_INVALID_ROUTE,
        extensions={"field": f"{label}_port"},
    )


def evaluate_route(
    ship_id: str,
    lat: float,
    lon: float,
    origin_port: Optional[str],
    origin_lat: Optional[float],
    origin_lon: Optional[float],
    destination_port: Optional[str],
    destination_lat: Optional[float],
    destination_lon: Optional[float],
    corridor_width_nm: float = 25.0,
) -> dict:
    origin = _resolve_point(origin_port, origin_lat, origin_lon, "origin")
    destination = _resolve_point(destination_port, destination_lat, destination_lon, "destination")

    result = route_deviation_check(
        lat, lon,
        origin["lat"], origin["lon"],
        destination["lat"], destination["lon"],
        corridor_width_nm=corridor_width_nm,
    )

    route_status = "ON_ROUTE" if result["is_on_route"] else "OFF_ROUTE"

    if result["is_on_route"]:
        summary = (
            f"Ship {ship_id} is ON ROUTE from {origin['label']} to {destination['label']}. "
            f"{result['route_progress_percent']}% of the way, "
            f"{abs(result['cross_track_distance_nm'])} NM off the direct track "
            f"(within the {corridor_width_nm} NM allowed corridor)."
        )
    else:
        reasons = []
        if not result["within_corridor"]:
            reasons.append(
                f"{abs(result['cross_track_distance_nm'])} NM off the great-circle track "
                f"(corridor limit is {corridor_width_nm} NM)"
            )
        if not result["within_route_span"]:
            reasons.append("position falls outside the origin-to-destination span of the voyage")
        summary = (
            f"Ship {ship_id} is OFF ROUTE for the voyage from {origin['label']} to "
            f"{destination['label']}: {'; '.join(reasons)}."
        )

    # Sampled geodesic: drawn by the frontend as the planned-track polyline and
    # screened against the spatial index for the special areas the voyage crosses.
    track_points, route_source = maritime_route_points(
        origin["lat"], origin["lon"],
        destination["lat"], destination["lon"],
        segments=ROUTE_TRACK_SEGMENTS,
    )
     
    return {
        "origin": origin,
        "destination": destination,
        "route_status": route_status,
        "summary": summary,
        "route_points": track_points,
        "route_source": route_source,   # NEW — additive field, non-breaking
        "zones_crossed": check_zones_along_path(track_points),
        **result,
    }
