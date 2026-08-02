# app/rules.py
"""
Non-geospatial MARPOL rule catalog.
Absorbs IMO resolutions that fire on events/conditions rather than zone polygons.
Introduced in v2.1.0 to handle MEPC.384(81) container-loss reporting.
"""
from dataclasses import dataclass, field
from datetime import date
from typing import Any, Dict, List, Optional


@dataclass
class RuleRecord:
    rule_id: str
    trigger_type: str           # "zone_entry" | "event" | "temporal" | "cargo_type"
    resolution_ref: str         # e.g. "MEPC.384(81)"
    in_force_date: date
    description: str
    action_class: str           # "PROHIBITION" | "MANDATORY_REPORT" | "CERTIFICATION"
    conditions: Dict[str, Any] = field(default_factory=dict)
    zone_refs: List[str] = field(default_factory=list)   # [] = globally applicable
    enforcement_date: Optional[date] = None
    supersedes: Optional[str] = None


MARPOL_RULES: List[RuleRecord] = [
    # ── MEPC.384(81) Container-Loss Reporting ─────────────────────────────
    # Entered into force 1 January 2026.
    # Amends MARPOL Protocol I Article V.
    RuleRecord(
        rule_id="MARPOL_PROTO1_ART5_CONTAINER_LOSS",
        trigger_type="event",
        resolution_ref="MEPC.384(81)",
        in_force_date=date(2026, 1, 1),
        description=(
            "Loss of freight containers carrying marine pollutants must be "
            "reported as a danger message per SOLAS regulations V/31 and V/32. "
            "Applies globally — no geographic restriction."
        ),
        action_class="MANDATORY_REPORT",
        conditions={
            "event_type": "container_loss",
            "cargo_contains_marine_pollutant": True,
        },
        zone_refs=[],       # empty = global
    ),

    # ── MEPC.398(83) NOx Technical Code — Substantial Modification ────────
    # Entry into force 1 September 2026.
    RuleRecord(
        rule_id="ANNEX6_NOX_TECH_CODE_SUBSTANTIAL_MOD",
        trigger_type="temporal",
        resolution_ref="MEPC.398(83)",
        in_force_date=date(2026, 9, 1),
        description=(
            "Engines in Annex VI ECAs that undergo substantial modification "
            "must be certified against the updated NOx Technical Code 2008 "
            "as amended by MEPC.398(83). Covers Tier II retrofit-to-Tier-III "
            "certification pathways."
        ),
        action_class="CERTIFICATION",
        conditions={
            "engine_modification_type": "substantial",
            "target_certification": "NOx_Tier_III",
        },
        zone_refs=[
            "ANNEX6_BALTIC_SOX",
            "ANNEX6_NORTH_SEA_SOX",
            "ANNEX6_MEDITERRANEAN_SOX",
            "ANNEX6_NORTH_AMERICA_ECA",
            "ANNEX6_CANADIAN_ARCTIC_ECA",
            "ANNEX6_NE_ATLANTIC_ECA",
        ],
    ),

    # ── MEPC.407(84) NE Atlantic ECA — SOx enforcement ────────────────────
    RuleRecord(
        rule_id="ANNEX6_NE_ATLANTIC_SOX_0_10",
        trigger_type="zone_entry",
        resolution_ref="MEPC.407(84)",
        in_force_date=date(2028, 9, 1),
        description="Fuel sulphur ≤ 0.10% m/m required in the NE Atlantic ECA from 1 Sep 2028.",
        action_class="PROHIBITION",
        conditions={"fuel_sulphur_pct_gt": 0.10},
        zone_refs=["ANNEX6_NE_ATLANTIC_ECA"],
    ),

    # ── MEPC.407(84) NE Atlantic ECA — NOx Tier III ───────────────────────
    RuleRecord(
        rule_id="ANNEX6_NE_ATLANTIC_NOX_TIER3",
        trigger_type="zone_entry",
        resolution_ref="MEPC.407(84)",
        in_force_date=date(2027, 9, 1),
        description=(
            "NOx Tier III required in NE Atlantic ECA for ships with building "
            "contract ≥ 1 Jan 2027, keel laid ≥ 1 Jul 2027, or delivered ≥ 1 Jan 2031."
        ),
        action_class="CERTIFICATION",
        conditions={"building_contract_date_gte": "2027-01-01"},
        zone_refs=["ANNEX6_NE_ATLANTIC_ECA"],
        enforcement_date=date(2027, 9, 1),
    ),
]


def get_rules_for_zone(zone_id: str) -> List[RuleRecord]:
    """Return all rules that reference a specific zone_id."""
    return [r for r in MARPOL_RULES if zone_id in r.zone_refs]


def get_global_event_rules() -> List[RuleRecord]:
    """Return rules that apply globally (zone_refs is empty), triggered by events."""
    return [r for r in MARPOL_RULES if not r.zone_refs and r.trigger_type == "event"]


def get_rules_in_force(as_of: date | None = None) -> List[RuleRecord]:
    """Return rules currently in force. Default: today."""
    check_date = as_of or date.today()
    return [r for r in MARPOL_RULES if r.in_force_date <= check_date]