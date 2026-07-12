"""Seed the database with one society and a grid of sample plots.

Run inside the backend container:
    docker compose exec backend python -m app.seed
"""

from geoalchemy2.shape import from_shape
from shapely.geometry import Polygon

from .database import SessionLocal, init_db
from .models import Plot, PlotStatus, PlotType, Society

# Approx center of a DHA-style block in Lahore, PK.
CENTER_LAT = 31.4805
CENTER_LNG = 74.4200

# Plot footprint in degrees (~roughly a small residential plot).
PLOT_W = 0.00045
PLOT_H = 0.00035
GAP = 0.00008

ROWS = 5
COLS = 6

STATUSES = [
    PlotStatus.unclaimed,
    PlotStatus.owned,
    PlotStatus.listed,
    PlotStatus.under_offer,
    PlotStatus.sold,
]
TYPES = [PlotType.residential, PlotType.commercial, PlotType.amenity]


def make_polygon(lng0: float, lat0: float) -> Polygon:
    return Polygon(
        [
            (lng0, lat0),
            (lng0 + PLOT_W, lat0),
            (lng0 + PLOT_W, lat0 + PLOT_H),
            (lng0, lat0 + PLOT_H),
            (lng0, lat0),
        ]
    )


def run():
    init_db()
    db = SessionLocal()
    try:
        if db.query(Society).count() > 0:
            print("Data already present; skipping seed.")
            return

        society = Society(
            name="Green Valley Housing Society",
            region="Lahore, Punjab",
            center_lat=CENTER_LAT,
            center_lng=CENTER_LNG,
            default_zoom=17,
            status="active",
        )
        db.add(society)
        db.flush()  # get society.id

        origin_lng = CENTER_LNG - (COLS * (PLOT_W + GAP)) / 2
        origin_lat = CENTER_LAT - (ROWS * (PLOT_H + GAP)) / 2

        n = 0
        for r in range(ROWS):
            for c in range(COLS):
                lng0 = origin_lng + c * (PLOT_W + GAP)
                lat0 = origin_lat + r * (PLOT_H + GAP)
                poly = make_polygon(lng0, lat0)

                status = STATUSES[(r + c) % len(STATUSES)]
                ptype = TYPES[(r * COLS + c) % len(TYPES)]
                n += 1

                plot = Plot(
                    society_id=society.id,
                    block=f"Block-{chr(65 + r)}",
                    plot_no=str(c + 1),
                    plot_type=ptype,
                    status=status,
                    area_sqft=round(5 * 272.25, 2),  # ~5 marla
                    min_price=8_500_000 if status != PlotStatus.unclaimed else None,
                    source="manual",
                    confirmed=True,  # seed data is public immediately
                    geom=from_shape(poly, srid=4326),
                )
                db.add(plot)

        db.commit()
        print(f"Seeded society '{society.name}' with {n} plots.")
    finally:
        db.close()


if __name__ == "__main__":
    run()
