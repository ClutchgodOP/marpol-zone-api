from fastapi.testclient import TestClient

from app.main import app

client = TestClient(app)


def test_health():
    res = client.get("/health")
    assert res.status_code == 200
    data = res.json()
    assert data["status"] == "ok"
    assert data["version"] == "2.0.0"


def test_ship_in_mediterranean():
    res = client.post(
        "/api/v1/check-zone",
        json={
            "ship_id": "TEST_01",
            "latitude": 38.0,
            "longitude": 15.0,
        },
    )

    assert res.status_code == 200
    data = res.json()

    assert data["ship_id"] == "TEST_01"
    assert data["evaluation_type"] == "zone_check"
    assert data["zone_status"] == "RESTRICTED"
    assert isinstance(data["active_zones"], list)
    assert len(data["active_zones"]) >= 1
    assert "distance_to_nearest_land_nm" in data
    assert isinstance(data["annex_summary"], list)
    assert isinstance(data["disposal_assessment"], list)
    assert isinstance(data["rules_checklist"], list)
    assert "summary" in data

    annexes = {z["annex"] for z in data["active_zones"]}
    assert "I" in annexes


def test_ship_in_open_ocean():
    res = client.post(
        "/api/v1/check-zone",
        json={
            "ship_id": "TEST_02",
            "latitude": 0.0,
            "longitude": -140.0,
        },
    )

    assert res.status_code == 200
    data = res.json()
    assert data["evaluation_type"] == "zone_check"
    assert data["zone_status"] == "SAFE"
    assert data["in_special_area"] is False
    assert isinstance(data["active_zones"], list)
    assert isinstance(data["disposal_assessment"], list)
    assert isinstance(data["rules_checklist"], list)


def test_ship_in_antarctic():
    res = client.post(
        "/api/v1/check-zone",
        json={
            "ship_id": "TEST_03",
            "latitude": -65.0,
            "longitude": 30.0,
        },
    )

    assert res.status_code == 200
    data = res.json()
    assert data["zone_status"] == "RESTRICTED"

    annexes = {z["annex"] for z in data["active_zones"]}
    assert {"I", "II", "V"}.issubset(annexes)


def test_optional_waste_type_filter():
    res = client.post(
        "/api/v1/check-zone",
        json={
            "ship_id": "TEST_04",
            "latitude": 38.0,
            "longitude": 15.0,
            "waste_type_filter": "Oil",
        },
    )

    assert res.status_code == 200
    data = res.json()
    assert all(z["waste_type"] == "Oil" for z in data["active_zones"])


def test_slop_check():
    res = client.post(
        "/api/v1/check-slop",
        json={
            "ship_id": "TEST_05",
            "latitude": 0.0,
            "longitude": -140.0,
            "ship_speed_knots": 8.5,
            "oil_content_ppm": 12.0,
            "discharge_rate_lpnm": 25.0,
            "tank_capacity_m3": 5000,
            "odmcs_operational": True,
        },
    )

    assert res.status_code == 200
    data = res.json()
    assert data["evaluation_type"] == "slop_check"
    assert "rules_checklist" in data
    assert isinstance(data["rules_checklist"], list)
    assert isinstance(data["disposal_assessment"], list)
    assert "summary" in data
