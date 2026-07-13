import json
import os
import uuid

import numpy as np
from fastapi import Depends, FastAPI, File, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
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
    get_current_user_optional,
    is_society_admin,
    require_admin,
    require_superadmin,
)
from .config import settings
from .database import get_db, init_db
from .models import (
    Agreement,
    AgreementStatus,
    Block,
    Claim,
    ClaimEvidence,
    ClaimStatus,
    Listing,
    ListingStatus,
    MapSource,
    Membership,
    Offer,
    OfferStatus,
    Party,
    Plot,
    PlotStatus,
    PlotType,
    Role,
    Society,
    User,
)
from .schemas import (
    AutoExtractParams,
    BlockOut,
    BlockReshape,
    BulkIds,
    BulkPlotUpdate,
    AgreementOut,
    AgreementReview,
    ClaimantOut,
    ClaimCreate,
    ClaimEvidenceOut,
    ClaimOut,
    ClaimPlotRef,
    ClaimReview,
    ContactCard,
    ContactReveal,
    GeoreferenceIn,
    ListingCreate,
    ListingOut,
    ListingPublicOut,
    ListingUpdate,
    LoginIn,
    MapSourceOut,
    MembershipCreate,
    MembershipOut,
    MeOut,
    OfferAmount,
    OfferCreate,
    OfferOut,
    OfferParty,
    PlotBatchCreate,
    PlotCreate,
    PlotProperties,
    PlotUpdate,
    SocietyCreate,
    SocietyOut,
    SocietyUpdate,
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
os.makedirs(settings.evidence_dir, exist_ok=True)
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
def list_societies(
    include_archived: bool = False,
    user: User | None = Depends(get_current_user_optional),
    db: Session = Depends(get_db),
):
    """Public: active societies only. Admins may include archived ones."""
    is_admin = user is not None and (
        user.is_superadmin
        or db.query(Membership)
        .filter(Membership.user_id == user.id, Membership.role == Role.admin)
        .first()
        is not None
    )
    q = db.query(Society)
    if not (include_archived and is_admin):
        q = q.filter(Society.status == "active")
    return q.order_by(Society.id).all()


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


@app.patch("/api/societies/{society_id}", response_model=SocietyOut)
def update_society(
    society_id: int,
    payload: SocietyUpdate,
    _: User = Depends(require_superadmin),
    db: Session = Depends(get_db),
):
    """Superadmin edits society metadata (only the fields provided)."""
    society = db.get(Society, society_id)
    if not society:
        raise HTTPException(status_code=404, detail="Society not found")
    data = payload.model_dump(exclude_unset=True)
    for field, value in data.items():
        setattr(society, field, value)
    db.commit()
    db.refresh(society)
    return society


@app.delete("/api/societies/{society_id}", status_code=204)
def delete_society(
    society_id: int,
    _: User = Depends(require_superadmin),
    db: Session = Depends(get_db),
):
    """Permanently delete a society and everything under it (plots, maps,
    blocks, claims + evidence, listings, offers, agreements, memberships)."""
    society = db.get(Society, society_id)
    if not society:
        raise HTTPException(status_code=404, detail="Society not found")

    # Collect files to remove from disk after the DB rows are gone.
    claim_ids = [
        cid for (cid,) in db.query(Claim.id).filter(Claim.society_id == society_id).all()
    ]
    evidence_files = []
    if claim_ids:
        evidence_files = [
            fn
            for (fn,) in db.query(ClaimEvidence.filename)
            .filter(ClaimEvidence.claim_id.in_(claim_ids))
            .all()
        ]
    map_files = [
        fn
        for (fn,) in db.query(MapSource.filename)
        .filter(MapSource.society_id == society_id)
        .all()
    ]

    # Delete dependents child-first so no foreign key is left dangling.
    db.query(Agreement).filter(Agreement.society_id == society_id).delete(
        synchronize_session=False
    )
    db.query(Offer).filter(Offer.society_id == society_id).delete(
        synchronize_session=False
    )
    db.query(Listing).filter(Listing.society_id == society_id).delete(
        synchronize_session=False
    )
    if claim_ids:
        db.query(ClaimEvidence).filter(ClaimEvidence.claim_id.in_(claim_ids)).delete(
            synchronize_session=False
        )
    db.query(Claim).filter(Claim.society_id == society_id).delete(
        synchronize_session=False
    )
    db.query(Block).filter(Block.society_id == society_id).delete(
        synchronize_session=False
    )
    db.query(Plot).filter(Plot.society_id == society_id).delete(
        synchronize_session=False
    )
    db.query(MapSource).filter(MapSource.society_id == society_id).delete(
        synchronize_session=False
    )
    db.query(Membership).filter(Membership.society_id == society_id).delete(
        synchronize_session=False
    )
    db.query(Society).filter(Society.id == society_id).delete(
        synchronize_session=False
    )
    db.commit()

    for fn in evidence_files:
        try:
            os.remove(os.path.join(settings.evidence_dir, fn))
        except OSError:
            pass
    for fn in map_files:
        try:
            os.remove(os.path.join(settings.upload_dir, fn))
        except OSError:
            pass


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


# ---------- Ownership claims ----------

ALLOWED_EVIDENCE_TYPES = {"image/png", "image/jpeg", "image/jpg", "application/pdf"}


def claim_to_out(c: Claim) -> ClaimOut:
    return ClaimOut(
        id=c.id,
        society_id=c.society_id,
        status=c.status,
        note=c.note,
        review_note=c.review_note,
        created_at=c.created_at,
        reviewed_at=c.reviewed_at,
        plot=ClaimPlotRef.model_validate(c.plot, from_attributes=True),
        claimant=ClaimantOut.model_validate(c.user, from_attributes=True),
        evidence=[
            ClaimEvidenceOut.model_validate(e, from_attributes=True) for e in c.evidence
        ],
    )


def _recompute_plot_status(db: Session, plot: Plot):
    """Reflect pending claims in the plot status (unless already owned/sold)."""
    if plot.owner_id is not None or plot.status in (PlotStatus.sold,):
        return
    has_pending = (
        db.query(Claim)
        .filter(Claim.plot_id == plot.id, Claim.status == ClaimStatus.pending)
        .first()
        is not None
    )
    if plot.status in (PlotStatus.unclaimed, PlotStatus.claim_pending):
        plot.status = (
            PlotStatus.claim_pending if has_pending else PlotStatus.unclaimed
        )


def _get_claim_for_access(claim_id: int, user: User, db: Session) -> Claim:
    claim = db.get(Claim, claim_id)
    if not claim:
        raise HTTPException(status_code=404, detail="Claim not found")
    if claim.user_id != user.id and not is_society_admin(db, user, claim.society_id):
        raise HTTPException(status_code=403, detail="Not allowed")
    return claim


@app.post("/api/plots/{plot_id}/claims", response_model=ClaimOut, status_code=201)
def create_claim(
    plot_id: int,
    payload: ClaimCreate,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Any signed-in user claims ownership of a confirmed plot."""
    plot = db.get(Plot, plot_id)
    if not plot or not plot.confirmed:
        raise HTTPException(status_code=404, detail="Plot not found")
    if plot.owner_id is not None or plot.status in (PlotStatus.owned, PlotStatus.sold):
        raise HTTPException(status_code=409, detail="Plot is already owned")
    existing = (
        db.query(Claim)
        .filter(
            Claim.plot_id == plot_id,
            Claim.user_id == user.id,
            Claim.status == ClaimStatus.pending,
        )
        .first()
    )
    if existing:
        raise HTTPException(
            status_code=409, detail="You already have a pending claim on this plot"
        )
    claim = Claim(
        plot_id=plot_id,
        society_id=plot.society_id,
        user_id=user.id,
        note=payload.note,
        status=ClaimStatus.pending,
    )
    db.add(claim)
    if plot.status == PlotStatus.unclaimed:
        plot.status = PlotStatus.claim_pending
    db.commit()
    db.refresh(claim)
    return claim_to_out(claim)


@app.post("/api/claims/{claim_id}/evidence", response_model=ClaimOut, status_code=201)
def upload_evidence(
    claim_id: int,
    file: UploadFile = File(...),
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Claimant attaches a supporting document/image to their pending claim."""
    claim = db.get(Claim, claim_id)
    if not claim:
        raise HTTPException(status_code=404, detail="Claim not found")
    if claim.user_id != user.id:
        raise HTTPException(status_code=403, detail="Not your claim")
    if claim.status != ClaimStatus.pending:
        raise HTTPException(status_code=409, detail="Claim is no longer pending")
    if file.content_type not in ALLOWED_EVIDENCE_TYPES:
        raise HTTPException(
            status_code=400, detail="Only PNG/JPEG images or PDF documents are allowed"
        )

    ext = os.path.splitext(file.filename or "")[1].lower() or ".bin"
    stored = f"{uuid.uuid4().hex}{ext}"
    path = os.path.join(settings.evidence_dir, stored)
    with open(path, "wb") as f:
        f.write(file.file.read())

    db.add(
        ClaimEvidence(
            claim_id=claim.id,
            filename=stored,
            original_name=file.filename,
            content_type=file.content_type,
        )
    )
    db.commit()
    db.refresh(claim)
    return claim_to_out(claim)


@app.get("/api/me/claims", response_model=list[ClaimOut])
def my_claims(
    user: User = Depends(get_current_user), db: Session = Depends(get_db)
):
    claims = (
        db.query(Claim)
        .filter(Claim.user_id == user.id)
        .order_by(Claim.id.desc())
        .all()
    )
    return [claim_to_out(c) for c in claims]


@app.get("/api/claims/{claim_id}", response_model=ClaimOut)
def get_claim(
    claim_id: int,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    return claim_to_out(_get_claim_for_access(claim_id, user, db))


@app.get("/api/claims/{claim_id}/evidence/{evidence_id}")
def download_evidence(
    claim_id: int,
    evidence_id: int,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Serve a private evidence file to the claimant or a society admin only."""
    claim = _get_claim_for_access(claim_id, user, db)
    ev = db.get(ClaimEvidence, evidence_id)
    if not ev or ev.claim_id != claim.id:
        raise HTTPException(status_code=404, detail="Evidence not found")
    path = os.path.join(settings.evidence_dir, ev.filename)
    if not os.path.exists(path):
        raise HTTPException(status_code=404, detail="File missing")
    return FileResponse(
        path, media_type=ev.content_type or "application/octet-stream",
        filename=ev.original_name or ev.filename,
    )


@app.get("/api/societies/{society_id}/claims", response_model=list[ClaimOut])
def list_society_claims(
    society_id: int,
    status: ClaimStatus | None = None,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Admin: claims for a society, newest first, optionally filtered by status."""
    if not is_society_admin(db, user, society_id):
        raise HTTPException(status_code=403, detail="Requires society admin")
    q = db.query(Claim).filter(Claim.society_id == society_id)
    if status is not None:
        q = q.filter(Claim.status == status)
    return [claim_to_out(c) for c in q.order_by(Claim.id.desc()).all()]


@app.post("/api/claims/{claim_id}/review", response_model=ClaimOut)
def review_claim(
    claim_id: int,
    payload: ClaimReview,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Admin approves or rejects a pending claim. Approving transfers ownership
    and auto-rejects other pending claims on the same plot."""
    claim = db.get(Claim, claim_id)
    if not claim:
        raise HTTPException(status_code=404, detail="Claim not found")
    if not is_society_admin(db, user, claim.society_id):
        raise HTTPException(status_code=403, detail="Requires society admin")
    if claim.status != ClaimStatus.pending:
        raise HTTPException(status_code=409, detail="Claim already reviewed")

    decision = payload.decision.lower()
    if decision not in ("approve", "reject"):
        raise HTTPException(status_code=400, detail="decision must be approve or reject")

    plot = db.get(Plot, claim.plot_id)
    claim.reviewed_by = user.id
    claim.reviewed_at = func.now()
    claim.review_note = payload.note

    if decision == "approve":
        if plot.owner_id is not None:
            raise HTTPException(status_code=409, detail="Plot is already owned")
        claim.status = ClaimStatus.approved
        plot.owner_id = claim.user_id
        plot.status = PlotStatus.owned
        # Auto-reject competing pending claims on the same plot.
        others = (
            db.query(Claim)
            .filter(
                Claim.plot_id == plot.id,
                Claim.id != claim.id,
                Claim.status == ClaimStatus.pending,
            )
            .all()
        )
        for o in others:
            o.status = ClaimStatus.rejected
            o.reviewed_by = user.id
            o.reviewed_at = func.now()
            o.review_note = "Another claim on this plot was approved"
    else:
        claim.status = ClaimStatus.rejected
        _recompute_plot_status(db, plot)

    db.commit()
    db.refresh(claim)
    return claim_to_out(claim)


@app.post("/api/claims/{claim_id}/withdraw", response_model=ClaimOut)
def withdraw_claim(
    claim_id: int,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    claim = db.get(Claim, claim_id)
    if not claim:
        raise HTTPException(status_code=404, detail="Claim not found")
    if claim.user_id != user.id:
        raise HTTPException(status_code=403, detail="Not your claim")
    if claim.status != ClaimStatus.pending:
        raise HTTPException(status_code=409, detail="Claim is no longer pending")
    claim.status = ClaimStatus.withdrawn
    plot = db.get(Plot, claim.plot_id)
    _recompute_plot_status(db, plot)
    db.commit()
    db.refresh(claim)
    return claim_to_out(claim)


# ---------- Marketplace: listings ----------


def listing_to_out(listing: Listing) -> ListingOut:
    out = ListingOut.model_validate(listing, from_attributes=True)
    out.plot = ClaimPlotRef.model_validate(listing.plot, from_attributes=True)
    return out


def offer_to_out(o: Offer) -> OfferOut:
    return OfferOut(
        id=o.id,
        listing_id=o.listing_id,
        plot=ClaimPlotRef.model_validate(o.listing.plot, from_attributes=True),
        asking_price=o.listing.asking_price,
        amount=o.amount,
        message=o.message,
        proposed_by=o.proposed_by,
        status=o.status,
        counters_used=o.counters_used,
        counter_limit=o.listing.counter_limit,
        buyer=OfferParty.model_validate(o.buyer, from_attributes=True),
        created_at=o.created_at,
        updated_at=o.updated_at,
    )


def agreement_to_out(a: Agreement) -> AgreementOut:
    return AgreementOut(
        id=a.id,
        plot=ClaimPlotRef.model_validate(a.plot, from_attributes=True),
        society_id=a.society_id,
        amount=a.amount,
        status=a.status,
        review_note=a.review_note,
        created_at=a.created_at,
        reviewed_at=a.reviewed_at,
        buyer=OfferParty.model_validate(a.buyer, from_attributes=True),
        owner=OfferParty.model_validate(a.owner, from_attributes=True),
    )


def _active_listing(db: Session, plot_id: int) -> Listing | None:
    return (
        db.query(Listing)
        .filter(
            Listing.plot_id == plot_id,
            Listing.status.in_([ListingStatus.active, ListingStatus.agreed]),
        )
        .order_by(Listing.id.desc())
        .first()
    )


@app.post("/api/plots/{plot_id}/listing", response_model=ListingOut, status_code=201)
def create_listing(
    plot_id: int,
    payload: ListingCreate,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """The plot owner lists it for sale."""
    plot = db.get(Plot, plot_id)
    if not plot or not plot.confirmed:
        raise HTTPException(status_code=404, detail="Plot not found")
    if plot.owner_id != user.id:
        raise HTTPException(status_code=403, detail="Only the owner can list this plot")
    if _active_listing(db, plot_id):
        raise HTTPException(status_code=409, detail="Plot already has an active listing")
    if payload.floor_price and payload.floor_price > payload.asking_price:
        raise HTTPException(
            status_code=400, detail="Floor price cannot exceed the asking price"
        )
    society = db.get(Society, plot.society_id)
    listing = Listing(
        plot_id=plot_id,
        society_id=plot.society_id,
        owner_id=user.id,
        asking_price=payload.asking_price,
        floor_price=payload.floor_price,
        description=payload.description,
        counter_limit=society.default_counter_limit if society else 3,
        status=ListingStatus.active,
    )
    db.add(listing)
    plot.status = PlotStatus.listed
    db.commit()
    db.refresh(listing)
    return listing_to_out(listing)


@app.get("/api/plots/{plot_id}/listing", response_model=ListingPublicOut)
def get_plot_listing(plot_id: int, db: Session = Depends(get_db)):
    """Public: the active listing for a plot (no floor price)."""
    listing = _active_listing(db, plot_id)
    if not listing:
        raise HTTPException(status_code=404, detail="No active listing")
    return ListingPublicOut.model_validate(listing, from_attributes=True)


@app.get("/api/me/plots", response_model=list[ClaimPlotRef])
def my_plots(user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    """Plots the current user owns (approved claim / purchased)."""
    return (
        db.query(Plot)
        .filter(Plot.owner_id == user.id)
        .order_by(Plot.id)
        .all()
    )


@app.get("/api/me/listings", response_model=list[ListingOut])
def my_listings(user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    listings = (
        db.query(Listing)
        .filter(Listing.owner_id == user.id)
        .order_by(Listing.id.desc())
        .all()
    )
    return [listing_to_out(x) for x in listings]


def _owned_listing(db: Session, listing_id: int, user: User) -> Listing:
    listing = db.get(Listing, listing_id)
    if not listing:
        raise HTTPException(status_code=404, detail="Listing not found")
    if listing.owner_id != user.id:
        raise HTTPException(status_code=403, detail="Not your listing")
    return listing


@app.patch("/api/listings/{listing_id}", response_model=ListingOut)
def update_listing(
    listing_id: int,
    payload: ListingUpdate,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    listing = _owned_listing(db, listing_id, user)
    if listing.status != ListingStatus.active:
        raise HTTPException(status_code=409, detail="Listing is not active")
    data = payload.model_dump(exclude_unset=True)
    for field, value in data.items():
        setattr(listing, field, value)
    if listing.floor_price and listing.floor_price > listing.asking_price:
        raise HTTPException(
            status_code=400, detail="Floor price cannot exceed the asking price"
        )
    db.commit()
    db.refresh(listing)
    return listing_to_out(listing)


@app.post("/api/listings/{listing_id}/withdraw", response_model=ListingOut)
def withdraw_listing(
    listing_id: int,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    listing = _owned_listing(db, listing_id, user)
    if listing.status == ListingStatus.sold:
        raise HTTPException(status_code=409, detail="Listing already sold")
    listing.status = ListingStatus.withdrawn
    for o in db.query(Offer).filter(
        Offer.listing_id == listing.id, Offer.status == OfferStatus.pending
    ):
        o.status = OfferStatus.rejected
    plot = db.get(Plot, listing.plot_id)
    if plot.owner_id is not None and plot.status != PlotStatus.sold:
        plot.status = PlotStatus.owned
    db.commit()
    db.refresh(listing)
    return listing_to_out(listing)


@app.post("/api/listings/{listing_id}/reset-counters", response_model=ListingOut)
def reset_counters(
    listing_id: int,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Owner reopens negotiation room by clearing the counter tally on pending
    offers of this listing."""
    listing = _owned_listing(db, listing_id, user)
    for o in db.query(Offer).filter(
        Offer.listing_id == listing.id, Offer.status == OfferStatus.pending
    ):
        o.counters_used = 0
    db.commit()
    db.refresh(listing)
    return listing_to_out(listing)


# ---------- Marketplace: offers ----------


def _offer_parties(db: Session, offer: Offer):
    """Return (listing, is_owner, is_buyer) for the current user context."""
    listing = offer.listing
    return listing, listing.owner_id, offer.buyer_id


@app.post("/api/listings/{listing_id}/offers", response_model=OfferOut, status_code=201)
def make_offer(
    listing_id: int,
    payload: OfferCreate,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    listing = db.get(Listing, listing_id)
    if not listing or listing.status != ListingStatus.active:
        raise HTTPException(status_code=404, detail="Listing not open for offers")
    if listing.owner_id == user.id:
        raise HTTPException(status_code=400, detail="You can't offer on your own listing")
    if listing.floor_price and payload.amount < listing.floor_price:
        raise HTTPException(
            status_code=400, detail="Offer is below the seller's minimum price"
        )
    existing = (
        db.query(Offer)
        .filter(
            Offer.listing_id == listing_id,
            Offer.buyer_id == user.id,
            Offer.status == OfferStatus.pending,
        )
        .first()
    )
    if existing:
        raise HTTPException(status_code=409, detail="You already have an active offer")
    offer = Offer(
        listing_id=listing_id,
        plot_id=listing.plot_id,
        society_id=listing.society_id,
        buyer_id=user.id,
        amount=payload.amount,
        message=payload.message,
        proposed_by=Party.buyer,
        status=OfferStatus.pending,
    )
    db.add(offer)
    db.commit()
    db.refresh(offer)
    return offer_to_out(offer)


@app.get("/api/me/offers", response_model=list[OfferOut])
def my_offers(user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    offers = (
        db.query(Offer)
        .filter(Offer.buyer_id == user.id)
        .order_by(Offer.id.desc())
        .all()
    )
    return [offer_to_out(o) for o in offers]


@app.get("/api/listings/{listing_id}/offers", response_model=list[OfferOut])
def listing_offers(
    listing_id: int,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    listing = _owned_listing(db, listing_id, user)
    offers = (
        db.query(Offer)
        .filter(Offer.listing_id == listing.id)
        .order_by(Offer.id.desc())
        .all()
    )
    return [offer_to_out(o) for o in offers]


def _load_pending_offer(db: Session, offer_id: int) -> Offer:
    offer = db.get(Offer, offer_id)
    if not offer:
        raise HTTPException(status_code=404, detail="Offer not found")
    return offer


def _responder_ok(offer: Offer, user: User) -> bool:
    """Only the party who did NOT make the current proposal may respond."""
    if offer.proposed_by == Party.buyer:
        return user.id == offer.listing.owner_id
    return user.id == offer.buyer_id


@app.post("/api/offers/{offer_id}/counter", response_model=OfferOut)
def counter_offer(
    offer_id: int,
    payload: OfferAmount,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    offer = _load_pending_offer(db, offer_id)
    if offer.status != OfferStatus.pending:
        raise HTTPException(status_code=409, detail="Offer is not open")
    if not _responder_ok(offer, user):
        raise HTTPException(status_code=403, detail="It's not your turn to respond")
    if offer.counters_used >= offer.listing.counter_limit:
        raise HTTPException(
            status_code=409,
            detail="Counter-offer limit reached; accept or reject (owner can reset)",
        )
    actor = Party.owner if user.id == offer.listing.owner_id else Party.buyer
    if actor == Party.buyer and offer.listing.floor_price and payload.amount < offer.listing.floor_price:
        raise HTTPException(
            status_code=400, detail="Offer is below the seller's minimum price"
        )
    offer.amount = payload.amount
    offer.message = payload.message
    offer.proposed_by = actor
    offer.counters_used += 1
    db.commit()
    db.refresh(offer)
    return offer_to_out(offer)


@app.post("/api/offers/{offer_id}/accept", response_model=OfferOut)
def accept_offer(
    offer_id: int,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    offer = _load_pending_offer(db, offer_id)
    if offer.status != OfferStatus.pending:
        raise HTTPException(status_code=409, detail="Offer is not open")
    if not _responder_ok(offer, user):
        raise HTTPException(status_code=403, detail="It's not your turn to respond")
    listing = offer.listing
    offer.status = OfferStatus.accepted
    listing.status = ListingStatus.agreed
    plot = db.get(Plot, offer.plot_id)
    plot.status = PlotStatus.under_offer
    # Auto-reject competing pending offers.
    for o in db.query(Offer).filter(
        Offer.listing_id == listing.id,
        Offer.id != offer.id,
        Offer.status == OfferStatus.pending,
    ):
        o.status = OfferStatus.rejected
    db.add(
        Agreement(
            offer_id=offer.id,
            listing_id=listing.id,
            plot_id=offer.plot_id,
            society_id=offer.society_id,
            buyer_id=offer.buyer_id,
            owner_id=listing.owner_id,
            amount=offer.amount,
            status=AgreementStatus.pending,
        )
    )
    db.commit()
    db.refresh(offer)
    return offer_to_out(offer)


@app.post("/api/offers/{offer_id}/reject", response_model=OfferOut)
def reject_offer(
    offer_id: int,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    offer = _load_pending_offer(db, offer_id)
    if offer.status != OfferStatus.pending:
        raise HTTPException(status_code=409, detail="Offer is not open")
    if user.id not in (offer.buyer_id, offer.listing.owner_id):
        raise HTTPException(status_code=403, detail="Not part of this negotiation")
    offer.status = OfferStatus.rejected
    db.commit()
    db.refresh(offer)
    return offer_to_out(offer)


@app.post("/api/offers/{offer_id}/withdraw", response_model=OfferOut)
def withdraw_offer(
    offer_id: int,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    offer = _load_pending_offer(db, offer_id)
    if offer.buyer_id != user.id:
        raise HTTPException(status_code=403, detail="Not your offer")
    if offer.status != OfferStatus.pending:
        raise HTTPException(status_code=409, detail="Offer is not open")
    offer.status = OfferStatus.withdrawn
    db.commit()
    db.refresh(offer)
    return offer_to_out(offer)


# ---------- Marketplace: agreements & contact reveal ----------


@app.get("/api/me/agreements", response_model=list[AgreementOut])
def my_agreements(user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    rows = (
        db.query(Agreement)
        .filter((Agreement.buyer_id == user.id) | (Agreement.owner_id == user.id))
        .order_by(Agreement.id.desc())
        .all()
    )
    return [agreement_to_out(a) for a in rows]


@app.get("/api/societies/{society_id}/agreements", response_model=list[AgreementOut])
def list_society_agreements(
    society_id: int,
    status: AgreementStatus | None = None,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    if not is_society_admin(db, user, society_id):
        raise HTTPException(status_code=403, detail="Requires society admin")
    q = db.query(Agreement).filter(Agreement.society_id == society_id)
    if status is not None:
        q = q.filter(Agreement.status == status)
    return [agreement_to_out(a) for a in q.order_by(Agreement.id.desc()).all()]


@app.post("/api/agreements/{agreement_id}/review", response_model=AgreementOut)
def review_agreement(
    agreement_id: int,
    payload: AgreementReview,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Admin approves the deal (transfers ownership, reveals contacts) or rejects
    it (the listing returns to active)."""
    a = db.get(Agreement, agreement_id)
    if not a:
        raise HTTPException(status_code=404, detail="Agreement not found")
    if not is_society_admin(db, user, a.society_id):
        raise HTTPException(status_code=403, detail="Requires society admin")
    if a.status != AgreementStatus.pending:
        raise HTTPException(status_code=409, detail="Agreement already reviewed")

    decision = payload.decision.lower()
    if decision not in ("approve", "reject"):
        raise HTTPException(status_code=400, detail="decision must be approve or reject")

    a.admin_id = user.id
    a.reviewed_at = func.now()
    a.review_note = payload.note
    listing = db.get(Listing, a.listing_id)
    plot = db.get(Plot, a.plot_id)
    offer = db.get(Offer, a.offer_id)

    if decision == "approve":
        a.status = AgreementStatus.approved
        listing.status = ListingStatus.sold
        plot.status = PlotStatus.sold
        plot.owner_id = a.buyer_id  # ownership transfers to the buyer
    else:
        a.status = AgreementStatus.rejected
        listing.status = ListingStatus.active
        plot.status = PlotStatus.listed
        if offer:
            offer.status = OfferStatus.rejected

    db.commit()
    db.refresh(a)
    return agreement_to_out(a)


@app.get("/api/agreements/{agreement_id}/contact", response_model=ContactReveal)
def reveal_contact(
    agreement_id: int,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Both parties see each other's contact details once an admin approves."""
    a = db.get(Agreement, agreement_id)
    if not a:
        raise HTTPException(status_code=404, detail="Agreement not found")
    if user.id not in (a.buyer_id, a.owner_id):
        raise HTTPException(status_code=403, detail="Not part of this agreement")
    if a.status != AgreementStatus.approved:
        raise HTTPException(
            status_code=403, detail="Contact is revealed after admin approval"
        )
    owner = db.get(User, a.owner_id)
    buyer = db.get(User, a.buyer_id)
    return ContactReveal(
        owner=ContactCard(
            role="owner", full_name=owner.full_name, email=owner.email, phone=owner.phone
        ),
        buyer=ContactCard(
            role="buyer", full_name=buyer.full_name, email=buyer.email, phone=buyer.phone
        ),
        amount=a.amount,
    )
