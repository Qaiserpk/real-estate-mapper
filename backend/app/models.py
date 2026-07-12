import enum

from geoalchemy2 import Geometry
from sqlalchemy import (
    JSON,
    Boolean,
    Column,
    DateTime,
    Enum,
    Float,
    ForeignKey,
    Integer,
    String,
    UniqueConstraint,
    func,
)
from sqlalchemy.orm import relationship

from .database import Base


class PlotStatus(str, enum.Enum):
    unclaimed = "unclaimed"
    claim_pending = "claim_pending"
    owned = "owned"
    listed = "listed"
    under_offer = "under_offer"
    sold = "sold"


class PlotType(str, enum.Enum):
    residential = "residential"
    commercial = "commercial"
    agricultural = "agricultural"
    amenity = "amenity"
    other = "other"


class Role(str, enum.Enum):
    """A user's role within a single society (society-scoped)."""

    admin = "admin"    # validates claims, confirms maps, approves agreements
    owner = "owner"    # holds an approved ownership claim (usually derived)
    dealer = "dealer"  # verified agent/dealer
    member = "member"  # default: browse, claim, make offers


class User(Base):
    """Global account. Platform-wide superadmin flag; per-society roles live
    in Membership."""

    __tablename__ = "users"

    id = Column(Integer, primary_key=True, index=True)
    email = Column(String, nullable=False, unique=True, index=True)
    password_hash = Column(String, nullable=False)
    full_name = Column(String, nullable=True)
    phone = Column(String, nullable=True)
    is_superadmin = Column(Boolean, default=False, nullable=False)
    disabled = Column(Boolean, default=False, nullable=False)
    created_at = Column(DateTime(timezone=True), server_default=func.now())

    memberships = relationship(
        "Membership", back_populates="user", cascade="all, delete-orphan"
    )


class Membership(Base):
    """Grants a user a role within a specific society."""

    __tablename__ = "memberships"
    __table_args__ = (UniqueConstraint("user_id", "society_id", name="uq_user_society"),)

    id = Column(Integer, primary_key=True, index=True)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=False, index=True)
    society_id = Column(Integer, ForeignKey("societies.id"), nullable=False, index=True)
    role = Column(Enum(Role), default=Role.member, nullable=False)
    created_at = Column(DateTime(timezone=True), server_default=func.now())

    user = relationship("User", back_populates="memberships")
    society = relationship("Society")


class Society(Base):
    __tablename__ = "societies"

    id = Column(Integer, primary_key=True, index=True)
    name = Column(String, nullable=False)
    region = Column(String, nullable=True)
    center_lat = Column(Float, nullable=False)
    center_lng = Column(Float, nullable=False)
    default_zoom = Column(Integer, default=16)
    status = Column(String, default="active")  # active | archived

    # Per-society area conversion factors (sq ft).
    sqft_per_marla = Column(Float, default=272.25)
    marla_per_kanal = Column(Integer, default=20)
    default_counter_limit = Column(Integer, default=3)

    plots = relationship("Plot", back_populates="society", cascade="all, delete-orphan")
    maps = relationship(
        "MapSource", back_populates="society", cascade="all, delete-orphan"
    )


class MapSource(Base):
    """An uploaded society drawing/scan to be georeferenced and traced."""

    __tablename__ = "map_sources"

    id = Column(Integer, primary_key=True, index=True)
    society_id = Column(Integer, ForeignKey("societies.id"), nullable=False, index=True)

    filename = Column(String, nullable=False)  # stored file on disk
    original_name = Column(String, nullable=True)
    width = Column(Integer, nullable=True)  # pixels
    height = Column(Integer, nullable=True)
    status = Column(String, default="draft")  # draft | confirmed

    # Georeferencing (chunk B): pixel<->lnglat control points and derived transform.
    control_points = Column(JSON, nullable=True)  # [{px, py, lat, lng}, ...]
    transform = Column(JSON, nullable=True)  # affine coefficients

    created_at = Column(DateTime(timezone=True), server_default=func.now())

    society = relationship("Society", back_populates="maps")


class Block(Base):
    """A subdivided block: its full vertex grid, so plots can be re-tiled by
    moving individual (shared) vertices — not limited to a rigid quad."""

    __tablename__ = "blocks"

    id = Column(String, primary_key=True)  # == plots.group_id
    society_id = Column(Integer, ForeignKey("societies.id"), index=True)
    map_source_id = Column(Integer, ForeignKey("map_sources.id"), index=True)
    verts = Column(JSON)  # (rows+1) x (cols+1) grid of [lng,lat]
    rows = Column(Integer)
    cols = Column(Integer)


class Plot(Base):
    __tablename__ = "plots"

    id = Column(Integer, primary_key=True, index=True)
    society_id = Column(Integer, ForeignKey("societies.id"), nullable=False, index=True)
    map_source_id = Column(Integer, ForeignKey("map_sources.id"), nullable=True, index=True)

    # Safety gate: traced plots stay draft until their map is confirmed (spec §5).
    confirmed = Column(Boolean, default=False, nullable=False)

    block = Column(String, nullable=True)
    street = Column(String, nullable=True)
    plot_no = Column(String, nullable=True)
    plot_type = Column(Enum(PlotType), default=PlotType.residential)
    status = Column(Enum(PlotStatus), default=PlotStatus.unclaimed)

    area_sqft = Column(Float, nullable=True)  # derived from stated dimensions
    width_ft = Column(Float, nullable=True)  # stated plot size (not measured)
    depth_ft = Column(Float, nullable=True)
    # Deprecated: pricing (asking/floor price, bids, history) moves to dedicated
    # owner-facing listing tables in the marketplace phase. Kept for old rows.
    min_price = Column(Float, nullable=True)  # PKR
    source = Column(String, default="manual")  # manual | auto
    confidence = Column(Float, nullable=True)
    group_id = Column(String, nullable=True, index=True)  # subdivision block id
    cell_row = Column(Integer, nullable=True)  # position within its block grid
    cell_col = Column(Integer, nullable=True)

    # WGS84 polygon of the plot boundary.
    geom = Column(Geometry(geometry_type="POLYGON", srid=4326), nullable=False)

    society = relationship("Society", back_populates="plots")
