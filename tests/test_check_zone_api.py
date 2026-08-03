"""Endpoint tests for /api/v1/check-zone.

Covers happy paths, geometric boundary conditions (12 NM territorial line,
Mediterranean polygon edges and vertices, just-inside/just-outside points), the
two 2026 Annex VI ECAs designated by MEPC.392(82), and RFC 7807 error shapes.
"""

import pytest

from app import zone_checker
from tests.conftest import assert_problem

ZONE_URL = "/api/v1/check-zone"


def post_zone(client, lat, lon, **extra):
    payload = {"ship_id": "TEST", "latitude": lat, "longitude": lon}
    payload.update(extra)
    return client.post(ZONE_URL, json=payload)


def zone_ids(response):
    return {zone["zone_id"] for zone in response.json()["active_zones"]}


# ─────────────────────────── happy paths ───────────────────────────


def test_open_ocean_is_safe(client):
    response = post_zone(client, 0.0, -140.0)
    assert response.status_code == 200

    body = response.json()
    assert body["zone_status"] == "SAFE"
    assert body["in_special_area"] is False
    assert body["active_zones"] == []
    assert body["nearest_land_rule_satisfied"] is True


def test_mediterranean_returns_multiple_annexes(client):
    response = post_zone(client, 38.0, 17.0)
    assert response.status_code == 200

    body = response.json()
    assert body["zone_status"] == "RESTRICTED"
    assert {"I", "V", "VI"}.issubset({zone["annex"] for zone in body["active_zones"]})
    assert len(body["rules_checklist"]) == 2
    assert len(body["disposal_assessment"]) == len(zone_checker.SUPPORTED_WASTE_TYPES)


def test_waste_type_filter_narrows_active_zones(client):
    response = post_zone(client, 38.0, 17.0, waste_type_filter="Oil")
    assert response.status_code == 200
    assert all(z["waste_type"] == "Oil" for z in response.json()["active_zones"])


# ────────────────── 12 NM territorial-line boundary ──────────────────
# The nearest-land grid search is quantised, so the exact threshold is pinned by
# substituting the distance function; the assertions below verify that the API
# treats the rule as inclusive at exactly 12.00 NM.


@pytest.mark.parametrize(
    "distance_nm, expected_satisfied",
    [
        (11.99, False),  # just inside the territorial sea
        (12.00, True),   # exactly on the 12 NM line — inclusive
        (12.01, True),   # just outside
    ],
)
def test_twelve_nm_line_is_inclusive(client, monkeypatch, distance_nm, expected_satisfied):
    monkeypatch.setattr(
        zone_checker, "nearest_land_distance_nm", lambda lat, lon: distance_nm
    )

    response = post_zone(client, 0.0, -140.0)
    assert response.status_code == 200

    body = response.json()
    assert body["distance_to_nearest_land_nm"] == distance_nm
    assert body["nearest_land_rule_satisfied"] is expected_satisfied

    distance_rule = next(
        rule for rule in body["rules_checklist"] if rule["rule_code"] == "DISTANCE_12NM"
    )
    assert distance_rule["passed"] is expected_satisfied

    # Outside every special area, oil discharge hinges solely on the 12 NM rule.
    oil = next(item for item in body["disposal_assessment"] if item["code"] == "oil")
    assert oil["allowed"] is expected_satisfied


# ───────────── Mediterranean polygon edge / vertex boundaries ─────────────
# Registry polygon: (-5.6, 30.0) → (-5.6, 46.0) → (36.0, 46.0) → (36.0, 30.0).
# Containment is boundary-inclusive, so a ship sitting exactly on an edge or a
# vertex is reported as inside the zone.


def test_point_exactly_on_mediterranean_west_edge_is_inside(client):
    # 36°N on the 5°36'W meridian — the western edge, in the Strait of Gibraltar.
    response = post_zone(client, 36.0, -5.6)
    assert response.status_code == 200
    assert "ANNEX1_MEDITERRANEAN" in zone_ids(response)


def test_point_just_inside_mediterranean_west_edge(client):
    response = post_zone(client, 36.0, -5.5)
    assert response.status_code == 200
    assert "ANNEX1_MEDITERRANEAN" in zone_ids(response)


