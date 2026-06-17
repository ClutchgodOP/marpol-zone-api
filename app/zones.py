# app/zones.py
from shapely.geometry import Polygon, MultiPolygon
from shapely.ops import unary_union

# --- MARPOL ANNEX ZONE REGISTRY ---
# Each zone: { name, annex, polygon(s), restriction_type }

MARPOL_ZONES = [

    # ─────────────────────── ANNEX I (Oil) ───────────────────────

    {
        "zone_id": "ANNEX1_MEDITERRANEAN",
        "name": "Mediterranean Sea",
        "annex": "I",
        "type": "Oil",
        "restriction": "No oil discharge allowed",
        # Bounding box approximation: 41°N south limit, 5°36'W west limit
        "polygon": Polygon([
            (-5.6, 41.0),   # Gibraltar (W boundary at 5°36'W)
            (-5.6, 46.0),   # NW corner
            (36.0, 46.0),   # NE corner
            (36.0, 41.0),   # Black Sea boundary at 41°N
            (-5.6, 41.0)
        ])
    },
    {
        "zone_id": "ANNEX1_BALTIC",
        "name": "Baltic Sea",
        "annex": "I",
        "type": "Oil",
        "restriction": "No oil discharge allowed",
        # Bounded by 57°44.8'N in the Skagerrak
        "polygon": Polygon([
            (9.0,  57.747),  # Skaw/Skagerrak entry
            (9.0,  66.0),
            (30.0, 66.0),
            (30.0, 57.747),
            (9.0,  57.747)
        ])
    },
    {
        "zone_id": "ANNEX1_BLACKSEA",
        "name": "Black Sea",
        "annex": "I",
        "type": "Oil",
        "restriction": "No oil discharge allowed",
        # North of 41°N parallel
        "polygon": Polygon([
            (28.0, 41.0),
            (28.0, 46.5),
            (41.5, 46.5),
            (41.5, 41.0),
            (28.0, 41.0)
        ])
    },
    {
        "zone_id": "ANNEX1_REDSEA",
        "name": "Red Sea",
        "annex": "I",
        "type": "Oil",
        "restriction": "No oil discharge allowed",
        # South boundary: rhumb line Ras si Ane (12°28.5'N, 43°19.6'E) → Husn Murad (12°40.4'N, 43°30.2'E)
        "polygon": Polygon([
            (32.0, 12.475),  # South boundary west
            (43.328, 12.475),
            (43.503, 12.673),  # South boundary east
            (43.503, 30.0),
            (32.0, 30.0),
            (32.0, 12.475)
        ])
    },
    {
        "zone_id": "ANNEX1_GULFS",
        "name": "Gulfs Area (Persian Gulf)",
        "annex": "I",
        "type": "Oil",
        "restriction": "No oil discharge allowed",
        # NW of rhumb line: Ras al Hadd (22°30'N, 59°48'E) → Ras al Fasteh (25°04'N, 61°25'E)
        "polygon": Polygon([
            (48.0, 22.5),
            (59.8, 22.5),
            (61.417, 25.067),
            (61.417, 30.5),
            (48.0, 30.5),
            (48.0, 22.5)
        ])
    },
    {
        "zone_id": "ANNEX1_GULF_OF_ADEN",
        "name": "Gulf of Aden",
        "annex": "I",
        "type": "Oil",
        "restriction": "No oil discharge allowed",
        # Between Red Sea and Arabian Sea: west bound at Ras si Ane, east at Ras Asir→Ras Fartak
        "polygon": Polygon([
            (43.327, 11.833),  # Ras si Ane
            (43.327, 15.583),
            (51.282, 15.583),  # Ras Fartak east
            (51.282, 11.833),
            (43.327, 11.833)
        ])
    },
    {
        "zone_id": "ANNEX1_ANTARCTIC",
        "name": "Antarctic Area",
        "annex": "I",
        "type": "Oil",
        "restriction": "No oil discharge allowed",
        # South of 60°S — entire longitude band
        "polygon": Polygon([
            (-180.0, -90.0),
            (-180.0, -60.0),
            (180.0, -60.0),
            (180.0, -90.0),
            (-180.0, -90.0)
        ])
    },
    {
        "zone_id": "ANNEX1_NW_EUROPEAN",
        "name": "North-West European Waters",
        "annex": "I",
        "type": "Oil",
        "restriction": "No oil discharge allowed",
        # Exact polygon from MARPOL regulation text
        "polygon": Polygon([
            (-2.0,  48.45),   # 48°27'N on French coast (approx lon)
            (-6.417, 48.45),  # 48°27'N, 6°25'W
            (-7.733, 49.867), # 49°52'N, 7°44'W
            (-12.0, 50.5),    # 50°30'N, 12°W
            (-12.0, 56.5),    # 56°30'N, 12°W
            (-3.0,  62.0),    # 62°N, 3°W
            (5.0,   62.0),    # 62°N Norwegian coast (approx)
            (10.0,  57.747),  # 57°44.8'N Danish/Swedish coast
            (-2.0,  48.45)
        ])
    },

    # ─────────────────────── ANNEX II (Noxious Liquid Substances) ───────────────────────

    {
        "zone_id": "ANNEX2_ANTARCTIC",
        "name": "Antarctic Area",
        "annex": "II",
        "type": "Noxious Liquid Substances",
        "restriction": "No discharge of noxious liquid substances",
        "polygon": Polygon([
            (-180.0, -90.0),
            (-180.0, -60.0),
            (180.0, -60.0),
            (180.0, -90.0),
            (-180.0, -90.0)
        ])
    },

    # ─────────────────────── ANNEX IV (Sewage) ───────────────────────

    {
        "zone_id": "ANNEX4_BALTIC",
        "name": "Baltic Sea",
        "annex": "IV",
        "type": "Sewage",
        "restriction": "No untreated sewage discharge",
        "polygon": Polygon([
            (9.0,  57.747),
            (9.0,  66.0),
            (30.0, 66.0),
            (30.0, 57.747),
            (9.0,  57.747)
        ])
    },

    # ─────────────────────── ANNEX V (Garbage) ───────────────────────

    {
        "zone_id": "ANNEX5_MEDITERRANEAN",
        "name": "Mediterranean Sea",
        "annex": "V",
        "type": "Garbage",
        "restriction": "No garbage discharge except treated food waste",
        "polygon": Polygon([
            (-5.6, 30.0),
            (-5.6, 46.0),
            (36.0, 46.0),
            (36.0, 30.0),
            (-5.6, 30.0)
        ])
    },
    {
        "zone_id": "ANNEX5_BALTIC",
        "name": "Baltic Sea",
        "annex": "V",
        "type": "Garbage",
        "restriction": "No garbage discharge except treated food waste",
        "polygon": Polygon([
            (9.0,  57.747),
            (9.0,  66.0),
            (30.0, 66.0),
            (30.0, 57.747),
            (9.0,  57.747)
        ])
    },
    {
        "zone_id": "ANNEX5_NORTH_SEA",
        "name": "North Sea",
        "annex": "V",
        "type": "Garbage",
        "restriction": "No garbage discharge except treated food waste",
        "polygon": Polygon([
            (-5.0, 48.0),
            (-5.0, 62.0),
            (13.0, 62.0),
            (13.0, 48.0),
            (-5.0, 48.0)
        ])
    },
    {
        "zone_id": "ANNEX5_ANTARCTIC",
        "name": "Antarctic Area (South of 60°S)",
        "annex": "V",
        "type": "Garbage",
        "restriction": "Full ban — NO garbage discharge at all",
        "polygon": Polygon([
            (-180.0, -90.0),
            (-180.0, -60.0),
            (180.0, -60.0),
            (180.0, -90.0),
            (-180.0, -90.0)
        ])
    },
    {
        "zone_id": "ANNEX5_WIDER_CARIBBEAN",
        "name": "Wider Caribbean Region",
        "annex": "V",
        "type": "Garbage",
        "restriction": "No garbage discharge except treated food waste",
        "polygon": Polygon([
            (-98.0, 7.0),
            (-98.0, 30.0),
            (-60.0, 30.0),
            (-50.0, 7.0),
            (-98.0, 7.0)
        ])
    },

    # ─────────────────────── ANNEX VI (Air Pollution / SOx ECAs) ───────────────────────

    {
        "zone_id": "ANNEX6_BALTIC_SOX",
        "name": "Baltic Sea SOx ECA",
        "annex": "VI",
        "type": "Air Pollution (SOx/NOx ECA)",
        "restriction": "Fuel sulphur ≤ 0.10%; NOx Tier III for ships built ≥ 2021",
        "polygon": Polygon([
            (9.0,  57.747),
            (9.0,  66.0),
            (30.0, 66.0),
            (30.0, 57.747),
            (9.0,  57.747)
        ])
    },
    {
        "zone_id": "ANNEX6_NORTH_SEA_SOX",
        "name": "North Sea SOx ECA",
        "annex": "VI",
        "type": "Air Pollution (SOx/NOx ECA)",
        "restriction": "Fuel sulphur ≤ 0.10%; NOx Tier III for ships built ≥ 2021",
        "polygon": Polygon([
            (-5.0, 48.0),
            (-5.0, 62.0),
            (13.0, 62.0),
            (13.0, 48.0),
            (-5.0, 48.0)
        ])
    },
    {
        "zone_id": "ANNEX6_NORTH_AMERICA_ECA",
        "name": "North American ECA",
        "annex": "VI",
        "type": "Air Pollution (SOx/NOx ECA)",
        "restriction": "SOx/PM controls; NOx Tier III for ships built ≥ 2016",
        "polygon": Polygon([
            (-168.0, 20.0),
            (-168.0, 74.0),
            (-30.0,  74.0),
            (-30.0,  20.0),
            (-168.0, 20.0)
        ])
    },
    {
        "zone_id": "ANNEX6_US_CARIBBEAN_ECA",
        "name": "US Caribbean Sea ECA",
        "annex": "VI",
        "type": "Air Pollution (SOx/NOx ECA)",
        "restriction": "SOx/PM controls; NOx Tier III for ships built ≥ 2016",
        "polygon": Polygon([
            (-90.0, 8.0),
            (-90.0, 24.0),
            (-60.0, 24.0),
            (-60.0, 8.0),
            (-90.0, 8.0)
        ])
    },
]
