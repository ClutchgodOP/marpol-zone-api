from typing import Any, Dict, List, Literal, Optional

from pydantic import BaseModel, Field


class ShipRequest(BaseModel):
    ship_id: str = Field(..., example="SHIP_101")
    latitude: float = Field(..., ge=-90, le=90, example=17.389)
    longitude: float = Field(..., ge=-180, le=180, example=78.487)
    waste_type_filter: Optional[str] = Field(
        default=None,
        description=(
            "Optional exact waste type filter. "
            "Examples: Oil, Garbage, Sewage, Noxious Liquid Substances, "
            "Air Pollution (SOx/NOx ECA)"
        ),
        example="Garbage",
    )


class SlopCheckRequest(BaseModel):
    ship_id: str = Field(..., example="SHIP_101")
    latitude: float = Field(..., ge=-90, le=90, example=17.389)
    longitude: float = Field(..., ge=-180, le=180, example=78.487)
    ship_speed_knots: float = Field(..., ge=0, example=8.5)
    oil_content_ppm: float = Field(..., ge=0, example=12.0)
    discharge_rate_lpnm: float = Field(..., ge=0, example=25.0)
    tank_capacity_m3: float = Field(..., ge=0, example=5000.0)
    odmcs_operational: bool = Field(..., example=True)


class ZoneViolation(BaseModel):
    zone_id: str
    zone_name: str
    annex: str
    waste_type: str
    restriction: str


class AnnexSummary(BaseModel):
    annex: str
    active_zone_count: int
    waste_types: List[str]


class DisposalAssessmentItem(BaseModel):
    code: str
    label: str
    allowed: bool
    reason: str


class RuleChecklistItem(BaseModel):
    rule_code: str
    rule_name: str
    passed: bool
    actual_value: str
    required_value: str
    note: str


class ComplianceResponse(BaseModel):
    ship_id: str
    evaluation_type: Literal["zone_check", "slop_check"]
    latitude: float
    longitude: float
    distance_to_nearest_land_nm: float
    nearest_land_rule_satisfied: bool
    in_special_area: bool
    zone_status: Literal["SAFE", "RESTRICTED"]
    active_zones: List[ZoneViolation]
    annex_summary: List[AnnexSummary]
    disposal_assessment: List[DisposalAssessmentItem]
    rules_checklist: List[RuleChecklistItem]
    summary: str
    metadata: Dict[str, Any] = Field(default_factory=dict)  # fixed: was "meta"

class RouteCheckRequest(BaseModel):
    ship_id: str = Field(..., example="SHIP_101")

    # Current ship position (required)
    latitude: float = Field(..., ge=-90, le=90, example=8.5)
    longitude: float = Field(..., ge=-180, le=180, example=90.0)

    # Route origin — either a port code/name OR raw coordinates
    origin_port: Optional[str] = Field(default=None, example="VISAKHAPATNAM")
    origin_latitude: Optional[float] = Field(default=None, ge=-90, le=90)
    origin_longitude: Optional[float] = Field(default=None, ge=-180, le=180)

    # Route destination — either a port code/name OR raw coordinates
    destination_port: Optional[str] = Field(default=None, example="SINGAPORE")
    destination_latitude: Optional[float] = Field(default=None, ge=-90, le=90)
    destination_longitude: Optional[float] = Field(default=None, ge=-180, le=180)

    # How wide the acceptable corridor around the great-circle track is, in NM
    corridor_width_nm: float = Field(default=25.0, ge=1, le=500, example=25.0)


class RouteCheckResponse(BaseModel):
    ship_id: str
    latitude: float
    longitude: float
    origin: Dict[str, Any]
    destination: Dict[str, Any]
    is_on_route: bool
    route_status: Literal["ON_ROUTE", "OFF_ROUTE"]
    cross_track_distance_nm: float
    along_track_distance_nm: float
    total_route_distance_nm: float
    route_progress_percent: float
    corridor_width_nm: float
    summary: str
