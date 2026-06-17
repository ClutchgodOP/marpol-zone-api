from collections import defaultdict
from typing import Dict, List, Optional

from app.geo_utils import nearest_land_distance_nm, point_in_polygon
from app.zones import MARPOL_ZONES


SUPPORTED_WASTE_TYPES = [
    "Oil",
    "Noxious Liquid Substances",
    "Sewage",
    "Garbage",
    "Air Pollution (SOx/NOx ECA)",
]


def check_all_zones(lat: float, lon: float) -> List[Dict]:
    """
    Return all MARPOL zones containing the given ship position.
    A ship may be inside multiple zones across multiple annexes.
    """
    violations = []

    for zone in MARPOL_ZONES:
        polygon = zone["polygon"]
        if point_in_polygon(lat, lon, polygon):
            violations.append(
                {
                    "zone_id": zone["zone_id"],
                    "zone_name": zone["name"],
                    "annex": zone["annex"],
                    "waste_type": zone["type"],
                    "restriction": zone["restriction"],
                }
            )

    return violations


def filter_active_zones(
    active_zones: List[Dict], waste_type_filter: Optional[str] = None
) -> List[Dict]:
    if not waste_type_filter:
        return active_zones
    return [z for z in active_zones if z["waste_type"] == waste_type_filter]


def build_annex_summary(active_zones: List[Dict]) -> List[Dict]:
    grouped = defaultdict(lambda: {"count": 0, "waste_types": set()})

    for zone in active_zones:
        grouped[zone["annex"]]["count"] += 1
        grouped[zone["annex"]]["waste_types"].add(zone["waste_type"])

    summary = []
    for annex, values in sorted(grouped.items(), key=lambda item: item[0]):
        summary.append(
            {
                "annex": annex,
                "active_zone_count": values["count"],
                "waste_types": sorted(values["waste_types"]),
            }
        )

    return summary


def build_disposal_assessment(
    active_zones: List[Dict], distance_to_nearest_land_nm: float
) -> List[Dict]:
    zone_types = {z["waste_type"] for z in active_zones}
    far_from_land = distance_to_nearest_land_nm >= 12

    assessment = []

    for waste_type in SUPPORTED_WASTE_TYPES:
        restricted_by_zone = waste_type in zone_types

        if waste_type == "Oil":
            if restricted_by_zone:
                allowed = False
                reason = "Restricted because the vessel is inside an Annex I oil special area."
            elif not far_from_land:
                allowed = False
                reason = "Restricted because the vessel is less than 12 NM from nearest land."
            else:
                allowed = True
                reason = "No Annex I special area is active and the vessel is at least 12 NM from nearest land."

        elif waste_type == "Noxious Liquid Substances":
            if restricted_by_zone:
                allowed = False
                reason = "Restricted because the vessel is inside an Annex II restricted area."
            elif not far_from_land:
                allowed = False
                reason = "Operationally restricted because the vessel is less than 12 NM from nearest land."
            else:
                allowed = True
                reason = "No Annex II restricted area is active and the vessel is at least 12 NM from nearest land."

        elif waste_type == "Sewage":
            if restricted_by_zone:
                allowed = False
                reason = "Restricted because the vessel is inside an Annex IV sewage special area."
            elif not far_from_land:
                allowed = False
                reason = "Operationally restricted because the vessel is less than 12 NM from nearest land."
            else:
                allowed = True
                reason = "No Annex IV sewage special area is active and the vessel is at least 12 NM from nearest land."

        elif waste_type == "Garbage":
            if restricted_by_zone:
                allowed = False
                reason = "Restricted because the vessel is inside an Annex V garbage special area."
            elif not far_from_land:
                allowed = False
                reason = "Operationally restricted because the vessel is less than 12 NM from nearest land."
            else:
                allowed = True
                reason = "No Annex V garbage special area is active and the vessel is at least 12 NM from nearest land."

        else:
            if restricted_by_zone:
                allowed = False
                reason = "Restricted because the vessel is inside an Annex VI emission control area."
            else:
                allowed = True
                reason = "No Annex VI emission control area is active at the current position."

        assessment.append(
            {
                "code": waste_type.lower().replace(" ", "_").replace("/", "_"),
                "label": waste_type,
                "allowed": allowed,
                "reason": reason,
            }
        )

    return assessment


def build_zone_rules(
    active_zones: List[Dict], distance_to_nearest_land_nm: float
) -> List[Dict]:
    in_special_area = len(active_zones) > 0
    far_from_land = distance_to_nearest_land_nm >= 12

    return [
        {
            "rule_code": "SPECIAL_AREA",
            "rule_name": "Outside MARPOL special area for unrestricted disposal",
            "passed": not in_special_area,
            "actual_value": (
                f"Inside {len(active_zones)} active MARPOL zone(s)"
                if in_special_area
                else "Outside all registered MARPOL special areas"
            ),
            "required_value": "Outside applicable MARPOL special areas",
            "note": "If a ship is inside a MARPOL special area, disposal permissions depend on the annex-specific restrictions."
        },
        {
            "rule_code": "DISTANCE_12NM",
            "rule_name": "Distance from nearest land at least 12 NM",
            "passed": far_from_land,
            "actual_value": f"{distance_to_nearest_land_nm:.2f} NM",
            "required_value": ">= 12.00 NM",
            "note": "This rule is especially important for operational discharge checks and practical disposal guidance."
        },
    ]


