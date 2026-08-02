# app/zones.py
from shapely.geometry import Polygon

# --- MARPOL ANNEX ZONE REGISTRY ---
# Each zone: { zone_id, name, annex, type, restriction, polygon }
# Optional keys (carried by the 2026 Annex VI ECAs): effective_date,
# enforcement_date, guidance, source.

MARPOL_ZONES = [

    # ─────────────────────── ANNEX I (Oil) ───────────────────────

    {
        "zone_id": "ANNEX1_MEDITERRANEAN",
        "name": "Mediterranean Sea",
        "annex": "I",
        "type": "Oil",
        "restriction": "No oil discharge allowed",
        # Bounding box approximation: 30°N south limit, 5°36'W west limit.
        # NOTE: 41°N is only the Black Sea hand-off point (see ANNEX1_BLACKSEA);
        # the Mediterranean Sea itself extends south to ~30°N (Libya/Egypt/Crete).
        # This box previously used 41.0 as the south limit, which excluded most
        # of the central and southern Mediterranean. Kept in sync with
        # ANNEX5_MEDITERRANEAN below, which already used the correct 30.0.
        "polygon": Polygon([
            (-5.6, 30.0),   # SW corner (Gibraltar meridian, south limit)
            (-5.6, 46.0),   # NW corner
            (36.0, 46.0),   # NE corner
            (36.0, 30.0),   # SE corner
            (-5.6, 30.0)
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
        "zone_id": "ANNEX6_MEDITERRANEAN_SOX",
        "name": "Mediterranean Sea SOx/PM ECA",
        "annex": "VI",
        "type": "Air Pollution (SOx/NOx ECA)",
        "restriction": "Fuel sulphur ≤ 0.10% (in force since 1 May 2025, MEPC.261(79))",
        # Bounding box approximation reusing the Mediterranean Sea extent above.
        # NOTE: verify against the official MEPC.261(79) coordinates if precise
        # boundary compliance is required — this is a rectangular approximation
        # consistent with the other zones in this registry.
        "polygon": Polygon([
            (-5.6, 30.0),
            (-5.6, 46.0),
            (36.0, 46.0),
            (36.0, 30.0),
            (-5.6, 30.0)
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

    # ───────────── ANNEX VI — 2026 ECAs designated by MEPC.392(82) ─────────────
    #
    # IMO Resolution MEPC.392(82), adopted at MEPC 82 (October 2024), designated
    # the Canadian Arctic and the Norwegian Sea as Emission Control Areas for
    # NOx, SOx and PM. The amendments entered into force on 1 March 2026.
    #
    # Sources:
    #   MEPC.392(82) full text:
    #     https://wwwcdn.imo.org/localresources/en/OurWork/Environment/Documents/MEPC.392(82).pdf
    #   DNV advisory:
    #     https://www.dnv.com/news/2025/new-ecas-for-the-canadian-arctic-norwegian-sea-and-north-east-atlantic-ocean/
    #   Lloyd's Register Class News 05/2025:
    #     https://www.lr.org/en/knowledge/class-news/05-25/
    #   ABS ECA overview:
    #     https://ww2.eagle.org/en/rules-and-resources/regulatory-updates/emission-control-areas.html

    {
        "zone_id": "ANNEX6_CANADIAN_ARCTIC_ECA",
        "name": "Canadian Arctic ECA",
        "annex": "VI",
        "type": "Air Pollution (SOx/NOx ECA)",
        "restriction": (
            "Fuel oil sulphur content must not exceed 0.10% m/m (or an approved "
            "equivalent such as an EGCS); the 0.10% limit becomes enforceable "
            "1 March 2027 after the 12-month grace period of Reg 14.7. NOx Tier III "
            "required for marine diesel engines > 130 kW on ships with keel laid on "
            "or after 1 January 2025."
        ),
        "effective_date": "2026-03-01",
        "enforcement_date": "2027-03-01",
        "guidance": (
            "Canadian Arctic ECA (MEPC.392(82)), in force 1 March 2026. SOx/PM: use "
            "fuel oil of 0.10% m/m sulphur content or less, or an approved equivalent "
            "(e.g. exhaust gas cleaning system); the 0.10% m/m limit is enforceable "
            "from 1 March 2027 following the standard 12-month grace period "
            "(MARPOL Annex VI Reg 14.7) — the area is designated from 1 March 2026 but "
            "the sulphur limit is not mandatory before that date. NOx: Tier III "
            "certification applies to marine diesel engines with power output above "
            "130 kW installed on ships whose keel was laid on or after 1 January 2025, "
            "when those ships operate in the ECA on or after 1 March 2026 "
            "(MARPOL Annex VI Reg 13, as amended). Carry a bunker delivery note and "
            "record fuel changeover times and tank positions in the ORB/logbook."
        ),
        "source": "IMO Resolution MEPC.392(82), Annex VI Appendix VII",
        # SIMPLIFIED geometry. The authoritative boundary is listed in Appendix VII
        # of MARPOL Annex VI as amended by MEPC.392(82): from the Yukon mainland at
        # 68°54'N 137°00'W (the 137th meridian west in the Beaufort Sea) eastward
        # across the Canadian Arctic Archipelago, past Hans Island (80°49'N 66°27'W),
        # and south through Baffin Bay/Davis Strait to the Newfoundland and Labrador
        # coast at 60°00'N 64°09.6'W. The polygon below is a coarse envelope of
        # Canadian Arctic waters bounded west at 137°W and south at 60°N — adequate
        # for advisory zone screening, NOT for legal boundary determination.
        "polygon": Polygon([
            (-137.0, 68.9),   # Yukon mainland, 68°54'N 137°00'W (Beaufort Sea)
            (-137.0, 72.5),   # north along the 137th meridian west
            (-125.0, 76.5),   # Amundsen Gulf / M'Clure Strait approaches
            (-110.0, 80.5),   # Queen Elizabeth Islands
            (-95.0, 83.5),    # northern limit above the Arctic Archipelago
            (-66.45, 80.82),  # Hans Island, 80°49'N 66°27'W
            (-55.0, 68.0),    # Baffin Bay eastern limit
            (-55.0, 60.0),    # Davis Strait / Labrador Sea, south limit 60°N
            (-64.16, 60.0),   # Labrador coast, 60°00'N 64°09.6'W
            (-95.0, 62.0),    # Hudson Strait / Foxe Basin approaches
            (-125.0, 66.0),   # Mackenzie Delta approaches
            (-137.0, 68.9),
        ]),
    },
    {
        "zone_id": "ANNEX6_NORWEGIAN_SEA_ECA",
        "name": "Norwegian Sea ECA",
        "annex": "VI",
        "type": "Air Pollution (SOx/NOx ECA)",
        "restriction": (
            "Fuel oil sulphur content must not exceed 0.10% m/m (or an approved "
            "equivalent such as an EGCS); the 0.10% limit becomes enforceable "
            "1 March 2027 after the 12-month grace period of Reg 14.7. NOx Tier III "
            "required for engines > 130 kW under the three-date principle: building "
            "contract on/after 1 March 2026, or keel laid on/after 1 September 2026 "
            "absent a contract, or delivery on/after 1 March 2030."
        ),
        "effective_date": "2026-03-01",
        "enforcement_date": "2027-03-01",
        "guidance": (
            "Norwegian Sea ECA (MEPC.392(82)), in force 1 March 2026, covering the "
            "Norwegian Exclusive Economic Zone north of 62°N including fjords and "
            "coastal waters. SOx/PM: use fuel oil of 0.10% m/m sulphur content or "
            "less, or an approved equivalent (e.g. exhaust gas cleaning system); the "
            "0.10% m/m limit is enforceable from 1 March 2027 after the 12-month "
            "grace period (MARPOL Annex VI Reg 14.7). NOx: Tier III applies to "
            "engines with power output above 130 kW under the three-date principle — "
            "(a) building contract placed on or after 1 March 2026, or (b) in the "
            "absence of a building contract, keel laid on or after 1 September 2026, "
            "or (c) delivery on or after 1 March 2030. Note the Norwegian EEZ south "
            "of 62°N was already covered by the North Sea ECA, so the entire "
            "Norwegian coast is now continuous ECA."
        ),
        "source": "IMO Resolution MEPC.392(82), Annex VI Appendix VII",
        # SIMPLIFIED geometry: coarse envelope of the Norwegian EEZ north of 62°N.
        # The southern edge is the 62°N parallel (the hand-off to the pre-existing
        # North Sea ECA); the eastern edge approximates the Norwegian/Russian
        # maritime boundary in the Barents Sea. Not a legal boundary.
        "polygon": Polygon([
            (-1.0, 62.0),   # western limit of the EEZ on the 62°N parallel
            (12.0, 62.0),   # 62°N parallel eastward across the Norwegian coast
            (20.0, 68.5),   # inland of the Lofoten/Troms coast (fjords included)
            (32.1, 70.3),   # Norwegian/Russian maritime boundary, Varanger area
            (32.1, 74.5),   # Barents Sea northern limit
            (10.0, 76.0),   # Norwegian Sea northern limit
            (-1.0, 72.0),   # western limit
            (-1.0, 62.0),
        ]),
    },

    # NOTE — A North-East Atlantic ECA has been proposed (MEPC 83) but is not yet
    # adopted; do not add until formally in force.
    
    # ── NEW: MEPC.407(84) North-East Atlantic ECA ─────────────────────────
    {
        "zone_id": "ANNEX6_NE_ATLANTIC_ECA",
        "name": "North-East Atlantic ECA",
        "annex": "VI",
        "type": "Air Pollution (SOx/NOx ECA)",
        "restriction": (
            "Fuel sulphur ≤ 0.10% m/m from 1 Sep 2028 (Reg 14); "
            "NOx Tier III for ships with building contract ≥ 1 Jan 2027 (Reg 13). "
            "Entry into force: 1 Sep 2027."
        ),
        "effective_date": "2027-09-01",
        "enforcement_date": "2028-09-01",
        "guidance": (
            "Covers EEZs of Greenland, Iceland, Faroe Islands, Ireland, UK, "
            "France, Spain, Portugal up to 200 NM. Polygon is advisory pending "
            "Appendix VII publication by IMO Secretariat."
        ),
        "source": "IMO Resolution MEPC.407(84), adopted May 2026",
        "polygon": Polygon([
            (-44.0, 35.0),   # SW — Portugal/Spain Atlantic coast
            (-9.5,  35.9),   # SE — Cape St. Vincent
            (-5.0,  36.0),   # Gibraltar strait west
            (-5.0,  48.5),   # Bay of Biscay north
            (-10.0, 51.5),   # Ireland SW corner
            (-16.0, 57.0),   # Ireland NW / Scotland west
            (-10.0, 61.5),   # Faroe Islands latitude
            (-25.0, 63.0),   # Iceland south
            (-24.0, 66.5),   # Iceland east
            (-14.0, 67.0),   # Iceland / Norway junction
            (-30.0, 73.0),   # Greenland SE coast
            (-44.0, 74.0),   # Greenland SW
            (-50.0, 67.0),   # Greenland south tip
            (-44.0, 35.0),   # close polygon back to SW
        ]),
    },

]