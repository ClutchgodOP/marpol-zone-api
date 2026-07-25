"""Tests for the STRtree-backed spatial index.

The index must be a drop-in accelerator: for every position it has to return
exactly what an exhaustive linear scan of the registry would return.
"""

import pytest
from shapely.geometry import Point

from app import spatial_index
from app.geo_utils import great_circle_points, point_in_polygon
from app.zones import MARPOL_ZONES

SAMPLE_POSITIONS = [
    (0.0, -140.0),      # open Pacific
    (38.0, 17.0),       # Mediterranean
    (60.0, 20.0),       # Baltic
    (-65.0, 30.0),      # Antarctic
    (73.0, -70.0),      # Canadian Arctic ECA
    (65.0, 5.0),        # Norwegian Sea ECA
    (61.5, 4.0),        # just south of 62°N
    (36.0, -5.6),       # exactly on the Mediterranean western edge
    (25.0, 55.0),       # Gulfs area
    (18.0, -66.0),      # Wider Caribbean
    (57.747, 11.0),     # exactly on the Baltic southern limit
    (-89.0, 0.0),       # deep Antarctic
]


def linear_scan(lat, lon):
    return [
        zone for zone in MARPOL_ZONES
        if point_in_polygon(lat, lon, zone["polygon"])
    ]


def test_index_is_built_once_at_import():
    assert spatial_index.INDEX_BACKEND in {"shapely.STRtree", "rtree.Index", "linear-scan"}
    assert spatial_index.index_stats()["indexed_zones"] == len(MARPOL_ZONES)


def test_shapely_2x_uses_strtree():
    """The pinned shapely is 2.x, so the STRtree path must be the one in use."""
    import shapely

    if shapely.__version__.startswith("2."):
        assert spatial_index.INDEX_BACKEND == "shapely.STRtree"


@pytest.mark.parametrize("lat, lon", SAMPLE_POSITIONS)
def test_index_matches_linear_scan(lat, lon):
    indexed = spatial_index.query_zones_at_point(lat, lon)
    assert [z["zone_id"] for z in indexed] == [z["zone_id"] for z in linear_scan(lat, lon)]


def test_results_are_returned_in_registry_order():
    zones = spatial_index.query_zones_at_point(38.0, 17.0)
    positions = [MARPOL_ZONES.index(zone) for zone in zones]
    assert positions == sorted(positions)


def test_candidate_pruning_beats_full_scan():
    """A bounding-box query must shortlist far fewer polygons than the registry
    holds — that pruning is the whole point of the index."""
    candidates = spatial_index._query_candidates(Point(17.0, 38.0))
    assert 0 < len(list(candidates)) < len(MARPOL_ZONES)


def test_segment_query_finds_crossed_zones():
    # A leg from the Atlantic into the central Mediterranean crosses the
    # Mediterranean special areas even though the endpoints straddle them.
    zones = spatial_index.query_zones_on_segment(36.0, -8.0, 36.0, 20.0)
    assert "ANNEX1_MEDITERRANEAN" in {z["zone_id"] for z in zones}


def test_segment_query_reports_no_zone_for_open_ocean_leg():
    zones = spatial_index.query_zones_on_segment(0.0, -140.0, -5.0, -135.0)
    assert zones == []


def test_path_query_deduplicates_zones():
    path = great_circle_points(60.0, 2.0, 70.0, 20.0, segments=32)
    zones = spatial_index.query_zones_on_path(path)

    ids = [zone["zone_id"] for zone in zones]
    assert len(ids) == len(set(ids))
    assert "ANNEX6_NORWEGIAN_SEA_ECA" in ids


def test_path_query_with_single_point_falls_back_to_point_query():
    zones = spatial_index.query_zones_on_path([[38.0, 17.0]])
    assert "ANNEX1_MEDITERRANEAN" in {z["zone_id"] for z in zones}


def test_path_query_with_no_points_returns_empty():
    assert spatial_index.query_zones_on_path([]) == []


def test_zone_by_id():
    assert spatial_index.zone_by_id("ANNEX6_CANADIAN_ARCTIC_ECA")["annex"] == "VI"
    assert spatial_index.zone_by_id("NOPE") is None


def test_all_registry_polygons_are_valid():
    for zone in MARPOL_ZONES:
        assert zone["polygon"].is_valid, f"{zone['zone_id']} has invalid geometry"
        assert not zone["polygon"].is_empty


def test_zone_ids_are_unique():
    ids = [zone["zone_id"] for zone in MARPOL_ZONES]
    assert len(ids) == len(set(ids))


def test_great_circle_points_follow_the_geodesic():
    points = great_circle_points(17.6868, 83.2185, 1.2644, 103.82, segments=16)

    assert len(points) == 17
    assert points[0] == pytest.approx([17.6868, 83.2185], abs=1e-4)
    assert points[-1] == pytest.approx([1.2644, 103.82], abs=1e-4)

    # The geodesic bulges away from the naive lat/lon straight line.
    midpoint = points[8]
    naive_mid_lat = (17.6868 + 1.2644) / 2
    assert midpoint[0] != pytest.approx(naive_mid_lat, abs=1e-3)