def test_point_just_outside_mediterranean_west_edge(client):
    # 0.1° west of the Mediterranean boundary is not in either Mediterranean
    # special-area polygon. It can still be in the newer North-East Atlantic ECA.
    response = post_zone(client, 36.0, -5.7)
    assert response.status_code == 200

    body = response.json()
    assert "ANNEX1_MEDITERRANEAN" not in zone_ids(response)
    assert "ANNEX5_MEDITERRANEAN" not in zone_ids(response)
    assert body["zone_status"] == "RESTRICTED"


@pytest.mark.parametrize(
    "lat, lon",
    [
        (30.0, -5.6),  # SW corner
        (46.0, -5.6),  # NW corner
        (46.0, 36.0),  # NE corner
        (30.0, 36.0),  # SE corner
    ],
)
def test_mediterranean_vertices_are_inside(lat, lon):
    # Exercised through the domain layer: three of the four corners fall on land,
    # which the endpoint rejects before any geometry runs.
    assert "ANNEX1_MEDITERRANEAN" in {
        zone["zone_id"] for zone in zone_checker.check_all_zones(lat, lon)
    }


def test_baltic_skagerrak_boundary_57_44_8_north():
    """The Baltic special area starts at 57°44.8'N (57.747) in the Skagerrak."""
    inside = {z["zone_id"] for z in zone_checker.check_all_zones(57.8, 11.0)}
    on_line = {z["zone_id"] for z in zone_checker.check_all_zones(57.747, 11.0)}
    outside = {z["zone_id"] for z in zone_checker.check_all_zones(57.7, 11.0)}

    assert "ANNEX1_BALTIC" in inside
    assert "ANNEX1_BALTIC" in on_line  # boundary-inclusive
    assert "ANNEX1_BALTIC" not in outside


# ──────────────── 2026 Annex VI ECAs — MEPC.392(82) ────────────────


def test_point_in_canadian_arctic_eca(client):
    # Baffin Bay, well inside the simplified Canadian Arctic envelope.
    response = post_zone(client, 73.0, -70.0)
    assert response.status_code == 200
    assert "ANNEX6_CANADIAN_ARCTIC_ECA" in zone_ids(response)

    zone = next(
        z for z in response.json()["active_zones"]
        if z["zone_id"] == "ANNEX6_CANADIAN_ARCTIC_ECA"
    )
    assert zone["annex"] == "VI"
    assert zone["effective_date"] == "2026-03-01"
    assert zone["enforcement_date"] == "2027-03-01"
    assert "0.10% m/m" in zone["guidance"]
    assert "1 March 2027" in zone["guidance"]
    assert "1 January 2025" in zone["guidance"]  # Tier III keel-laid date
    assert "130 kW" in zone["guidance"]
    assert "MEPC.392(82)" in zone["source"]


def test_beaufort_sea_west_of_137w_is_outside_canadian_arctic_eca(client):
    # The ECA's western limit is the 137th meridian west.
    inside = post_zone(client, 71.5, -133.0)
    outside = post_zone(client, 71.5, -145.0)

    assert "ANNEX6_CANADIAN_ARCTIC_ECA" in zone_ids(inside)
    assert "ANNEX6_CANADIAN_ARCTIC_ECA" not in zone_ids(outside)


def test_point_in_norwegian_sea_eca_north_of_62n(client):
    response = post_zone(client, 65.0, 5.0)
    assert response.status_code == 200
    assert "ANNEX6_NORWEGIAN_SEA_ECA" in zone_ids(response)

    zone = next(
        z for z in response.json()["active_zones"]
        if z["zone_id"] == "ANNEX6_NORWEGIAN_SEA_ECA"
    )
    assert zone["effective_date"] == "2026-03-01"
    assert zone["enforcement_date"] == "2027-03-01"
    assert "0.10% m/m" in zone["guidance"]
    assert "1 March 2027" in zone["guidance"]
    # Three-date principle for NOx Tier III.
    assert "1 March 2026" in zone["guidance"]
    assert "1 September 2026" in zone["guidance"]
    assert "1 March 2030" in zone["guidance"]
    assert "130 kW" in zone["guidance"]


