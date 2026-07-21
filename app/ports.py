# app/ports.py
"""Reference database of major ports for route validation convenience."""

PORTS = {
    "VISAKHAPATNAM": {"name": "Visakhapatnam Port, India", "lat": 17.6868, "lon": 83.2185},
    "SINGAPORE": {"name": "Port of Singapore", "lat": 1.2644, "lon": 103.8200},
    "MUMBAI": {"name": "Mumbai (Nhava Sheva) Port, India", "lat": 18.9490, "lon": 72.9525},
    "CHENNAI": {"name": "Chennai Port, India", "lat": 13.0930, "lon": 80.2930},
    "KOLKATA": {"name": "Kolkata (Haldia) Port, India", "lat": 22.0330, "lon": 88.0800},
    "COLOMBO": {"name": "Port of Colombo, Sri Lanka", "lat": 6.9500, "lon": 79.8400},
    "DUBAI": {"name": "Jebel Ali Port, Dubai, UAE", "lat": 25.0100, "lon": 55.0600},
    "ROTTERDAM": {"name": "Port of Rotterdam, Netherlands", "lat": 51.9500, "lon": 4.1400},
    "SHANGHAI": {"name": "Port of Shanghai, China", "lat": 31.3400, "lon": 121.5000},
    "HONG_KONG": {"name": "Port of Hong Kong", "lat": 22.2830, "lon": 114.1700},
    "DURBAN": {"name": "Port of Durban, South Africa", "lat": -29.8700, "lon": 31.0400},
    "SUEZ": {"name": "Suez Port, Egypt", "lat": 29.9700, "lon": 32.5500},
    "PANAMA_BALBOA": {"name": "Balboa Port, Panama", "lat": 8.9500, "lon": -79.5700},
    "ROTTERDAM_ANCHORAGE": {"name": "Rotterdam Anchorage", "lat": 51.9700, "lon": 3.8000},
    "NEW_YORK": {"name": "Port of New York/New Jersey, USA", "lat": 40.6700, "lon": -74.0400},
    "LOS_ANGELES": {"name": "Port of Los Angeles, USA", "lat": 33.7300, "lon": -118.2600},
    "TOKYO": {"name": "Port of Tokyo, Japan", "lat": 35.6300, "lon": 139.7700},
    "SYDNEY": {"name": "Port of Sydney, Australia", "lat": -33.8500, "lon": 151.2100},
    "ANTWERP": {"name": "Port of Antwerp, Belgium", "lat": 51.2600, "lon": 4.4200},
    "PIRAEUS": {"name": "Port of Piraeus, Greece", "lat": 37.9400, "lon": 23.6400},
    "JEDDAH": {"name": "Jeddah Islamic Port, Saudi Arabia", "lat": 21.4600, "lon": 39.1300},
    "FUJAIRAH": {"name": "Port of Fujairah, UAE", "lat": 25.1300, "lon": 56.3600},
    "KANDLA": {"name": "Kandla (Deendayal) Port, India", "lat": 23.0300, "lon": 70.2200},
    "COCHIN": {"name": "Cochin Port, India", "lat": 9.9500, "lon": 76.2600},
    "PARADIP": {"name": "Paradip Port, India", "lat": 20.3100, "lon": 86.6700},
}


def get_port(code_or_name: str) -> dict:
    """Look up a port by code (e.g. 'SINGAPORE') or partial name match (case-insensitive)."""
    key = code_or_name.strip().upper().replace(" ", "_")
    if key in PORTS:
        return PORTS[key]

    needle = code_or_name.strip().lower()
    for port in PORTS.values():
        if needle in port["name"].lower():
            return port

    raise KeyError(
        f"Port '{code_or_name}' not found in registry. "
        f"Available codes: {', '.join(sorted(PORTS.keys()))}"
    )
