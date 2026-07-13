from datetime import datetime

from pydantic import BaseModel, EmailStr, Field

from .models import (
    AgreementStatus,
    ClaimStatus,
    ListingStatus,
    OfferStatus,
    Party,
    PlotStatus,
    PlotType,
    Role,
)


class LevelDef(BaseModel):
    key: str
    label: str


class SocietyCreate(BaseModel):
    name: str
    region: str | None = None
    center_lat: float
    center_lng: float
    default_zoom: int = 16
    sqft_per_marla: float = 272.25
    marla_per_kanal: int = 20
    default_counter_limit: int = 3
    hierarchy: list[LevelDef] | None = None  # None -> DEFAULT_HIERARCHY


class SocietyOut(BaseModel):
    id: int
    name: str
    region: str | None
    center_lat: float
    center_lng: float
    default_zoom: int
    status: str
    sqft_per_marla: float
    marla_per_kanal: int
    default_counter_limit: int
    hierarchy: list[LevelDef] | None

    class Config:
        from_attributes = True


class SocietyUpdate(BaseModel):
    """Superadmin edit of society metadata. Only sent fields are applied."""

    name: str | None = None
    region: str | None = None
    center_lat: float | None = None
    center_lng: float | None = None
    default_zoom: int | None = None
    status: str | None = None
    sqft_per_marla: float | None = None
    marla_per_kanal: int | None = None
    default_counter_limit: int | None = None
    hierarchy: list[LevelDef] | None = None


# ---------- Auth & roles ----------


class UserCreate(BaseModel):
    email: EmailStr
    password: str = Field(min_length=8)
    full_name: str | None = None
    phone: str | None = None


class UserOut(BaseModel):
    id: int
    email: EmailStr
    full_name: str | None
    phone: str | None
    is_superadmin: bool

    class Config:
        from_attributes = True


class MembershipOut(BaseModel):
    society_id: int
    role: Role

    class Config:
        from_attributes = True


class MeOut(UserOut):
    memberships: list[MembershipOut] = []


class LoginIn(BaseModel):
    email: EmailStr
    password: str


class TokenOut(BaseModel):
    access_token: str
    token_type: str = "bearer"
    user: MeOut


class MembershipCreate(BaseModel):
    user_id: int
    society_id: int
    role: Role = Role.member


class ControlPoint(BaseModel):
    px: float  # pixel x on the drawing
    py: float  # pixel y on the drawing
    lat: float
    lng: float


class GeoreferenceIn(BaseModel):
    control_points: list[ControlPoint]


class MapSourceOut(BaseModel):
    id: int
    society_id: int
    original_name: str | None
    width: int | None
    height: int | None
    status: str
    control_points: list | None = None
    transform: dict | None = None
    created_at: datetime | None
    image_url: str | None = None

    class Config:
        from_attributes = True


class AutoExtractParams(BaseModel):
    white_thresh: int = 205
    min_area_frac: float = 1.2e-5
    max_area_frac: float = 1.2e-3
    dilate_iter: int = 1


class PlotCreate(BaseModel):
    geometry: dict  # GeoJSON Polygon geometry
    block: str | None = None
    street: str | None = None
    plot_no: str | None = None
    plot_type: PlotType = PlotType.residential
    width_ft: float | None = None
    depth_ft: float | None = None
    group_id: str | None = None
    cell_row: int | None = None
    cell_col: int | None = None
    attrs: dict | None = None  # extra society-defined level values


class BlockDef(BaseModel):
    id: str
    verts: list  # (rows+1) x (cols+1) grid of [lng,lat]
    rows: int
    cols: int


class BlockCell(BaseModel):
    cell_row: int
    cell_col: int
    geometry: dict


class BlockReshape(BaseModel):
    verts: list
    cells: list[BlockCell]


class BlockOut(BaseModel):
    id: str
    verts: list
    rows: int
    cols: int

    class Config:
        from_attributes = True


class PlotUpdate(BaseModel):
    block: str | None = None
    street: str | None = None
    plot_no: str | None = None
    plot_type: PlotType | None = None
    width_ft: float | None = None
    depth_ft: float | None = None
    attrs: dict | None = None
    geometry: dict | None = None  # GeoJSON Polygon — edit plot shape