def test_point_just_south_of_62n_off_norway_is_not_in_new_eca(client):
    """South of 62°N the vessel is in the pre-existing North Sea ECA only."""
    response = post_zone(client, 61.5, 4.0)
    assert response.status_code == 200

    ids = zone_ids(response)
    assert "ANNEX6_NORWEGIAN_SEA_ECA" not in ids
    assert "ANNEX6_NORTH_SEA_SOX" in ids


def test_barents_sea_is_in_norwegian_sea_eca(client):
    response = post_zone(client, 73.0, 30.0)
    assert response.status_code == 200
    assert "ANNEX6_NORWEGIAN_SEA_ECA" in zone_ids(response)


def test_new_ecas_are_listed_by_the_zones_endpoint(client):
    response = client.get("/api/v1/zones")
    assert response.status_code == 200

    by_id = {zone["zone_id"]: zone for zone in response.json()}
    for zone_id in ("ANNEX6_CANADIAN_ARCTIC_ECA", "ANNEX6_NORWEGIAN_SEA_ECA"):
        assert by_id[zone_id]["effective_date"] == "2026-03-01"
        assert by_id[zone_id]["annex"] == "VI"


def test_zones_geojson_returns_polygons(client):
    response = client.get(
        "/api/v1/zones/geojson", params={"zone_id": "ANNEX6_NORWEGIAN_SEA_ECA"}
    )
    assert response.status_code == 200

    body = response.json()
    assert body["type"] == "FeatureCollection"
    assert len(body["features"]) == 1

    feature = body["features"][0]
    assert feature["geometry"]["type"] == "Polygon"
    assert feature["properties"]["zone_id"] == "ANNEX6_NORWEGIAN_SEA_ECA"
    assert len(feature["geometry"]["coordinates"][0]) >= 4


# ─────────────────────── RFC 7807 error shapes ───────────────────────


def test_on_land_rejection_is_problem_json(client):
    response = post_zone(client, 28.6139, 77.2090)  # Delhi
    problem = assert_problem(response, 400, "/coordinates-on-land")

    assert "on land" in problem["detail"]
    assert problem["instance"] == ZONE_URL
    assert problem["latitude"] == 28.6139
    assert problem["longitude"] == 77.2090


@pytest.mark.parametrize(
    "lat, lon",
    [
        (91.0, 0.0),
        (-91.0, 0.0),
        (0.0, 181.0),
        (0.0, -181.0),
        (999.0, 999.0),
    ],
)
def test_out_of_range_coordinates_return_problem_json(client, lat, lon):
    response = post_zone(client, lat, lon)
    problem = assert_problem(response, 422, "/request-validation-error")

    assert problem["errors"]
    assert all({"field", "message", "type"} <= set(e) for e in problem["errors"])


def test_non_numeric_coordinates_return_problem_json(client):
    response = client.post(
        ZONE_URL, json={"ship_id": "TEST", "latitude": "north", "longitude": 15.0}
    )
    problem = assert_problem(response, 422, "/request-validation-error")
    assert any("latitude" in error["field"] for error in problem["errors"])


def test_missing_required_field_returns_problem_json(client):
    response = client.post(ZONE_URL, json={"latitude": 38.0, "longitude": 15.0})
    problem = assert_problem(response, 422, "/request-validation-error")
    assert any("ship_id" in error["field"] for error in problem["errors"])


def test_unhandled_error_returns_problem_json_500(tolerant_client, monkeypatch):
    def explode(*args, **kwargs):
        raise RuntimeError("simulated engine failure")

    monkeypatch.setattr(zone_checker, "check_all_zones", explode)

    response = tolerant_client.post(
        ZONE_URL,
        json={"ship_id": "TEST", "latitude": 38.0, "longitude": 17.0},
    )
    problem = assert_problem(response, 500, "/internal-server-error")

    # The internal message must not leak; only the exception class name does.
    assert "simulated engine failure" not in problem["detail"]
    assert problem["exception"] == "RuntimeError"


def test_unknown_path_returns_problem_json(client):
    response = client.get("/api/v1/does-not-exist")
    assert_problem(response, 404)
