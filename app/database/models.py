from sqlalchemy import Column, String, Integer, Float, Boolean, DateTime, JSON, ForeignKey
from sqlalchemy.orm import declarative_base, relationship
from geoalchemy2 import Geometry
import datetime

Base = declarative_base()

class MarpolZoneModel(Base):
    __tablename__ = "marpol_zones"

    id = Column(Integer, primary_key=True, index=True)
    zone_id = Column(String, unique=True, nullable=False, index=True)
    name = Column(String, nullable=False)
    annex = Column(String, nullable=False)
    waste_type = Column(String, nullable=False)
    restriction = Column(String, nullable=False)
    
    # PostGIS spatial column for multi-polygons (using SRID 4326 for WGS 84 GPS coordinates)
    polygon = Column(Geometry("MULTIPOLYGON", srid=4326), nullable=False)


class ComplianceLogModel(Base):
    __tablename__ = "compliance_logs"

    id = Column(Integer, primary_key=True, index=True)
    ship_id = Column(String, nullable=False, index=True)
    evaluation_type = Column(String, nullable=False)  # "zone_check" or "slop_check"
    timestamp = Column(DateTime, default=datetime.datetime.utcnow)
    
    # Input coordinates mapped as a spatial Point
    location = Column(Geometry("POINT", srid=4326), nullable=False)
    latitude = Column(Float, nullable=False)
    longitude = Column(Float, nullable=False)
    
    # Metrics computed during evaluation
    distance_to_land_nm = Column(Float, nullable=False)
    in_special_area = Column(Boolean, nullable=False)
    overall_status = Column(String, nullable=False)
    
    # Raw JSON storage for structured compliance details (rules checklist, filters, etc.)
    input_metadata = Column(JSON, nullable=True)
    evaluation_results = Column(JSON, nullable=False)