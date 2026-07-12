import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { MapContainer, GeoJSON, Marker, useMap, useMapEvents } from "react-leaflet";
import L from "leaflet";
import "@geoman-io/leaflet-geoman-free";
import "@geoman-io/leaflet-geoman-free/dist/leaflet-geoman.css";
import { api } from "../api.js";
import RotatedOverlay from "../RotatedOverlay.jsx";
import BaseLayer from "../BaseLayer.jsx";
import QuadEditor from "./QuadEditor.jsx";
import { formatSize } from "../status.js";
import {
  pixelToLatLng,
  subdivideQuad,
  normalizeQuad,
  quadVertexGrid,
  cellsFromGrid,
} from "../geo.js";

const ringToGeometry = (cs) => ({ type: "Polygon", coordinates: [[...cs, cs[0]]] });

// A drawn shape is subdividable if its ring is a single quad (4 unique corners).
function quadCorners(geometry) {
  if (!geometry || geometry.type !== "Polygon") return null;
  const ring = geometry.coordinates[0];
  const pts = ring.slice(0, ring.length - 1); // drop closing point
  return pts.length === 4 ? pts : null; // [ [lng,lat] x4 ]
}

// Mesh editor: a draggable handle at every subdivision vertex. Moving a shared
// (interior) vertex reshapes all adjacent plots together, so blocks can become
// irregular without gaps.
const vertexIcon = L.divIcon({
  className: "mesh-vert",
  iconSize: [12, 12],
  iconAnchor: [6, 6],
});
function MeshEditor({ verts, onChange, snapTargets }) {
  const map = useMap();
  const SNAP_PX = 12;

  // Snap a dragged vertex onto a nearby neighbor-block vertex (within SNAP_PX).
  const snap = (latlng) => {
    if (!snapTargets || !snapTargets.length) return latlng;
    const dp = map.latLngToLayerPoint(latlng);
    let best = null;
    let bestD = SNAP_PX;
    for (const t of snapTargets) {
      if (Math.abs(t[0] - latlng.lng) > 0.002 || Math.abs(t[1] - latlng.lat) > 0.002) continue;
      const tp = map.latLngToLayerPoint(L.latLng(t[1], t[0]));
      const d = Math.hypot(tp.x - dp.x, tp.y - dp.y);
      if (d < bestD) {
        bestD = d;
        best = t;
      }
    }
    return best ? L.latLng(best[1], best[0]) : latlng;
  };

  const setVert = (r, c, latlng) => {
    const s = snap(latlng);
    const next = verts.map((row) => row.slice());
    next[r][c] = [s.lng, s.lat];
    onChange(next);
  };
  const markers = [];
  for (let r = 0; r < verts.length; r++) {
    for (let c = 0; c < verts[r].length; c++) {
      markers.push(
        <Marker
          key={`${r}-${c}`}
          position={[verts[r][c][1], verts[r][c][0]]}
          icon={vertexIcon}
          draggable
          eventHandlers={{
            drag: (e) => setVert(r, c, e.target.getLatLng()),
            dragend: (e) => setVert(r, c, e.target.getLatLng()),
          }}
        />
      );
    }
  }
  return <>{markers}</>;
}

// Clicking empty map background clears the current selection.
function DeselectOnClick({ onDeselect }) {
  useMapEvents({ click: () => onDeselect() });
  return null;
}

function polygonCentroid(geometry) {
  const ring = geometry.coordinates[0];
  const n = ring.length - 1; // drop closing point
  let x = 0;
  let y = 0;
  for (let i = 0; i < n; i++) {
    x += ring[i][0];
    y += ring[i][1];
  }
  return [y / n, x / n]; // [lat, lng]
}
const labelIcon = (no) =>
  L.divIcon({ className: "plot-label", html: `<span>${no}</span>`, iconSize: [0, 0] });

// Level-of-detail plot-number labels: only render for plots in the current
// viewport, and only when few enough are visible (i.e. zoomed in). Re-renders
// on pan/zoom.
function PlotLabels({ features, cap = 350 }) {
  const map = useMap();
  const [, tick] = useState(0);
  useMapEvents({ moveend: () => tick((v) => v + 1), zoomend: () => tick((v) => v + 1) });

  const bounds = map.getBounds();
  const inView = [];
  for (const f of features) {
    const p = f.properties;
    if (p.plot_no == null) continue;
    const pos = polygonCentroid(f.geometry);
    if (bounds.contains(pos)) {
      inView.push({ id: p.id, pos, no: p.plot_no });
      if (inView.length > cap) return null; // too dense (zoomed out) — skip labels
    }
  }
  return (
    <>
      {inView.map((v) => (
        <Marker key={v.id} position={v.pos} icon={labelIcon(v.no)} interactive={false} />
      ))}
    </>
  );
}

