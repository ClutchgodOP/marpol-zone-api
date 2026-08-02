from typing import Any, Dict, List, Literal, Optional

from pydantic import BaseModel, Field


class ShipRequest(BaseModel):
    model_config = {"extra": "forbid"}  # OWASP API3 — reject unexpected fields

    ship_id: str = Field(..., min_length=1, max_length=64, example="SHIP_101")
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
    model_config = {"extra": "forbid"}  # OWASP API3

    ship_id: str = Field(..., min_length=1, max_length=64, example="SHIP_101")
    latitude: float = Field(..., ge=-90, le=90, example=17.389)
    longitude: float = Field(..., ge=-180, le=180, example=78.487)
    ship_speed_knots: float = Field(..., ge=0, le=50, example=8.5)
    oil_content_ppm: float = Field(..., ge=0, le=1_000_000, example=12.0)
    discharge_rate_lpnm: float = Field(..., ge=0, le=10_000, example=25.0)
    tank_capacity_m3: float = Field(..., ge=0, le=500_000, example=5000.0)
    odmcs_operational: bool = Field(..., example=True)
    # ── Phase 3: Annex II NLS fields ─────────────────────────────────────────
    cargo_is_nls: bool = Field(
        default=False,
        description="True if slop contains NLS (Category X, Y, or Z) cargo residues.",
        example=False,
    )
    nls_category: Optional[str] = Field(
        default=None,
        description=(
            "NLS category per MARPOL Annex II: X (most toxic / prewash required), "
            "Y (significant hazard), or Z (minor hazard). Required when cargo_is_nls=True."
        ),
        example="Y",
    )


class ZoneViolation(BaseModel):
    zone_id: str
    zone_name: str
    annex: str
    waste_type: str
    restriction: str
    # Present on zones that carry regulatory dates (the 2026 Annex VI ECAs
    # designated by MEPC.392(82)); null for the older registry entries.
    effective_date: Optional[str] = None
    enforcement_date: Optional[str] = None
    guidance: Optional[str] = None
    source: Optional[str] = None


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
    metadata: Dict[str, Any] = Field(default_factory=dict)


class RouteCheckRequest(BaseModel):
    model_config = {"extra": "forbid"}  # OWASP API3

    ship_id: str = Field(..., min_length=1, max_length=64, example="SHIP_101")
    latitude: float = Field(..., ge=-90, le=90, example=8.5)
    longitude: float = Field(..., ge=-180, le=180, example=90.0)
    origin_port: Optional[str] = Field(default=None, max_length=64, example="VISAKHAPATNAM")
    origin_latitude: Optional[float] = Field(default=None, ge=-90, le=90)
    origin_longitude: Optional[float] = Field(default=None, ge=-180, le=180)
    destination_port: Optional[str] = Field(default=None, max_length=64, example="SINGAPORE")
    destination_latitude: Optional[float] = Field(default=None, ge=-90, le=90)
    destination_longitude: Optional[float] = Field(default=None, ge=-180, le=180)
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
    route_points: List[List[float]] = Field(default_factory=list)
    zones_crossed: List[ZoneViolation] = Field(default_factory=list)


class ProblemDetail(BaseModel):
    """RFC 7807 problem document. Documents the error shape in the OpenAPI schema;
    responses are produced by app.problem_details, not by this model."""

    model_config = {
        "json_schema_extra": {
            "example": {
                "type": "https://volteo-maritime.example/problems/coordinates-on-land",
                "title": "Coordinates are on land",
                "status": 400,
                "detail": "Coordinates (28.6139, 77.209) are on land. Please provide valid sea coordinates.",
                "instance": "/api/v1/check-zone",
            }
        }
    }

    type: str
    title: str
    status: int
    detail: str
    instance: str
