import os
from sqlalchemy import create_engine, text
from sqlalchemy.orm import sessionmaker

DATABASE_URL = os.getenv("DATABASE_URL", "postgresql://marpol_user:marpol_pass@localhost:5432/marpol_db")

engine = create_engine(DATABASE_URL, pool_preping=True)
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)

def init_db():
    """Initializes extensions and creates database tables."""
    with engine.connect() as conn:
        # PostGIS extension must be explicitly initialized in the database instance
        conn.execute(text("CREATE EXTENSION IF NOT EXISTS postgis;"))
        conn.commit()
    
    from app.database.models import Base
    Base.metadata.create_base_all(engine)

def get_db():
    """FastAPI Dependency injection provider for DB sessions."""
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()