// Editable single-plot shape: Geoman vertex editing (drag corners, add vertices
// via midpoint handles). Exposes the live layer through layerRef for saving.
function ShapeEditor({ geometry, layerRef }) {
  const map = useMap();
  useEffect(() => {
    const layer = L.geoJSON(
      { type: "Feature", geometry, properties: {} },
      { style: { color: "#ea580c", weight: 3, fillColor: "#f97316", fillOpacity: 0.25 } }
    ).getLayers()[0];
    layer.addTo(map);
    try {
      layer.pm.enable({ allowSelfIntersection: false });
    } catch {
      /* geoman edit unavailable */
    }
    layerRef.current = layer;
    return () => {
      try {
        layer.pm.disable();
      } catch {
        /* noop */
      }
      try {
        map.removeLayer(layer);
        layer.remove();
      } catch {
        /* noop */
      }
      layerRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map]);
  return null;
}

// On first load, frame the georeferenced drawing rather than the society center.
function FitToContent({ transform, width, height }) {
  const lmap = useMap();
  const done = useRef(false);
  useEffect(() => {
    if (done.current || !transform) return;
    done.current = true;
    const corners = [
      pixelToLatLng(transform, 0, 0),
      pixelToLatLng(transform, width, 0),
      pixelToLatLng(transform, 0, height),
      pixelToLatLng(transform, width, height),
    ];
    lmap.fitBounds(corners, { padding: [30, 30] });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  return null;
}

const TYPE_COLORS = {
  residential: "#3b82f6",
  commercial: "#f59e0b",
  agricultural: "#84cc16",
  amenity: "#14b8a6",
  other: "#94a3b8",
};

const EMPTY_FORM = {
  block: "",
  street: "",
  plot_no: "",
  plot_type: "residential",
  sizeW: "",
  sizeD: "",
  min_price: "",
};

// Adds Geoman polygon/rectangle drawing tools and reports created shapes.
function DrawTools({ onCreate }) {
  const map = useMap();
  useEffect(() => {
    map.pm.addControls({
      position: "topleft",
      drawMarker: false,
      drawCircleMarker: false,
      drawPolyline: false,
      drawCircle: false,
      drawText: false,
      drawRectangle: true,
      drawPolygon: true,
      editMode: false,
      dragMode: false,
      cutPolygon: false,
      removalMode: false,
      rotateMode: false,
    });
    // Don't keep drawing after one shape, and don't leave the drawn source layer
    // on the map (we replace it with our own quad editor).
    map.pm.setGlobalOptions({ continueDrawing: false });
    const handler = (e) => {
      map.pm.disableDraw();
      onCreate(e.layer);
    };
    map.on("pm:create", handler);
    return () => {
      map.off("pm:create", handler);
      try {
        map.pm.removeControls();
      } catch {
        /* map already torn down */
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map]);
  return null;
}

export default function ExtractPage() {
  const { mapId } = useParams();
  const [map, setMap] = useState(null);
  const [society, setSociety] = useState(null);
  const [plots, setPlots] = useState(null); // FeatureCollection
  const [version, setVersion] = useState(0);
  const [opacity, setOpacity] = useState(0.5);
  const [form, setForm] = useState(EMPTY_FORM);
  const [pending, setPending] = useState(null); // GeoJSON geometry awaiting save
  const [corners, setCorners] = useState(null); // [lng,lat] x4 if quad, else null
  const [mode, setMode] = useState("single"); // 'single' | 'subdivide'
  const [sub, setSub] = useState({
    rows: "2",
    cols: "10",
    sizeW: "60", // stated plot size (ft), applied to all plots — not calculated
    sizeD: "90",
    block: "",
    street: "",
    startNo: "1",
    colInc: "1", // number added per column step (across)
    rowInc: "", // per row step (down); blank = auto-continue (cols * colInc)
    revH: false, // start-corner horizontal (right -> left)
    revV: false, // start-corner vertical (bottom -> top)
    plot_type: "residential",
  });
  const [selected, setSelected] = useState(null); // clicked plot properties
  const [editing, setEditing] = useState(false);
  const [edit, setEdit] = useState({});
  const [shapeEdit, setShapeEdit] = useState(null); // { id, geometry } while editing a plot's shape
  const shapeLayerRef = useRef(null);
  const [blockEdit, setBlockEdit] = useState(null); // { id, rows, cols } while re-tiling a block
  const [blockVerts, setBlockVerts] = useState(null); // editable vertex grid
  const [error, setError] = useState(null);
  const [msg, setMsg] = useState(null);
  const [saving, setSaving] = useState(false);
  const [autoBusy, setAutoBusy] = useState(false);
  const [undoStack, setUndoStack] = useState([]); // recent creations, for undo
  const [q, setQ] = useState(""); // plot list search
  const [fStatus, setFStatus] = useState("all"); // all | draft | live
  const [fType, setFType] = useState("all");
  const [showNumbers, setShowNumbers] = useState(true); // plot-number labels on map
  const pendingLayer = useRef(null);

  const refreshPlots = () =>
    api.listMapPlots(mapId).then((fc) => {
      setPlots(fc);
      setVersion((v) => v + 1);
    });

  useEffect(() => {
    api
      .getMap(mapId)
      .then((m) => {
        setMap(m);
        return api.getSociety(m.society_id).then(setSociety);
      })
      .then(refreshPlots)
      .catch((e) => setError(e.message));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mapId]);

  const onCreate = (layer) => {
    const geom = layer.toGeoJSON().geometry;
    const quad = quadCorners(geom);
    setMsg(null);
    if (quad) {
      // A 4-corner block: manage it with our own editor (corner/edge/rotate handles).
      // Normalize once here so the numbering origin is predictable but then stays
      // fixed to the block through rotation.
      const norm = normalizeQuad(quad);
      layer.remove();
      pendingLayer.current = null;
      setCorners(norm);
      setPending(ringToGeometry(norm));
      setMode("subdivide");
    } else {
      // Irregular polygon -> single plot; keep Geoman's layer + vertex editing.
      pendingLayer.current = layer;
      setCorners(null);
      setPending(geom);
      setMode("single");
      try {
        layer.pm.enable({ allowSelfIntersection: false });
      } catch {
        /* geoman edit unavailable */
      }
      ["pm:edit", "pm:markerdragend", "pm:update"].forEach((ev) =>
        layer.on(ev, () => setPending(layer.toGeoJSON().geometry))
      );
    }
  };

  const setQuad = (next) => {
    setCorners(next);
    setPending(ringToGeometry(next));
  };

  const clearPending = () => {
    if (pendingLayer.current) {
      pendingLayer.current.remove();
      pendingLayer.current = null;
    }
    setPending(null);
    setCorners(null);
    setForm(EMPTY_FORM);
  };

  // Corners are normalized once at creation, then kept in a stable order through
  // edits/rotation — so the numbering origin rotates *with* the block instead of
  // jumping to a new geographic corner.
  // Live subdivision grid — always by count (columns x rows).
  const grid = useMemo(() => {
    if (!corners) return null;
    const rows = Math.max(1, Math.floor(Number(sub.rows) || 1));
    const cols = Math.max(1, Math.floor(Number(sub.cols) || 1));
    if (rows * cols > 3000) return { rows, cols, cells: [], tooMany: true };
    return { rows, cols, cells: subdivideQuad(corners, rows, cols) };
  }, [corners, sub]);

  // Plot number = start + (col step) * colInc + (row step) * rowInc, from the
  // chosen start corner. Blank rowInc auto-continues consecutively (cols*colInc).
  const plotNumber = (row, col, rows, cols) => {
    const start = Math.floor(Number(sub.startNo) || 1);
    const colInc = Math.floor(Number(sub.colInc) || 1);
    const rowIncRaw = String(sub.rowInc).trim();
    const rowInc = rowIncRaw === "" ? cols * colInc : Math.floor(Number(rowIncRaw) || 1);
    const r = sub.revV ? rows - 1 - row : row;
    const c = sub.revH ? cols - 1 - col : col;
    return start + c * colInc + r * rowInc;
  };

  const previewFC = useMemo(() => {
    if (mode !== "subdivide" || !grid?.cells?.length) return null;
    return {
      type: "FeatureCollection",
      features: grid.cells.map((c) => ({
        type: "Feature",
        geometry: c.geometry,
        properties: { no: plotNumber(c.row, c.col, grid.rows, grid.cols) },
      })),
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, grid, sub]);

  // Signature so the preview layer re-renders (labels update) on any numbering change.
  const numSig = `${sub.startNo}-${sub.colInc}-${sub.rowInc}-${sub.revH}-${sub.revV}`;

  // Snap targets while mesh-editing: every vertex of plots NOT in this block.
  const snapTargets = useMemo(() => {
    if (!blockEdit || !plots) return [];
    const pts = [];
    for (const f of plots.features) {
      if (f.properties.group_id === blockEdit.id) continue; // skip the block itself
      const ring = f.geometry.coordinates[0];
      for (let i = 0; i < ring.length - 1; i++) pts.push(ring[i]); // [lng,lat]
    }
    return pts;
  }, [blockEdit, plots]);

  // Live re-tile preview while editing a block's mesh.
  const blockPreviewFC = useMemo(() => {
    if (!blockEdit || !blockVerts) return null;
    return {
      type: "FeatureCollection",
      features: cellsFromGrid(blockVerts).map((c) => ({
        type: "Feature",
        geometry: c.geometry,
        properties: {},
      })),
    };
  }, [blockEdit, blockVerts]);

  const setSubF = (k) => (e) => setSub({ ...sub, [k]: e.target.value });

  const savePlot = async (e) => {
    e.preventDefault();
    if (!pending) return;
    setSaving(true);
    setError(null);
    try {
      const created = await api.createPlot(mapId, {
        geometry: pending,
        block: form.block || null,
        street: form.street || null,
        plot_no: form.plot_no || null,
        plot_type: form.plot_type,
        width_ft: Number(form.sizeW) || null,
        depth_ft: Number(form.sizeD) || null,
        min_price: form.min_price ? Number(form.min_price) : null,
      });
      setUndoStack((s) => [...s, { kind: "plot", id: created.id, label: "1 plot" }]);
      clearPending();
      await refreshPlots();
      setMsg(`Saved plot #${created.id}`);
    } catch (e) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  };

  const saveGrid = async () => {
    if (!grid?.cells?.length) return;
    setSaving(true);
    setError(null);
    try {
      const w = Number(sub.sizeW) || null;
      const d = Number(sub.sizeD) || null;
      const groupId =
        (crypto.randomUUID && crypto.randomUUID()) || `blk-${Math.random().toString(36).slice(2)}`;
      const plots = grid.cells.map((c) => ({
        geometry: c.geometry,
        block: sub.block || null,
        street: sub.street || null,
        plot_no: String(plotNumber(c.row, c.col, grid.rows, grid.cols)),
        plot_type: sub.plot_type,
        width_ft: w,
        depth_ft: d,
        group_id: groupId,
        cell_row: c.row,
        cell_col: c.col,
        min_price: null,
      }));
      const res = await api.createPlotsBatch(mapId, plots, {
        id: groupId,
        verts: quadVertexGrid(corners, grid.rows, grid.cols),
        rows: grid.rows,
        cols: grid.cols,
      });
      setUndoStack((s) => [
        ...s,
        { kind: "group", groupId, label: `block of ${res.created}` },
      ]);
      clearPending();
      await refreshPlots();
      setMsg(`Created ${res.created} plots (${grid.rows} × ${grid.cols} grid).`);
    } catch (e) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  };

  const selectPlot = (p) => {
    setSelected(p);
    setEditing(false);
  };

  const startEdit = () => {
    setEdit({
      block: selected.block ?? "",
      street: selected.street ?? "",
      plot_no: selected.plot_no ?? "",
      plot_type: selected.plot_type,
      sizeW: selected.width_ft ?? "",
      sizeD: selected.depth_ft ?? "",
      min_price: selected.min_price ?? "",
    });
    setEditing(true);
  };

  const saveEdit = async () => {
    setError(null);
    try {
      const updated = await api.updatePlot(selected.id, {
        block: edit.block || null,
        street: edit.street || null,
        plot_no: edit.plot_no || null,
        plot_type: edit.plot_type,
        width_ft: Number(edit.sizeW) || null,
        depth_ft: Number(edit.sizeD) || null,
        min_price: Number(edit.min_price) || null,
      });
      setSelected(updated);
      setEditing(false);
      await refreshPlots();
      setMsg(`Updated plot #${updated.id}.`);
    } catch (e) {
      setError(e.message);
    }
  };

  const startShapeEdit = () => {
    const feat = plots?.features.find((f) => f.properties.id === selected.id);
    if (!feat) return;
    setEditing(false);
    setShapeEdit({ id: selected.id, geometry: feat.geometry });
  };

  const saveShape = async () => {
    const geom = shapeLayerRef.current?.toGeoJSON()?.geometry;
    if (!geom || !shapeEdit) return;
    setError(null);
    try {
      await api.updatePlot(shapeEdit.id, { geometry: geom }); // metadata/group retained
      await refreshPlots(); // refresh data first so the layer shows the new shape...
      setShapeEdit(null); // ...then tear down the editor
      setMsg("Plot shape updated.");
    } catch (e) {
      setError(e.message);
    }
  };

  const startBlockEdit = async () => {
    if (!selected?.group_id) return;
    setError(null);
    try {
      const b = await api.getBlock(selected.group_id);
      if (!b.verts) throw new Error("no verts");
      setSelected(null);
      setBlockEdit({ id: b.id, rows: b.rows, cols: b.cols });
      setBlockVerts(b.verts);
    } catch {
      setError("This block predates mesh editing — recreate it to enable re-tiling.");
    }
  };

  const saveBlockEdit = async () => {
    if (!blockEdit || !blockVerts) return;
    setError(null);
    try {
      const cells = cellsFromGrid(blockVerts).map((c) => ({
        cell_row: c.row,
        cell_col: c.col,
        geometry: c.geometry,
      }));
      const res = await api.reshapeBlock(blockEdit.id, blockVerts, cells);
      await refreshPlots();
      setBlockEdit(null);
      setBlockVerts(null);
      setMsg(`Re-tiled block — ${res.updated} plot(s) updated.`);
    } catch (e) {
      setError(e.message);
    }
  };

  const cancelBlockEdit = () => {
    setBlockEdit(null);
    setBlockVerts(null);
  };

  const removePlot = async (id) => {
    setError(null);
    try {
      await api.deletePlot(id);
      if (selected?.id === id) setSelected(null);
      await refreshPlots();
    } catch (e) {
      setError(e.message);
    }
  };

  const undo = async () => {
    const action = undoStack[undoStack.length - 1];
    if (!action) return;
    setError(null);
    try {
      if (action.kind === "group") await api.deletePlotGroup(action.groupId);
      else await api.deletePlot(action.id);
    } catch {
      /* already gone (e.g. deleted/confirmed) — just pop it */
    }
    setUndoStack((s) => s.slice(0, -1));
    setSelected(null);
    await refreshPlots();
    setMsg(`Undid ${action.label}.`);
  };

  const deleteGroup = async (groupId) => {
    const count = (plots?.features || []).filter(
      (f) => f.properties.group_id === groupId && !f.properties.confirmed
    ).length;
    if (!window.confirm(`Delete this whole block (${count} draft plot(s))?`)) return;
    setError(null);
    try {
      const res = await api.deletePlotGroup(groupId);
      setSelected(null);
      await refreshPlots();
      setMsg(`Deleted block — ${res.deleted} plot(s).`);
    } catch (e) {
      setError(e.message);
    }
  };

  const resetAll = async () => {
    if (!window.confirm("Delete ALL draft plots on this map? Confirmed plots stay.")) return;
    setError(null);
    try {
      const res = await api.resetPlots(mapId);
      setSelected(null);
      await refreshPlots();
      setMsg(`Deleted ${res.deleted} draft plot(s).`);
    } catch (e) {
      setError(e.message);
    }
  };

  const autoDetect = async () => {
    setAutoBusy(true);
    setError(null);
    setMsg(null);
    try {
      const res = await api.autoExtract(mapId);
      await refreshPlots();
      setMsg(
        res.created > 0
          ? `Auto-detected ${res.created} candidate plot(s) — review, delete bad ones, then confirm.`
          : "No plots detected. Try tracing manually, or check the drawing quality."
      );
    } catch (e) {
      setError(e.message);
    } finally {
      setAutoBusy(false);
    }
  };

  const confirm = async () => {
    setError(null);
    try {
      const res = await api.confirmMap(mapId);
      setMsg(`Confirmed — ${res.confirmed_plots} plot(s) are now public.`);
      setMap({ ...map, status: "confirmed" });
      await refreshPlots();
    } catch (e) {
      setError(e.message);
    }
  };

  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });

  if (!map || !society) {
    return (
      <div className="admin-page">
        {error ? <p className="error">{error}</p> : <p className="muted">Loading…</p>}
      </div>
    );
  }

  if (!map.transform) {
    return (
      <div className="admin-page">
        <p>
          <Link to={`/admin/societies/${map.society_id}`}>← {society.name}</Link>
        </p>
        <h1>Extract plots</h1>
        <p className="error">
          This map isn't georeferenced yet.{" "}
          <Link to={`/admin/maps/${map.id}/georeference`}>Georeference it first →</Link>
        </p>
      </div>
    );
  }

  const features = plots?.features || [];
  const confirmedCount = features.filter((f) => f.properties.confirmed).length;
  const draftCount = features.length - confirmedCount;

  const query = q.trim().toLowerCase();
  const visibleFeatures = features.filter((f) => {
    const p = f.properties;
    if (fStatus === "draft" && p.confirmed) return false;
    if (fStatus === "live" && !p.confirmed) return false;
    if (fType !== "all" && p.plot_type !== fType) return false;
    if (query) {
      const hay = `${p.block ?? ""} ${p.street ?? ""} ${p.plot_no ?? ""}`.toLowerCase();
      if (!hay.includes(query)) return false;
    }
    return true;
  });

  return (
    <div className="admin-page wide">
      <p>
        <Link to={`/admin/societies/${map.society_id}`}>← {society.name}</Link>
      </p>
      <h1>Extract plots — {map.original_name || `map #${map.id}`}</h1>

      <ol className="steps">
        <li>1 · Upload map</li>
        <li>2 · Georeference</li>
        <li className="active">3 · Extract plots</li>
        <li className={map.status === "confirmed" ? "active" : ""}>4 · Confirm</li>
      </ol>

      {msg && <p className="ok">{msg}</p>}
      {error && <p className="error">{error}</p>}

      <div className="extract-split">
        <div className="geo-pane">
          <div className="pane-label">
            Trace plots · ▢/⬠ tools (top-left) · angle blocks with the ⟳ handle after drawing
          </div>
          <MapContainer
            center={[society.center_lat, society.center_lng]}
            zoom={society.default_zoom}
            style={{ height: "560px" }}
            maxZoom={24}
          >
            <BaseLayer language="en" />
            <RotatedOverlay
              imageUrl={map.image_url}
              transform={map.transform}
              width={map.width}
              height={map.height}
              opacity={opacity}
            />
            <FitToContent
              transform={map.transform}
              width={map.width}
              height={map.height}
            />
            {plots && (
              <GeoJSON
                key={version}
                data={plots}
                style={(f) => ({
                  color: "#0f172a",
                  weight: 1,
                  fillColor: TYPE_COLORS[f.properties.plot_type] || "#94a3b8",
                  fillOpacity: f.properties.confirmed ? 0.55 : 0.35,
                  dashArray: f.properties.confirmed ? null : "4",
                })}
                onEachFeature={(f, layer) => {
                  const p = f.properties;
                  const auto =
                    p.source === "auto" && p.confidence != null
                      ? ` · auto ${Math.round(p.confidence * 100)}%`
                      : "";
                  layer.bindTooltip(
                    `${[p.block && `Block ${p.block}`, p.street && `St ${p.street}`, `Plot ${p.plot_no ?? "—"}`]
                      .filter(Boolean)
                      .join(" · ")} · ${formatSize(p)}${auto}`
                  );
                  layer.on("click", (e) => {
                    L.DomEvent.stopPropagation(e); // don't let it reach the map (deselect)
                    selectPlot(p);
                  });
                }}
              />
            )}
            {showNumbers && plots && <PlotLabels features={features} />}
            {/* Selection/group highlight as a separate light overlay, so selecting
                never rebuilds the whole plots layer (which left a ghost on drag). */}
            {plots && selected && !shapeEdit && (
              <GeoJSON
                key={`hl-${selected.id}`}
                interactive={false}
                data={{
                  type: "FeatureCollection",
                  features: plots.features.filter(
                    (f) =>
                      f.properties.id === selected.id ||
                      (selected.group_id && f.properties.group_id === selected.group_id)
                  ),
                }}
                style={(f) => ({
                  color: f.properties.id === selected.id ? "#ea580c" : "#f59e0b",
                  weight: f.properties.id === selected.id ? 3 : 2,
                  fill: false,
                })}
              />
            )}
            {shapeEdit && (
              <ShapeEditor geometry={shapeEdit.geometry} layerRef={shapeLayerRef} />
            )}
            {pending && corners && <QuadEditor corners={corners} onChange={setQuad} />}
            {blockEdit && blockVerts && (
              <>
                {blockPreviewFC && (
                  <GeoJSON
                    key={`be-${JSON.stringify(blockVerts)}`}
                    data={blockPreviewFC}
                    interactive={false}
                    style={{ color: "#7c3aed", weight: 1, fillColor: "#a855f7", fillOpacity: 0.2 }}
                  />
                )}
                <MeshEditor verts={blockVerts} onChange={setBlockVerts} snapTargets={snapTargets} />
              </>
            )}
            {previewFC && (
              <GeoJSON
                key={`preview-${grid.rows}x${grid.cols}-${numSig}`}
                data={previewFC}
                interactive={false}
                style={{ color: "#7c3aed", weight: 1, fillColor: "#a855f7", fillOpacity: 0.25 }}
                onEachFeature={(f, layer) => {
                  // Show numbers so the layout can be matched to the numbering menu.
                  if (grid.cells.length <= 250) {
                    layer.bindTooltip(String(f.properties.no), {
                      permanent: true,
                      direction: "center",
                      className: "plot-num",
                    });
                  }
                }}
              />
            )}
            <DrawTools onCreate={onCreate} />
            {!pending && !shapeEdit && !blockEdit && (
              <DeselectOnClick onDeselect={() => setSelected(null)} />
            )}
          </MapContainer>
        </div>

        <div className="extract-panel">
          <div className="panel-bar">
            <span className="pb-title">Extract plots</span>
            <label className="pb-check" title="Show plot numbers on the map">
              <input
                type="checkbox"
                checked={showNumbers}
                onChange={(e) => setShowNumbers(e.target.checked)}
              />
              #
            </label>
            <label className="opacity-mini" title="Drawing opacity">
              <span>Overlay</span>
              <input
                type="range"
                min="0"
                max="1"
                step="0.05"
                value={opacity}
                onChange={(e) => setOpacity(Number(e.target.value))}
              />
            </label>
          </div>
          {showNumbers && (
            <p className="muted small" style={{ margin: "0 2px" }}>
              Numbers show when zoomed in.
            </p>
          )}

          {blockEdit && (
            <div className="card sel-card">
              <div className="sel-head">
                <strong>Edit block layout</strong>
                <button className="x" onClick={cancelBlockEdit} title="Cancel">
                  ×
                </button>
              </div>
              <p className="muted small">
                Drag any vertex dot to reshape. Interior vertices move adjacent plots
                together; edge vertices <strong>snap</strong> onto nearby neighboring-block
                vertices. {blockEdit.rows * blockEdit.cols} plots keep their numbers.
              </p>
              <div className="two">
                <button onClick={saveBlockEdit}>Save layout</button>
                <button className="ghost" onClick={cancelBlockEdit}>
                  Cancel
                </button>
              </div>
            </div>
          )}

          {selected && !blockEdit && (
            <div className="card sel-card">
              <div className="sel-head">
                <strong>
                  {[
                    selected.block && `Block ${selected.block}`,
                    selected.street && `St ${selected.street}`,
                    `Plot ${selected.plot_no ?? "—"}`,
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </strong>
                <button className="x" onClick={() => setSelected(null)} title="Deselect">
                  ×
                </button>
              </div>

              {shapeEdit ? (
                <div className="form">
                  <p className="muted small">
                    Drag vertices to reshape. Click a midpoint dot to add a vertex.
                    Number, block, size &amp; group are kept.
                  </p>
                  <div className="two">
                    <button onClick={saveShape}>Save shape</button>
                    <button className="ghost" onClick={() => setShapeEdit(null)}>
                      Cancel
                    </button>
                  </div>
                </div>
              ) : !editing ? (
                <>
                  <p className="muted small">
                    {selected.plot_type} · <strong>{formatSize(selected)}</strong> ·{" "}
                    {selected.confirmed ? "live" : "draft"}
                  </p>
                  <div className="btn-grid">
                    <button className="ghost" onClick={startEdit}>
                      Edit info
                    </button>
                    <button className="ghost" onClick={startShapeEdit}>
                      Edit shape
                    </button>
                    {selected.group_id && (
                      <button className="ghost" onClick={startBlockEdit}>
                        Edit block
                      </button>
                    )}
                    {!selected.confirmed && (
                      <button className="del-btn" onClick={() => removePlot(selected.id)}>
                        Delete plot
                      </button>
                    )}
                  </div>
                  {selected.group_id && (
                    <button
                      className="del-block-btn"
                      onClick={() => deleteGroup(selected.group_id)}
                    >
                      Delete whole block
                    </button>
                  )}
                </>
              ) : (
                <div className="form">
                  <div className="two">
                    <label>
                      Block
                      <input
                        value={edit.block}
                        onChange={(e) => setEdit({ ...edit, block: e.target.value })}
                      />
                    </label>
                    <label>
                      Street
                      <input
                        value={edit.street}
                        onChange={(e) => setEdit({ ...edit, street: e.target.value })}
                      />
                    </label>
                  </div>
                  <label>
                    Plot no.
                    <input
                      value={edit.plot_no}
                      onChange={(e) => setEdit({ ...edit, plot_no: e.target.value })}
                    />
                  </label>
                  <label>
                    Plot size (ft) — width × depth
                    <div className="dim-row">
                      <input
                        type="number"
                        value={edit.sizeW}
                        onChange={(e) => setEdit({ ...edit, sizeW: e.target.value })}
                      />
                      <span>×</span>
                      <input
                        type="number"
                        value={edit.sizeD}
                        onChange={(e) => setEdit({ ...edit, sizeD: e.target.value })}
                      />
                    </div>
                  </label>
                  <label>
                    Type
                    <select
                      value={edit.plot_type}
                      onChange={(e) => setEdit({ ...edit, plot_type: e.target.value })}
                    >
                      {Object.keys(TYPE_COLORS).map((t) => (
                        <option key={t} value={t}>
                          {t}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    Min price (PKR)
                    <input
                      type="number"
                      value={edit.min_price}
                      onChange={(e) => setEdit({ ...edit, min_price: e.target.value })}
                    />
                  </label>
                  <div className="two">
                    <button onClick={saveEdit}>Save</button>
                    <button className="ghost" onClick={() => setEditing(false)}>
                      Cancel
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}

          {!pending && !selected && !blockEdit && (
            <div className="card idle-card">
              <p className="muted small">
                <strong>Rectangle</strong> tool → a block you subdivide into plots.{" "}
                <strong>Polygon</strong> tool → a single plot. Reshape with the handles, angle
                with <strong>⟳</strong>. Drafts stay hidden until you confirm.
              </p>
              <details className="auto-collapse">
                <summary>Auto-detect (OpenCV)</summary>
                <p className="muted small">
                  Finds plot cells from the drawing as rough draft suggestions; re-running
                  replaces previous auto drafts.
                </p>
                <button className="auto-btn" onClick={autoDetect} disabled={autoBusy}>
                  {autoBusy ? "Detecting…" : "⚡ Auto-detect plots"}
                </button>
              </details>
            </div>
          )}

          {pending && corners && (
            <div className="card">
              <div className="mode-tabs">
                <button
                  className={mode === "subdivide" ? "on" : ""}
                  onClick={() => setMode("subdivide")}
                >
                  Subdivide block
                </button>
                <button
                  className={mode === "single" ? "on" : ""}
                  onClick={() => setMode("single")}
                >
                  Single plot
                </button>
              </div>

              {mode === "subdivide" && (
                <div className="form">
                  <div className="two">
                    <label>
                      Columns
                      <input type="number" value={sub.cols} onChange={setSubF("cols")} />
                    </label>
                    <label>
                      Rows
                      <input type="number" value={sub.rows} onChange={setSubF("rows")} />
                    </label>
                  </div>

                  <label>
                    Plot size (ft) — width × depth
                    <div className="dim-row">
                      <input type="number" value={sub.sizeW} onChange={setSubF("sizeW")} />
                      <span>×</span>
                      <input type="number" value={sub.sizeD} onChange={setSubF("sizeD")} />
                    </div>
                  </label>

                  <div className="two">
                    <label>
                      Block
                      <input value={sub.block} onChange={setSubF("block")} placeholder="A" />
                    </label>
                    <label>
                      Street
                      <input value={sub.street} onChange={setSubF("street")} placeholder="5" />
                    </label>
                  </div>
                  <label>
                    Type
                    <select value={sub.plot_type} onChange={setSubF("plot_type")}>
                      {Object.keys(TYPE_COLORS).map((t) => (
                        <option key={t} value={t}>
                          {t}
                        </option>
                      ))}
                    </select>
                  </label>

                  <details className="numbering">
                    <summary>Numbering</summary>
                    <div className="two">
                      <label>
                        Start plot #
                        <input type="number" value={sub.startNo} onChange={setSubF("startNo")} />
                      </label>
                      <label>
                        Across +/col
                        <input type="number" value={sub.colInc} onChange={setSubF("colInc")} />
                      </label>
                      <label>
                        Down +/row
                        <input
                          type="number"
                          value={sub.rowInc}
                          onChange={setSubF("rowInc")}
                          placeholder={`${grid.cols * (Math.floor(Number(sub.colInc) || 1))}`}
                        />
                      </label>
                    </div>
                    <p className="hint-line">
                      Across/Down = amount added per column/row. Blank Down = continue
                      consecutively. Odd-across + even-next-row: Across 2, Down 1.
                    </p>
                    <div className="corner-pick">
                      <span className="lbl">Start corner (where #{Math.floor(Number(sub.startNo) || 1)} goes)</span>
                      <div className="corner-grid">
                        {[
                          ["tl", "↖"],
                          ["tr", "↗"],
                          ["bl", "↙"],
                          ["br", "↘"],
                        ].map(([code, arrow]) => {
                          const active = (sub.revV ? "b" : "t") + (sub.revH ? "r" : "l");
                          return (
                            <button
                              key={code}
                              className={active === code ? "on" : ""}
                              onClick={() =>
                                setSub({
                                  ...sub,
                                  revH: code[1] === "r",
                                  revV: code[0] === "b",
                                })
                              }
                            >
                              {arrow}
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  </details>

                  {grid?.tooMany ? (
                    <p className="error">
                      {grid.rows} × {grid.cols} is too many ({grid.rows * grid.cols}). Reduce.
                    </p>
                  ) : (
                    <p className="grid-count">
                      {grid.cols} × {grid.rows} = <strong>{grid.rows * grid.cols} plots</strong>
                      <br />
                      {(() => {
                        const nums = grid.cells.map((c) =>
                          plotNumber(c.row, c.col, grid.rows, grid.cols)
                        );
                        return (
                          <span className="muted small">
                            #{Math.min(...nums)} → #{Math.max(...nums)}
                          </span>
                        );
                      })()}
                    </p>
                  )}

                  <div className="two">
                    <button onClick={saveGrid} disabled={saving || !grid?.cells?.length}>
                      {saving ? "Creating…" : `Create ${grid?.cells?.length || 0} plots`}
                    </button>
                    <button type="button" className="ghost" onClick={clearPending}>
                      Discard
                    </button>
                  </div>
                </div>
              )}

              {mode === "single" && (
                <SinglePlotForm
                  form={form}
                  set={set}
                  saving={saving}
                  onSave={savePlot}
                  onDiscard={clearPending}
                />
              )}
            </div>
          )}

          {pending && !corners && (
            <SinglePlotForm
              card
              form={form}
              set={set}
              saving={saving}
              onSave={savePlot}
              onDiscard={clearPending}
            />
          )}

          <div className="card">
            <div className="list-head">
              <h2>
                Plots · {features.length}{" "}
                <span className="muted">
                  ({draftCount} draft, {confirmedCount} live)
                </span>
              </h2>
              <div className="head-actions">
                {undoStack.length > 0 && (
                  <button className="undo-btn" onClick={undo}>
                    ↶ Undo
                  </button>
                )}
                {draftCount > 0 && (
                  <button className="reset-btn" onClick={resetAll}>
                    Clear drafts
                  </button>
                )}
              </div>
            </div>

            <div className="plot-filters">
              <input
                className="plot-search"
                placeholder="Search block / street / no."
                value={q}
                onChange={(e) => setQ(e.target.value)}
              />
              <select value={fStatus} onChange={(e) => setFStatus(e.target.value)}>
                <option value="all">All</option>
                <option value="draft">Draft</option>
                <option value="live">Live</option>
              </select>
              <select value={fType} onChange={(e) => setFType(e.target.value)}>
                <option value="all">Any type</option>
                {Object.keys(TYPE_COLORS).map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>
            </div>
            {(query || fStatus !== "all" || fType !== "all") && (
              <p className="muted small filter-count">
                Showing {visibleFeatures.length} of {features.length}
              </p>
            )}

            <ul className="list plot-list">
              {visibleFeatures.map((f) => (
                <li
                  key={f.properties.id}
                  className={"plot-row" + (selected?.id === f.properties.id ? " sel" : "")}
                  onClick={() => selectPlot(f.properties)}
                >
                  <span
                    className="swatch sm"
                    style={{ background: TYPE_COLORS[f.properties.plot_type] }}
                  />
                  <span>
                    {[
                      f.properties.block && `B${f.properties.block}`,
                      f.properties.street && `S${f.properties.street}`,
                      `P${f.properties.plot_no ?? "—"}`,
                    ]
                      .filter(Boolean)
                      .join("/")}{" "}
                    · {formatSize(f.properties)}
                    {f.properties.source === "auto" && (
                      <span className="pill auto">
                        auto{f.properties.confidence != null ? ` ${Math.round(f.properties.confidence * 100)}%` : ""}
                      </span>
                    )}
                    {f.properties.confirmed && <span className="pill">live</span>}
                  </span>
                  {!f.properties.confirmed && (
                    <button
                      className="link-danger"
                      onClick={(e) => {
                        e.stopPropagation();
                        removePlot(f.properties.id);
                      }}
                    >
                      delete
                    </button>
                  )}
                </li>
              ))}
              {visibleFeatures.length === 0 && (
                <li className="muted">{features.length === 0 ? "None yet." : "No matches."}</li>
              )}
            </ul>
          </div>

          <button
            className="confirm-btn"
            onClick={confirm}
            disabled={draftCount === 0}
            title={draftCount === 0 ? "Nothing new to confirm" : ""}
          >
            Confirm map → publish {draftCount} plot(s)
          </button>
        </div>
      </div>
    </div>
  );
}

function SinglePlotForm({ form, set, saving, onSave, onDiscard, card }) {
  return (
    <form className={"form" + (card ? " card" : "")} onSubmit={onSave}>
      <div className="two">
        <label>
          Block
          <input value={form.block} onChange={set("block")} placeholder="A" />
        </label>
        <label>
          Street
          <input value={form.street} onChange={set("street")} placeholder="5" />
        </label>
      </div>
      <label>
        Plot no.
        <input value={form.plot_no} onChange={set("plot_no")} placeholder="12" />
      </label>
      <label>
        Type
        <select value={form.plot_type} onChange={set("plot_type")}>
          {Object.keys(TYPE_COLORS).map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
      </label>
      <label>
        Plot size (ft) — width × depth
        <div className="dim-row">
          <input type="number" value={form.sizeW} onChange={set("sizeW")} placeholder="60" />
          <span>×</span>
          <input type="number" value={form.sizeD} onChange={set("sizeD")} placeholder="90" />
        </div>
      </label>
      <label>
        Min price (PKR, optional)
        <input
          type="number"
          value={form.min_price}
          onChange={set("min_price")}
          placeholder="8500000"
        />
      </label>
      <div className="two">
        <button type="submit" disabled={saving}>
          {saving ? "Saving…" : "Save plot"}
        </button>
        <button type="button" className="ghost" onClick={onDiscard}>
          Discard
        </button>
      </div>
    </form>
  );
}
