from sqlalchemy import create_engine, text
from sqlalchemy.orm import declarative_base, sessionmaker

from .config import settings

engine = create_engine(settings.database_url, pool_pre_ping=True)
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)
Base = declarative_base()


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


def init_db():
    """Enable PostGIS and create tables. Safe to call repeatedly."""
    with engine.connect() as conn:
        conn.execute(text("CREATE EXTENSION IF NOT EXISTS postgis"))
        conn.commit()
    # Import models so they register on Base before create_all.
    from . import models  # noqa: F401

    Base.metadata.create_all(bind=engine)

    # Lightweight dev migrations for columns added after a table already exists.
    # (Alembic replaces this once auth lands.)
    with engine.connect() as conn:
        conn.execute(
            text("ALTER TABLE plots ADD COLUMN IF NOT EXISTS confirmed boolean")
        )
        conn.execute(
            text("ALTER TABLE plots ADD COLUMN IF NOT EXISTS map_source_id integer")
        )
        conn.execute(
            text("ALTER TABLE plots ADD COLUMN IF NOT EXISTS width_ft double precision")
        )
        conn.execute(
            text("ALTER TABLE plots ADD COLUMN IF NOT EXISTS depth_ft double precision")
        )
        conn.execute(text("ALTER TABLE plots ADD COLUMN IF NOT EXISTS group_id varchar"))
        conn.execute(text("ALTER TABLE plots ADD COLUMN IF NOT EXISTS cell_row integer"))
        conn.execute(text("ALTER TABLE plots ADD COLUMN IF NOT EXISTS cell_col integer"))
        conn.execute(text("ALTER TABLE blocks ADD COLUMN IF NOT EXISTS verts json"))
        conn.execute(text("ALTER TABLE plots ADD COLUMN IF NOT EXISTS street varchar"))
        conn.execute(text("ALTER TABLE plots ADD COLUMN IF NOT EXISTS owner_id integer"))
        # Existing rows (e.g. seeded plots) predate the gate -> treat as confirmed.
        conn.execute(text("UPDATE plots SET confirmed = true WHERE confirmed IS NULL"))
        conn.commit()

    seed_superadmin()


def seed_superadmin():
    """Create the platform admin on first run if it doesn't exist yet."""
    from .config import settings
    from .models import User
    from .security import hash_password

    db = SessionLocal()
    try:
        existing = db.query(User).filter(User.email == settings.seed_admin_email).first()
        if existing is None:
            db.add(
                User(
                    email=settings.seed_admin_email,
                    password_hash=hash_password(settings.seed_admin_password),
                    full_name=settings.seed_admin_name,
                    is_superadmin=True,
                )
            )
            db.commit()
    finally:
        db.close()