def evaluate_ship_zone(
    lat: float,
    lon: float,
    waste_type_filter: Optional[str] = None,
) -> Dict:
    active_zones = check_all_zones(lat, lon)
    active_zones = filter_active_zones(active_zones, waste_type_filter)

    distance_nm = nearest_land_distance_nm(lat, lon)
    in_special_area = len(active_zones) > 0
    zone_status = "RESTRICTED" if in_special_area else "SAFE"

    annex_summary = build_annex_summary(active_zones)
    disposal_assessment = build_disposal_assessment(active_zones, distance_nm)
    rules_checklist = build_zone_rules(active_zones, distance_nm)

    if zone_status == "SAFE":
        if distance_nm >= 12:
            summary = (
                "Ship is outside all registered MARPOL special areas and is at least "
                "12 NM from nearest land."
            )
        else:
            summary = (
                "Ship is outside all registered MARPOL special areas, but it is less "
                "than 12 NM from nearest land."
            )
    else:
        summary = (
            f"Ship is inside {len(active_zones)} MARPOL restricted zone(s). "
            "Annex-specific discharge restrictions apply."
        )

    return {
        "evaluation_type": "zone_check",
        "distance_to_nearest_land_nm": distance_nm,
        "nearest_land_rule_satisfied": distance_nm >= 12,
        "in_special_area": in_special_area,
        "zone_status": zone_status,
        "active_zones": active_zones,
        "annex_summary": annex_summary,
        "disposal_assessment": disposal_assessment,
        "rules_checklist": rules_checklist,
        "summary": summary,
        "metadata": {},
    }


def evaluate_slop_discharge(
    lat: float,
    lon: float,
    ship_speed_knots: float,
    oil_content_ppm: float,
    discharge_rate_lpnm: float,
    tank_capacity_m3: float,
    odmcs_operational: bool,
) -> Dict:
    active_oil_zones = [
        zone for zone in check_all_zones(lat, lon) if zone["waste_type"] == "Oil"
    ]
    distance_nm = nearest_land_distance_nm(lat, lon)
    in_special_area = len(active_oil_zones) > 0

    rules_checklist = [
        {
            "rule_code": "SPECIAL_AREA",
            "rule_name": "Outside Annex I special area",
            "passed": not in_special_area,
            "actual_value": (
                "Inside Annex I special area"
                if in_special_area
                else "Outside Annex I special area"
            ),
            "required_value": "Outside Annex I special area",
            "note": "Slop discharge is not permitted in Annex I special areas."
        },
        {
            "rule_code": "DISTANCE_12NM",
            "rule_name": "Distance from nearest land at least 12 NM",
            "passed": distance_nm >= 12,
            "actual_value": f"{distance_nm:.2f} NM",
            "required_value": ">= 12.00 NM",
            "note": "For slop discharge, the vessel should be at least 12 NM from nearest land."
        },
        {
            "rule_code": "EN_ROUTE",
            "rule_name": "Ship is en route",
            "passed": ship_speed_knots > 0,
            "actual_value": f"{ship_speed_knots:.2f} knots",
            "required_value": "> 0 knots",
            "note": "The ship should be proceeding en route."
        },
        {
            "rule_code": "ODMCS",
            "rule_name": "ODMCS operational",
            "passed": odmcs_operational,
            "actual_value": "Operational" if odmcs_operational else "Not operational",
            "required_value": "Operational",
            "note": "Oil discharge monitoring and control system must be operational."
        },
        {
            "rule_code": "OIL_CONTENT",
            "rule_name": "Oil content below 15 ppm",
            "passed": oil_content_ppm < 15,
            "actual_value": f"{oil_content_ppm:.2f} ppm",
            "required_value": "< 15.00 ppm",
            "note": "Oil content should remain below 15 ppm."
        },
        {
            "rule_code": "DISCHARGE_RATE",
            "rule_name": "Discharge rate not above 30 L/NM",
            "passed": discharge_rate_lpnm <= 30,
            "actual_value": f"{discharge_rate_lpnm:.2f} L/NM",
            "required_value": "<= 30.00 L/NM",
            "note": "Instantaneous discharge rate must not exceed 30 liters per nautical mile."
        },
    ]

    all_passed = all(rule["passed"] for rule in rules_checklist)

    return {
        "evaluation_type": "slop_check",
        "distance_to_nearest_land_nm": distance_nm,
        "nearest_land_rule_satisfied": distance_nm >= 12,
        "in_special_area": in_special_area,
        "zone_status": "SAFE" if not in_special_area else "RESTRICTED",
        "active_zones": active_oil_zones,
        "annex_summary": build_annex_summary(active_oil_zones),
        "disposal_assessment": [
            {
                "code": "slop",
                "label": "Slop / Oil mixed water",
                "allowed": all_passed,
                "reason": (
                    "Slop discharge is permitted under the current Annex I operational inputs."
                    if all_passed
                    else "Slop discharge is not permitted because one or more Annex I rules failed."
                ),
            }
        ],
        "rules_checklist": rules_checklist,
        "summary": (
            "Slop discharge permitted under the current Annex I rule inputs."
            if all_passed
            else "Slop discharge not permitted under the current Annex I rule inputs."
        ),
        "metadata": {
            "ship_speed_knots": ship_speed_knots,
            "oil_content_ppm": oil_content_ppm,
            "discharge_rate_lpnm": discharge_rate_lpnm,
            "tank_capacity_m3": tank_capacity_m3,
            "odmcs_operational": odmcs_operational,
        },
    }
