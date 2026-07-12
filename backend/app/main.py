import json
import os
import uuid

import numpy as np
from fastapi import Depends, FastAPI, File, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from geoalchemy2 import Geography
from geoalchemy2.functions import ST_AsGeoJSON
from geoalchemy2.shape import from_shape
from PIL import Image
from shapely.geometry import Polygon, shape
from sqlalchemy import cast, func, select
from sqlalchemy.orm import Session

from .extraction import detect_plots

from .auth import (
    get_current_user,
    require_admin,
    require_superadmin,
)
from .config import settings
from .database import get_db, init_db
from .models import Block, MapSource, Membership, Plot, PlotStatus, PlotType, Role, Society, User
from .schemas import (
    AutoExtractParams,
    BlockOut,
    BlockReshape,
    BulkIds,
    BulkPlotUpdate,
    GeoreferenceIn,
    LoginIn,
    MapSourceOut,
    MembershipCreate,
    MembershipOut,
    MeOut,
    PlotBatchCreate,
    PlotCreate,
    PlotProperties,
    PlotUpdate,
    SocietyCreate,
    SocietyOut,
    TokenOut,
    UserCreate,
    UserOut,
)
from .security import create_access_token, hash_password, verify_password

SQM_TO_SQFT = 10.7639

app = FastAPI(title="Property Map Platform API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origin_list,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

os.makedirs(settings.upload_dir, exist_ok=True)
app.mount("/uploads", StaticFiles(directory=settings.upload_dir), name="uploads")


@app.on_event("startup")
def on_startup():
    init_db()


def map_to_out(m: MapSource) -> MapSourceOut:
    out = MapSourceOut.model_validate(m, from_attributes=True)
    out.image_url = f"/uploads/{m.filename}"
    return out


@app.get("/health")
def health():
    return {"status": "ok"}


# ---------- Auth & roles ----------


def _me(user: User) -> MeOut:
    out = MeOut.model_validate(user, from_attributes=True)
    out.memberships = [
        MembershipOut.model_validate(m, from_attributes=True) for m in user.memberships
    ]
    return out


@app.post("/api/auth/register", response_model=TokenOut, status_code=201)
def register(payload: UserCreate, db: Session = Depends(get_db)):
    email = payload.email.lower()
    if db.query(User).filter(User.email == email).first():
        raise HTTPException(status_code=409, detail="Email already registered")
    user = User(
        email=email,
        password_hash=hash_password(payload.password),
        full_name=payload.full_name,
        phone=payload.phone,
    )
    db.add(user)
    db.commit()
    db.refresh(user)
    return TokenOut(access_token=create_access_token(user.id), user=_me(user))


@app.post("/api/auth/login", response_model=TokenOut)
def login(payload: LoginIn, db: Session = Depends(get_db)):
    user = db.query(User).filter(User.email == payload.email.lower()).first()
    if not user or not verify_password(payload.password, user.password_hash):
        raise HTTPException(status_code=401, detail="Invalid email or password")
    if user.disabled:
        raise HTTPException(status_code=403, detail="Account disabled")
    return TokenOut(access_token=create_access_token(user.id), user=_me(user))


@app.get("/api/auth/me", response_model=MeOut)
def me(user: User = Depends(get_current_user)):
    return _me(user)


@app.get("/api/users", response_model=list[UserOut])
def list_users(
    _: User = Depends(require_superadmin), db: Session = Depends(get_db)
):
    return db.query(User).order_by(User.id).all()


@app.post("/api/memberships", response_model=MembershipOut, status_code=201)
def grant_membership(
    payload: MembershipCreate,
    _: User = Depends(require_superadmin),
    db: Session = Depends(get_db),
):
    """Superadmin assigns (or updates) a user's role within a society."""
    if not db.get(User, payload.user_id):
        raise HTTPException(status_code=404, detail="User not found")
    if not db.get(Society, payload.society_id):
        raise HTTPException(status_code=404, detail="Society not found")
    m = (
        db.query(Membership)
        .filter(
            Membership.user_id == payload.user_id,
            Membership.society_id == payload.society_id,
        )
        .first()
    )
    if m is None:
        m = Membership(**payload.model_dump())
        db.add(m)
    else:
        m.role = payload.role
    db.commit()
    db.refresh(m)
    return m


@app.get("/api/societies", response_model=list[SocietyOut])
def list_societies(db: Session = Depends(get_db)):
    return db.query(Society).order_by(Society.id).all()


@app.post("/api/societies", response_model=SocietyOut, status_code=201)
def create_society(
    payload: SocietyCreate,
    _: User = Depends(require_superadmin),
    db: Session = Depends(get_db),
):
    society = Society(**payload.model_dump())
    db.add(society)
    db.commit()
    db.refresh(society)
    return society


@app.get("/api/societies/{society_id}", response_model=SocietyOut)
def get_society(society_id: int, db: Session = Depends(get_db)):
    society = db.get(Society, society_id)
    if not society:
        raise HTTPException(status_code=404, detail="Society not found")
    return society


def feature_collection(rows) -> dict:
    """Build a GeoJSON FeatureCollection from (Plot, geojson_str) rows."""
    features = []
    for plot, geojson in rows:
        props = PlotProperties.model_validate(plot, from_attributes=True)
        features.append(
            {
                "type": "Feature",
                "geometry": json.loads(geojson),
                "properties": props.model_dump(mode="json"),
            }
        )
    return {"type": "FeatureCollection", "features": features}


@app.get("/api/societies/{society_id}/plots")
def get_plots_geojson(society_id: int, db: Session = Depends(get_db)):
    """Public: confirmed plots of a society as a GeoJSON FeatureCollection."""
    if not db.get(Society, society_id):
        raise HTTPException(status_code=404, detail="Society not found")

    rows = (
        db.query(Plot, ST_AsGeoJSON(Plot.geom))
        .filter(Plot.society_id == society_id, Plot.confirmed.is_(True))
        .all()
    )
    return feature_collection(rows)


ALLOWED_IMAGE_TYPES = {"image/png", "image/jpeg", "image/jpg"}


@app.get("/api/societies/{society_id}/maps", response_model=list[MapSourceOut])
def list_maps(
    society_id: int,
    _: User = Depends(require_admin),
    db: Session = Depends(get_db),
):
    if not db.get(Society, society_id):
        raise HTTPException(status_code=404, detail="Society not found")
    maps = (
        db.query(MapSource)
        .filter(MapSource.society_id == society_id)
        .order_by(MapSource.id.desc())
        .all()
    )
    return [map_to_out(m) for m in maps]


@app.post("/api/societies/{society_id}/maps", response_model=MapSourceOut, status_code=201)
def upload_map(
    society_id: int,
    file: UploadFile = File(...),
    _: User = Depends(require_admin),
    db: Session = Depends(get_db),
):
    if not db.get(Society, society_id):
        raise HTTPException(status_code=404, detail="Society not found")
    if file.content_type not in ALLOWED_IMAGE_TYPES:
        raise HTTPException(status_code=400, detail="Only PNG/JPEG images are allowed")

    ext = os.path.splitext(file.filename or "")[1].lower() or ".png"
    stored = f"{uuid.uuid4().hex}{ext}"
    path = os.path.join(settings.upload_dir, stored)
    with open(path, "wb") as f:
        f.write(file.file.read())

    try:
        with Image.open(path) as img:
            width, height = img.size
    except Exception:
        os.remove(path)
        raise HTTPException(status_code=400, detail="Uploaded file is not a valid image")

    m = MapSource(
        society_id=society_id,
        filename=stored,
        original_name=file.filename,
        width=width,
        height=height,
        status="draft",
    )
    db.add(m)
    db.commit()
    db.refresh(m)
    return map_to_out(m)


@app.get("/api/maps/{map_id}", response_model=MapSourceOut)
def get_map(
    map_id: int,
    _: User = Depends(require_admin),
    db: Session = Depends(get_db),
):
    m = db.get(MapSource, map_id)
    if not m:
        raise HTTPException(status_code=404, detail="Map not found")
    return map_to_out(m)


def solve_affine(points: list) -> dict:
    """Least-squares affine mapping pixel (px,py) -> world (lng,lat).

    lng = a*px + b*py + c ;  lat = d*px + e*py + f
    """
    A = np.array([[p.px, p.py, 1.0] for p in points])
    lng = np.array([p.lng for p in points])
    lat = np.array([p.lat for p in points])
    ca, *_ = np.linalg.lstsq(A, lng, rcond=None)
    cb, *_ = np.linalg.lstsq(A, lat, rcond=None)
    return {
        "a": float(ca[0]), "b": float(ca[1]), "c": float(ca[2]),
        "d": float(cb[0]), "e": float(cb[1]), "f": float(cb[2]),
    }


@app.put("/api/maps/{map_id}/georeference", response_model=MapSourceOut)
def georeference(
    map_id: int,
    payload: GeoreferenceIn,
    _: User = Depends(require_admin),
    db: Session = Depends(get_db),
):
    m = db.get(MapSource, map_id)
    if not m:
        raise HTTPException(status_code=404, detail="Map not found")
    if len(payload.control_points) < 3:
        raise HTTPException(status_code=400, detail="At least 3 control points required")

    m.transform = solve_affine(payload.control_points)
    m.control_points = [p.model_dump() for p in payload.control_points]
    db.commit()
    db.refresh(m)
    return map_to_out(m)


# ---------- Plot tracing (chunk C) ----------


@app.get("/api/maps/{map_id}/plots")
def list_map_plots(
    map_id: int,
    _: User = Depends(require_admin),
    db: Session = Depends(get_db),
):
    """Admin: all plots traced on a map (draft + confirmed), as GeoJSON."""
    if not db.get(MapSource, map_id):
        raise HTTPException(status_code=404, detail="Map not found")
    rows = (
        db.query(Plot, ST_AsGeoJSON(Plot.geom))
        .filter(Plot.map_source_id == map_id)
        .order_by(Plot.id)
        .all()
    )
    return feature_collection(rows)


@app.post("/api/maps/{map_id}/plots", status_code=201)
def create_plot(
    map_id: int,
    payload: PlotCreate,
    _: User = Depends(require_admin),
    db: Session = Depends(get_db),
):
    m = db.get(MapSource, map_id)
    if not m:
        raise HTTPException(status_code=404, detail="Map not found")

    plot = _build_plot(db, m, payload)
    if plot is None:
        raise HTTPException(status_code=400, detail="Invalid polygon geometry")
    db.add(plot)
    db.commit()
    db.refresh(plot)
    return PlotProperties.model_validate(plot, from_attributes=True).model_dump(mode="json")


def _stated_area(spec: PlotCreate) -> float | None:
    """Area from the stated W x D dimensions (not measured from geometry)."""
    if spec.width_ft and spec.depth_ft:
        return round(spec.width_ft * spec.depth_ft, 2)
    return None


def _build_plot(db: Session, m: MapSource, spec: PlotCreate) -> Plot | None:
    """Create (unsaved) a draft Plot from a PlotCreate spec, or None if invalid."""
    try:
        poly = shape(spec.geometry)
    except Exception:
        return None
    if poly.geom_type != "Polygon" or not poly.is_valid or poly.area == 0:
        return None
    return Plot(
        society_id=m.society_id,
        map_source_id=m.id,
        block=spec.block,
        street=spec.street,
        plot_no=spec.plot_no,
        plot_type=spec.plot_type,
        status=PlotStatus.unclaimed,
        width_ft=spec.width_ft,
        depth_ft=spec.depth_ft,
        area_sqft=_stated_area(spec),  # from stated size, not the drawing
        source="manual",
        confirmed=False,
        group_id=spec.group_id,
        cell_row=spec.cell_row,
        cell_col=spec.cell_col,
        geom=from_shape(poly, srid=4326),
    )


@app.post("/api/maps/{map_id}/plots/batch", status_code=201)
def create_plots_batch(
    map_id: int,
    payload: PlotBatchCreate,
    _: User = Depends(require_admin),
    db: Session = Depends(get_db),
):
    """Create many draft plots at once (used by the block-subdivision tool)."""
    m = db.get(MapSource, map_id)
    if not m:
        raise HTTPException(status_code=404, detail="Map not found")

    # Persist the block's defining quad so it can be re-tiled later.
    if payload.block is not None:
        b = payload.block
        db.merge(
            Block(
                id=b.id,
                society_id=m.society_id,
                map_source_id=m.id,
                verts=b.verts,
                rows=b.rows,
                cols=b.cols,
            )
        )

    created = 0
    for spec in payload.plots:
        plot = _build_plot(db, m, spec)
        if plot is not None:
            db.add(plot)
            created += 1
    db.commit()
    return {"created": created}


@app.get("/api/blocks/{block_id}", response_model=BlockOut)
def get_block(
    block_id: str,
    _: User = Depends(require_admin),
    db: Session = Depends(get_db),
):
    b = db.get(Block, block_id)
    if not b:
        raise HTTPException(status_code=404, detail="Block not found")
    return b


@app.post("/api/blocks/{block_id}/reshape")
def reshape_block(
    block_id: str,
    payload: BlockReshape,
    _: User = Depends(require_admin),
    db: Session = Depends(get_db),
):
    """Re-tile all plots of a block from a new quad — keeps numbers/metadata."""
    b = db.get(Block, block_id)
    if not b:
        raise HTTPException(status_code=404, detail="Block not found")

    plots = db.query(Plot).filter(Plot.group_id == block_id).all()
    by_cell = {(p.cell_row, p.cell_col): p for p in plots}

    updated = 0
    for cell in payload.cells:
        plot = by_cell.get((cell.cell_row, cell.cell_col))
        if plot is None or plot.confirmed:
            continue
        try:
            poly = shape(cell.geometry)
        except Exception:
            continue
        if poly.geom_type != "Polygon" or not poly.is_valid or poly.area == 0:
            continue
        plot.geom = from_shape(poly, srid=4326)
        updated += 1

    b.verts = payload.verts
    db.commit()
    return {"updated": updated}


@app.patch("/api/plots/bulk")
def bulk_update_plots(
    payload: BulkPlotUpdate,
    _: User = Depends(require_admin),
    db: Session = Depends(get_db),
):
    """Apply the same field values to many plots at once (only sent fields)."""
    data = payload.model_dump(exclude_unset=True)
    ids = data.pop("ids", [])
    if not ids:
        return {"updated": 0}
    plots = db.query(Plot).filter(Plot.id.in_(ids)).all()
    for p in plots:
        for field, value in data.items():
            setattr(p, field, value)
        if p.width_ft and p.depth_ft:
            p.area_sqft = round(p.width_ft * p.depth_ft, 2)
    db.commit()
    return {"updated": len(plots)}


@app.post("/api/plots/bulk-delete")
def bulk_delete_plots(
    payload: BulkIds,
    _: User = Depends(require_admin),
    db: Session = Depends(get_db),
):
    """Delete many draft plots at once (confirmed ones are skipped)."""
    if not payload.ids:
        return {"deleted": 0}
    n = (
        db.query(Plot)
        .filter(Plot.id.in_(payload.ids), Plot.confirmed.is_(False))
        .delete(synchronize_session=False)
    )
    db.commit()
    return {"deleted": n}


@app.delete("/api/plots/{plot_id}", status_code=204)
def delete_plot(
    plot_id: int,
    _: User = Depends(require_admin),
    db: Session = Depends(get_db),
):
    plot = db.get(Plot, plot_id)
    if not plot:
        raise HTTPException(status_code=404, detail="Plot not found")
    if plot.confirmed:
        raise HTTPException(status_code=400, detail="Cannot delete a confirmed plot")
    db.delete(plot)
    db.commit()


@app.patch("/api/plots/{plot_id}")
def update_plot(
    plot_id: int,
    payload: PlotUpdate,
    _: User = Depends(require_admin),
    db: Session = Depends(get_db),
):
    """Edit an individual plot's attributes (dimensions, number, type, price)."""
    plot = db.get(Plot, plot_id)
    if not plot:
        raise HTTPException(status_code=404, detail="Plot not found")

    data = payload.model_dump(exclude_unset=True)
    geometry = data.pop("geometry", None)
    for field, value in data.items():
        setattr(plot, field, value)

    # Optional shape edit — metadata/grouping are left untouched.
    if geometry is not None:
        try:
            poly = shape(geometry)
        except Exception:
            raise HTTPException(status_code=400, detail="Invalid geometry")
        if poly.geom_type != "Polygon" or not poly.is_valid or poly.area == 0:
            raise HTTPException(status_code=400, detail="Geometry must be a valid Polygon")
        plot.geom = from_shape(poly, srid=4326)

    # Keep area consistent with the stated dimensions (not the drawn shape).
    if plot.width_ft and plot.depth_ft:
        plot.area_sqft = round(plot.width_ft * plot.depth_ft, 2)
    db.commit()
    db.refresh(plot)
    return PlotProperties.model_validate(plot, from_attributes=True).model_dump(mode="json")


@app.delete("/api/plots/group/{group_id}")
def delete_plot_group(
    group_id: str,
    _: User = Depends(require_admin),
    db: Session = Depends(get_db),
):
    """Delete all draft plots of a subdivision block (by group id)."""
    n = (
        db.query(Plot)
        .filter(Plot.group_id == group_id, Plot.confirmed.is_(False))
        .delete(synchronize_session=False)
    )
    db.commit()
    return {"deleted": n}


@app.delete("/api/maps/{map_id}/plots")
def delete_draft_plots(
    map_id: int,
    _: User = Depends(require_admin),
    db: Session = Depends(get_db),
):
    """Reset: delete all unconfirmed (draft) plots of a map. Confirmed plots stay."""
    if not db.get(MapSource, map_id):
        raise HTTPException(status_code=404, detail="Map not found")
    n = (
        db.query(Plot)
        .filter(Plot.map_source_id == map_id, Plot.confirmed.is_(False))
        .delete(synchronize_session=False)
    )
    db.commit()
    return {"deleted": n}


@app.post("/api/maps/{map_id}/auto-extract")
def auto_extract(
    map_id: int,
    params: AutoExtractParams | None = None,
    _: User = Depends(require_admin),
    db: Session = Depends(get_db),
):
    """Run OpenCV detection and insert candidate plots as auto drafts."""
    m = db.get(MapSource, map_id)
    if not m:
        raise HTTPException(status_code=404, detail="Map not found")
    if not m.transform:
        raise HTTPException(status_code=400, detail="Georeference the map first")

    params = params or AutoExtractParams()
    path = os.path.join(settings.upload_dir, m.filename)
    detections = detect_plots(path, **params.model_dump())

    # Re-running replaces prior auto drafts; manual and confirmed plots are kept.
    db.query(Plot).filter(
        Plot.map_source_id == map_id,
        Plot.source == "auto",
        Plot.confirmed.is_(False),
    ).delete(synchronize_session=False)

    t = m.transform
    created = 0
    for pts, conf, _ in detections:
        world = [
            (t["a"] * px + t["b"] * py + t["c"], t["d"] * px + t["e"] * py + t["f"])
            for px, py in pts
        ]
        poly = Polygon(world)
        if not poly.is_valid or poly.area == 0:
            continue
        geom_el = from_shape(poly, srid=4326)
        area_m2 = db.scalar(select(func.ST_Area(cast(geom_el, Geography))))
        db.add(
            Plot(
                society_id=m.society_id,
                map_source_id=m.id,
                plot_type=PlotType.residential,
                status=PlotStatus.unclaimed,
                area_sqft=round(area_m2 * SQM_TO_SQFT, 2) if area_m2 else None,
                source="auto",
                confidence=conf,
                confirmed=False,
                geom=geom_el,
            )
        )
        created += 1

    db.commit()
    return {"created": created, "detected": len(detections)}


@app.post("/api/maps/{map_id}/confirm")
def confirm_map(
    map_id: int,
    _: User = Depends(require_admin),
    db: Session = Depends(get_db),
):
    """Promote all draft plots of a map to public and mark the map confirmed."""
    m = db.get(MapSource, map_id)
    if not m:
        raise HTTPException(status_code=404, detail="Map not found")

    count = (
        db.query(Plot)
        .filter(Plot.map_source_id == map_id, Plot.confirmed.is_(False))
        .update({Plot.confirmed: True})
    )
    m.status = "confirmed"
    db.commit()
    return {"confirmed_plots": count, "map_status": m.status}
