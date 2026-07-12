from datetime import datetime

from pydantic import BaseModel

from .models import PlotStatus, PlotType


class SocietyCreate(BaseModel):
    name: str
    region: str | None = None
    center_lat: float
    center_lng: float
    default_zoom: int = 16
    sqft_per_marla: float = 272.25
    marla_per_kanal: int = 20
    default_counter_limit: int = 3


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

    class Config:
        from_attributes = True


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
    min_price: float | None = None
    width_ft: float | None = None
    depth_ft: float | None = None
    group_id: str | None = None
    cell_row: int | None = None
    cell_col: int | None = None


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
    min_price: float | None = None
    width_ft: float | None = None
    depth_ft: float | None = None
    geometry: dict | None = None  # GeoJSON Polygon — edit plot shape


class BulkPlotUpdate(BaseModel):
    ids: list[int]
    block: str | None = None
    street: str | None = None
    plot_type: PlotType | None = None
    min_price: float | None = None
    width_ft: float | None = None
    depth_ft: float | None = None


class BulkIds(BaseModel):
    ids: list[int]


class PlotBatchCreate(BaseModel):
    plots: list[PlotCreate]
    block: BlockDef | None = None


class PlotProperties(BaseModel):
    id: int
    society_id: int
    block: str | None
    street: str | None = None
    plot_no: str | None
    plot_type: PlotType
    status: PlotStatus
    area_sqft: float | None
    width_ft: float | None = None
    depth_ft: float | None = None
    min_price: float | None
    source: str
    confidence: float | None
    group_id: str | None = None
    confirmed: bool = False