class BulkPlotUpdate(BaseModel):
    ids: list[int]
    block: str | None = None
    street: str | None = None
    plot_type: PlotType | None = None
    width_ft: float | None = None
    depth_ft: float | None = None


class BulkIds(BaseModel):
    ids: list[int]


class PlotBatchCreate(BaseModel):
    plots: list[PlotCreate]
    block: BlockDef | None = None


# ---------- Ownership claims ----------


class ClaimCreate(BaseModel):
    note: str | None = None


class ClaimEvidenceOut(BaseModel):
    id: int
    original_name: str | None
    content_type: str | None
    uploaded_at: datetime | None

    class Config:
        from_attributes = True


class ClaimantOut(BaseModel):
    id: int
    email: EmailStr
    full_name: str | None
    phone: str | None

    class Config:
        from_attributes = True


class ClaimPlotRef(BaseModel):
    id: int
    block: str | None = None
    street: str | None = None
    plot_no: str | None = None
    status: PlotStatus

    class Config:
        from_attributes = True


class ClaimOut(BaseModel):
    id: int
    society_id: int
    status: ClaimStatus
    note: str | None
    review_note: str | None
    created_at: datetime | None
    reviewed_at: datetime | None
    plot: ClaimPlotRef
    claimant: ClaimantOut
    evidence: list[ClaimEvidenceOut] = []

    class Config:
        from_attributes = True


class ClaimReview(BaseModel):
    decision: str  # "approve" | "reject"
    note: str | None = None


# ---------- Marketplace: listings, offers, agreements ----------


class ListingCreate(BaseModel):
    asking_price: float = Field(gt=0)
    floor_price: float | None = Field(default=None, gt=0)
    description: str | None = None


class ListingUpdate(BaseModel):
    asking_price: float | None = Field(default=None, gt=0)
    floor_price: float | None = Field(default=None, gt=0)
    description: str | None = None


class ListingOut(BaseModel):
    """Owner/negotiation view — includes the private floor price."""

    id: int
    plot_id: int
    society_id: int
    asking_price: float
    floor_price: float | None
    description: str | None
    status: ListingStatus
    counter_limit: int
    created_at: datetime | None
    plot: ClaimPlotRef

    class Config:
        from_attributes = True


class ListingPublicOut(BaseModel):
    """Public view — no floor price."""

    id: int
    plot_id: int
    asking_price: float
    description: str | None
    status: ListingStatus

    class Config:
        from_attributes = True


class OfferParty(BaseModel):
    id: int
    full_name: str | None

    class Config:
        from_attributes = True


class OfferCreate(BaseModel):
    amount: float = Field(gt=0)
    message: str | None = None


class OfferAmount(BaseModel):
    amount: float = Field(gt=0)
    message: str | None = None


class OfferOut(BaseModel):
    id: int
    listing_id: int
    plot: ClaimPlotRef
    asking_price: float
    amount: float
    message: str | None
    proposed_by: Party
    status: OfferStatus
    counters_used: int
    counter_limit: int
    buyer: OfferParty
    created_at: datetime | None
    updated_at: datetime | None


class AgreementReview(BaseModel):
    decision: str  # "approve" | "reject"
    note: str | None = None


class AgreementOut(BaseModel):
    id: int
    plot: ClaimPlotRef
    society_id: int
    amount: float
    status: AgreementStatus
    review_note: str | None
    created_at: datetime | None
    reviewed_at: datetime | None
    buyer: OfferParty
    owner: OfferParty


class ContactCard(BaseModel):
    role: str  # "owner" | "buyer"
    full_name: str | None
    email: EmailStr
    phone: str | None


class ContactReveal(BaseModel):
    owner: ContactCard
    buyer: ContactCard
    amount: float


class PlotProperties(BaseModel):
    id: int
    society_id: int
    block: str | None
    street: str | None = None
    plot_no: str | None
    attrs: dict | None = None
    plot_type: PlotType
    status: PlotStatus
    area_sqft: float | None
    width_ft: float | None = None
    depth_ft: float | None = None
    source: str
    confidence: float | None
    group_id: str | None = None
    confirmed: bool = False
