# Property Map Platform

Turn a society map drawing into georeferenced property polygons over OpenStreetMap,
with ownership claims, price-limited offers, and admin-approved contact reveal.

See [docs/SPECIFICATION.md](docs/SPECIFICATION.md) for the full plan.

## Stack
- **Backend:** Python + FastAPI, PostgreSQL + PostGIS (both in Docker)
- **Frontend:** React + Vite + react-leaflet (runs on host Node)

## Local setup

Requirements: Docker Desktop + Node.js (Python is **not** needed — it runs in Docker).

### 1. Start database + backend
```bash
docker compose up --build
```
Backend: http://localhost:8000  (docs at /docs) · DB on localhost:5432

### 2. Seed sample data (once, in another terminal)
```bash
docker compose exec backend python -m app.seed
```

### 3. Start the frontend
```bash
cd frontend
npm install
npm run dev
```
Open http://localhost:5173

## What works now (Phase 1 vertical slice)
- PostGIS-backed `Society` + `Plot` model
- OSM map centered on the active society
- Property overlay colored by status, hover highlight + tooltip
- Click a plot → side panel with type, area (sq ft; kanal/marla on hover), price (PKR)

## Next phases
Auth + society-scoped roles · map upload + georeference · hybrid OpenCV extraction ·
ownership claims + admin validation · offers + counter cap/reset · agreement + reveal.
