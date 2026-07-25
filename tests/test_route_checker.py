from fastapi.testclient import TestClient

from app.main import app

client = TestClient(app)


def test_ship_on_route_visakhapatnam_to_singapore():
    # (12.9039, 89.6346) sits ~30% of the way along the actual great-circle
    # track from Visakhapatnam to Singapore (verified via spherical slerp),
    # in open Bay of Bengal water. The previous fixture, (8.5, 90.0), was
    # actually ~193 NM off the true track — well outside the default 25 NM
    # corridor — so this test was failing before this fix. (The great circle
    # for this route runs close to the Andaman/Nicobar Islands, which is why
    # a hand-picked "roughly mid-track" guess landed so far off.)
    res = client.post(
        "/api/v1/check-route",
        json={
            "ship_id": "ROUTE_01",
            "latitude": 12.9039,
            "longitude": 89.6346,
            "origin_port": "VISAKHAPATNAM",
            "destination_port": "SINGAPORE",
        },
    )
    assert res.status_code == 200
    data = res.json()
    assert data["route_status"] == "ON_ROUTE"
    assert data["is_on_route"] is True


def test_ship_off_route_delhi_not_at_sea():
    # Delhi is inland — should be rejected as on-land before route logic even runs
    res = client.post(
        "/api/v1/check-route",
        json={
            "ship_id": "ROUTE_02",
            "latitude": 28.6139,
            "longitude": 77.2090,
            "origin_port": "VISAKHAPATNAM",
            "destination_port": "SINGAPORE",
        },
    )
    assert res.status_code == 400


def test_ship_off_route_wrong_sea_area():
    # A point in the Mediterranean while "sailing" Vizag -> Singapore: at sea, but nowhere near the route
    res = client.post(
        "/api/v1/check-route",
        json={
            "ship_id": "ROUTE_03",
            "latitude": 36.0,
            "longitude": 15.0,
            "origin_port": "VISAKHAPATNAM",
            "destination_port": "SINGAPORE",
        },
    )
    assert res.status_code == 200
    data = res.json()
    assert data["route_status"] == "OFF_ROUTE"
    assert data["is_on_route"] is False


def test_custom_coordinates_instead_of_port_names():
    # Same on-track point as test_ship_on_route_visakhapatnam_to_singapore above.
    res = client.post(
        "/api/v1/check-route",
        json={
            "ship_id": "ROUTE_04",
            "latitude": 12.9039,
            "longitude": 89.6346,
            "origin_latitude": 17.6868,
            "origin_longitude": 83.2185,
            "destination_latitude": 1.2644,
            "destination_longitude": 103.82,
        },
    )
    assert res.status_code == 200
    data = res.json()
    assert data["route_status"] == "ON_ROUTE"


def test_missing_route_info_returns_400():
    res = client.post(
        "/api/v1/check-route",
        json={
            "ship_id": "ROUTE_05",
            "latitude": 8.5,
            "longitude": 90.0,
        },
    )
    assert res.status_code == 400


def test_list_ports_endpoint():
    res = client.get("/api/v1/ports")
    assert res.status_code == 200
    codes = [p["code"] for p in res.json()]
    assert "SINGAPORE" in codes
    assert "VISAKHAPATNAM" in codes