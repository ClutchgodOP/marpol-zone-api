"""Endpoint tests for /api/v1/check-slop (MARPOL Annex I slop discharge)."""

import pytest

from app import zone_checker
from tests.conftest import assert_problem

SLOP_URL = "/api/v1/check-slop"

COMPLIANT = {
    "ship_id": "SLOP_TEST",
    "latitude": 0.0,
    "longitude": -140.0,
    "ship_speed_knots": 8.5,
    "oil_content_ppm": 12.0,
    "discharge_rate_lpnm": 25.0,
    "tank_capacity_m3": 5000.0,
    "odmcs_operational": True,
}


def post_slop(client, **overrides):
    payload = {**COMPLIANT, **overrides}
    return client.post(SLOP_URL, json=payload)


def rule(body, code):
    return next(item for item in body["rules_checklist"] if item["rule_code"] == code)


# ─────────────────────────── happy path ───────────────────────────


def test_compliant_slop_discharge_is_permitted(client):
    response = post_slop(client)
    assert response.status_code == 200

    body = response.json()
    assert body["evaluation_type"] == "slop_check"
    assert body["zone_status"] == "SAFE"
    assert body["disposal_assessment"][0]["allowed"] is True
    assert all(item["passed"] for item in body["rules_checklist"])
    assert body["metadata"]["tank_capacity_m3"] == 5000.0


def test_slop_inside_annex_i_special_area_is_refused(client):
    # Mediterranean — an Annex I oil special area.
    response = post_slop(client, latitude=38.0, longitude=17.0)
    assert response.status_code == 200

    body = response.json()
    assert body["in_special_area"] is True
    assert body["zone_status"] == "RESTRICTED"
    assert rule(body, "SPECIAL_AREA")["passed"] is False
    assert body["disposal_assessment"][0]["allowed"] is False
    # Only Annex I zones are reported by the slop evaluator.
    assert all(zone["waste_type"] == "Oil" for zone in body["active_zones"])


# ─────────────────── operational rule boundaries ───────────────────


@pytest.mark.parametrize(
    "ppm, expected_pass",
    [(14.99, True), (15.0, False), (15.01, False)],
)
def test_oil_content_15ppm_boundary_is_exclusive(client, ppm, expected_pass):
    body = post_slop(client, oil_content_ppm=ppm).json()
    assert rule(body, "OIL_CONTENT")["passed"] is expected_pass


@pytest.mark.parametrize(
    "rate, expected_pass",
    [(29.99, True), (30.0, True), (30.01, False)],
)
def test_discharge_rate_30lpnm_boundary_is_inclusive(client, rate, expected_pass):
    body = post_slop(client, discharge_rate_lpnm=rate).json()
    assert rule(body, "DISCHARGE_RATE")["passed"] is expected_pass


@pytest.mark.parametrize("speed, expected_pass", [(0.0, False), (0.1, True)])
def test_en_route_rule_requires_positive_speed(client, speed, expected_pass):
    body = post_slop(client, ship_speed_knots=speed).json()
    assert rule(body, "EN_ROUTE")["passed"] is expected_pass
    if not expected_pass:
        assert body["disposal_assessment"][0]["allowed"] is False


def test_odmcs_not_operational_blocks_discharge(client):
    body = post_slop(client, odmcs_operational=False).json()
    assert rule(body, "ODMCS")["passed"] is False
    assert body["disposal_assessment"][0]["allowed"] is False


@pytest.mark.parametrize(
    "distance_nm, expected_pass",
    [(11.99, False), (12.0, True), (12.01, True)],
)
def test_slop_twelve_nm_line_is_inclusive(client, monkeypatch, distance_nm, expected_pass):
    """A ship exactly on the 12 NM territorial line satisfies the distance rule."""
    monkeypatch.setattr(
        zone_checker, "nearest_land_distance_nm", lambda lat, lon: distance_nm
    )

    body = post_slop(client).json()
    assert body["distance_to_nearest_land_nm"] == distance_nm
    assert body["nearest_land_rule_satisfied"] is expected_pass
    assert rule(body, "DISTANCE_12NM")["passed"] is expected_pass
    assert body["disposal_assessment"][0]["allowed"] is expected_pass


def test_slop_in_new_norwegian_sea_eca_reports_annex_i_zones_only(client):
    """The Annex VI ECAs must not leak into an Annex I slop evaluation.

    The Norwegian Sea ECA regulates air emissions, not oil discharge, so at
    65°N 5°E the slop checker sees no Annex I special area even though the
    position is inside the new 2026 ECA.
    """
    zone_body = client.post(
        "/api/v1/check-zone",
        json={"ship_id": "X", "latitude": 65.0, "longitude": 5.0},
    ).json()
    assert "ANNEX6_NORWEGIAN_SEA_ECA" in {z["zone_id"] for z in zone_body["active_zones"]}

    body = post_slop(client, latitude=65.0, longitude=5.0).json()
    assert all(zone["waste_type"] == "Oil" for zone in body["active_zones"])
    assert "ANNEX6_NORWEGIAN_SEA_ECA" not in {z["zone_id"] for z in body["active_zones"]}
    assert body["in_special_area"] is False


# ─────────────────────── RFC 7807 error shapes ───────────────────────


def test_slop_on_land_rejection_is_problem_json(client):
    response = post_slop(client, latitude=28.6139, longitude=77.2090)
    problem = assert_problem(response, 400, "/coordinates-on-land")
    assert problem["instance"] == SLOP_URL


def test_slop_invalid_latitude_is_problem_json(client):
    response = post_slop(client, latitude=120.0)
    problem = assert_problem(response, 422, "/request-validation-error")
    assert any("latitude" in error["field"] for error in problem["errors"])


def test_slop_negative_oil_content_is_problem_json(client):
    response = post_slop(client, oil_content_ppm=-1.0)
    problem = assert_problem(response, 422, "/request-validation-error")
    assert any("oil_content_ppm" in error["field"] for error in problem["errors"])


def test_slop_missing_operational_fields_is_problem_json(client):
    response = client.post(
        SLOP_URL, json={"ship_id": "X", "latitude": 0.0, "longitude": -140.0}
    )
    problem = assert_problem(response, 422, "/request-validation-error")
    assert len(problem["errors"]) >= 4
