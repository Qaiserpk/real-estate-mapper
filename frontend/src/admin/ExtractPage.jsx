import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { MapContainer, GeoJSON, Marker, useMap, useMapEvents } from "react-leaflet";
import L from "leaflet";
import "@geoman-io/leaflet-geoman-free";
import "@geoman-io/leaflet-geoman-free/dist/leaflet-geoman.css";
import { api, setLastSociety } from "../api.js";
import RotatedOverlay from "../RotatedOverlay.jsx";
import BaseLayer from "../BaseLayer.jsx";
import QuadEditor from "./QuadEditor.jsx";
import { formatSize } from "../status.js";
import {
  pixelToLatLng,
  normalizeQuad,
  coonsVertexGrid,
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

// Ctrl + drag moves the reference overlay (Ctrl disables map panning meanwhile).
function OverlayDrag({ onDelta }) {
  const map = useMap();
  useEffect(() => {
    const container = map.getContainer();
    let dragging = false;
    let lastX = 0;
    let lastY = 0;

    const keydown = (e) => {
      if (e.key === "Control") {
        map.dragging.disable();
        container.style.cursor = "move";
      }
    };
    const keyup = (e) => {
      if (e.key === "Control" && !dragging) {
        map.dragging.enable();
        container.style.cursor = "";
      }
    };
    const down = (e) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      dragging = true;
      lastX = e.clientX;
      lastY = e.clientY;
    };
    const move = (e) => {
      if (!dragging) return;
      const dx = e.clientX - lastX;
      const dy = e.clientY - lastY;
      lastX = e.clientX;
      lastY = e.clientY;
      if (dx || dy) onDelta(dx, dy);
    };
    const up = () => {
      if (!dragging) return;
      dragging = false;
      map.dragging.enable();
      container.style.cursor = "";
    };

    container.addEventListener("mousedown", down);
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
    window.addEventListener("keydown", keydown);
    window.addEventListener("keyup", keyup);
    return () => {
      container.removeEventListener("mousedown", down);
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      window.removeEventListener("keydown", keydown);
      window.removeEventListener("keyup", keyup);
      map.dragging.enable();
      container.style.cursor = "";
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map]);
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

// ---- Arc/bulge geometry (local equirectangular metres so it's zoom-stable) ----
function projector(lat0, lng0) {
  const mLat = 110540;
  const mLng = 111320 * Math.cos((lat0 * Math.PI) / 180);
  return {
    to: ([lng, lat]) => [(lng - lng0) * mLng, (lat - lat0) * mLat],
    from: ([x, y]) => [lng0 + x / mLng, lat0 + y / mLat],
  };
}
// Circle through 3 planar points -> [cx, cy, r], or null if ~collinear.
function circleThrough(a, b, c) {
  const d = 2 * (a[0] * (b[1] - c[1]) + b[0] * (c[1] - a[1]) + c[0] * (a[1] - b[1]));
  if (Math.abs(d) < 1e-6) return null;
  const ua = a[0] ** 2 + a[1] ** 2;
  const ub = b[0] ** 2 + b[1] ** 2;
  const uc = c[0] ** 2 + c[1] ** 2;
  const cx = (ua * (b[1] - c[1]) + ub * (c[1] - a[1]) + uc * (a[1] - b[1])) / d;
  const cy = (ua * (c[0] - b[0]) + ub * (a[0] - c[0]) + uc * (b[0] - a[0])) / d;
  return [cx, cy, Math.hypot(a[0] - cx, a[1] - cy)];
}
// Points from A along the circular arc through T towards B (B excluded).
function arcSamples(A, B, T) {
  const c = circleThrough(A, B, T);
  if (!c) return [A];
  const [cx, cy, r] = c;
  const norm = (x) => ((x % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
  const ang = (p) => Math.atan2(p[1] - cy, p[0] - cx);
  const a1 = ang(A);
  const spanCCW = norm(ang(B) - a1);
  const ccw = norm(ang(T) - a1) <= spanCCW;
  const span = ccw ? spanCCW : spanCCW - 2 * Math.PI;
  const steps = Math.max(2, Math.min(80, Math.round(Math.abs(span) / (Math.PI / 60))));
  const out = [];
  for (let i = 0; i < steps; i++) {
    const a = a1 + span * (i / steps);
    out.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
  }
  return out;
}
function densifyRing(base, through, proj) {
  const xy = base.map(proj.to);
  const n = base.length;
  const ring = [];
  for (let i = 0; i < n; i++) {
    const A = xy[i];
    const B = xy[(i + 1) % n];
    const T = through[i] ? proj.to(through[i]) : null;
    if (!T) ring.push(A);
    else ring.push(...arcSamples(A, B, T));
  }
  return ring.map(proj.from); // [lng,lat] open ring
}

// Editable single-plot shape: drag corners to move; drag an edge's dot to bulge
// it into a circular arc; double-click a dot to straighten; double-click a
// corner to remove it. layerRef holds the live (densified) polygon for saving.
function ShapeEditor({ geometry, layerRef }) {
  const map = useMap();
  useEffect(() => {
    const coords = geometry?.coordinates?.[0] || [];
    const base = coords.slice(0, -1).map(([lng, lat]) => [lng, lat]); // drop closing dup
    if (base.length < 3) return;
    const through = base.map(() => null); // per-edge arc through-point ([lng,lat]) or null

    const lat0 = base.reduce((s, p) => s + p[1], 0) / base.length;
    const lng0 = base.reduce((s, p) => s + p[0], 0) / base.length;
    const proj = projector(lat0, lng0);

    map.doubleClickZoom.disable();
    const poly = L.polygon([], {
      color: "#ea580c",
      weight: 3,
      fillColor: "#f97316",
      fillOpacity: 0.25,
    }).addTo(map);
    layerRef.current = poly;

    const cornerIcon = L.divIcon({ className: "arc-h arc-corner", iconSize: [12, 12], iconAnchor: [6, 6] });
    const edgeIcon = L.divIcon({ className: "arc-h arc-edge", iconSize: [14, 14], iconAnchor: [7, 7] });

    let cornerMarkers = [];
    let edgeMarkers = [];

    const midLL = (i) => {
      const A = base[i];
      const B = base[(i + 1) % base.length];
      return [(A[1] + B[1]) / 2, (A[0] + B[0]) / 2];
    };

    const redraw = () => {
      const ring = densifyRing(base, through, proj);
      poly.setLatLngs(ring.map(([lng, lat]) => [lat, lng]));
      edgeMarkers.forEach((m, i) => {
        if (!through[i]) m.setLatLng(midLL(i));
      });
    };

    const clearHandles = () => {
      cornerMarkers.forEach((m) => map.removeLayer(m));
      edgeMarkers.forEach((m) => map.removeLayer(m));
      cornerMarkers = [];
      edgeMarkers = [];
    };

    const buildHandles = () => {
      clearHandles();
      base.forEach((p, i) => {
        const m = L.marker([p[1], p[0]], { icon: cornerIcon, draggable: true }).addTo(map);
        m.on("drag", (e) => {
          const ll = e.target.getLatLng();
          base[i] = [ll.lng, ll.lat];
          redraw();
        });
        m.on("dblclick", (e) => {
          L.DomEvent.stopPropagation(e);
          if (base.length <= 3) return;
          base.splice(i, 1);
          through.splice(i, 1);
          buildHandles();
          redraw();
        });
        cornerMarkers.push(m);
      });
      base.forEach((_, i) => {
        const start = through[i] ? [through[i][1], through[i][0]] : midLL(i);
        const m = L.marker(start, { icon: edgeIcon, draggable: true }).addTo(map);
        m.on("drag", (e) => {
          const ll = e.target.getLatLng();
          through[i] = [ll.lng, ll.lat];
          redraw();
        });
        m.on("dblclick", (e) => {
          L.DomEvent.stopPropagation(e);
          through[i] = null;
          m.setLatLng(midLL(i));
          redraw();
        });
        edgeMarkers.push(m);
      });
    };

    buildHandles();
    redraw();

    return () => {
      clearHandles();
      try {
        map.removeLayer(poly);
      } catch {
        /* noop */
      }
      try {
        map.doubleClickZoom.enable();
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
  const [edgeThrough, setEdgeThrough] = useState([null, null, null, null]); // per-edge arc apex
  const [mode, setMode] = useState("single"); // 'single' | 'subdivide'
  const [sub, setSub] = useState({
    rows: "2",
    cols: "10",
    sizeW: "60", // stated plot size (ft), applied to all plots — not calculated
    sizeD: "90",
    block: "",
    street: "",
    streetMode: "same", // 'same' (whole block) | 'row' (per-row streets)
    streetRows: {}, // { rowIndex: street }
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
  const [multiSel, setMultiSel] = useState(() => new Set()); // multi-selected plot ids
  const BULK_EMPTY = { block: "", street: "", sizeW: "", sizeD: "", plot_type: "" };
  const [bulk, setBulk] = useState(BULK_EMPTY);
  const [shapeEdit, setShapeEdit] = useState(null); // { id, geometry } while editing a plot's shape
  const shapeLayerRef = useRef(null);
  const [blockEdit, setBlockEdit] = useState(null); // { id, rows, cols } while re-tiling a block
  const [blockVerts, setBlockVerts] = useState(null); // editable vertex grid
  const [error, setError] = useState(null);
  const [msg, setMsg] = useState(null);
  const [saving, setSaving] = useState(false);
  const [undoStack, setUndoStack] = useState([]); // recent creations, for undo
  const [q, setQ] = useState(""); // plot list search
  const [fStatus, setFStatus] = useState("all"); // all | draft | live
  const [fType, setFType] = useState("all");
  const [showNumbers, setShowNumbers] = useState(true); // plot-number labels on map
  const [ovAdj, setOvAdj] = useState({ dx: 0, dy: 0, rot: 0, scale: 1 }); // temp overlay nudge
  const [baseVariant, setBaseVariant] = useState("streets"); // streets | satellite
  const pendingLayer = useRef(null);

  const nudge = (ddx, ddy) => setOvAdj((a) => ({ ...a, dx: a.dx + ddx, dy: a.dy + ddy }));
  const rotateOv = (d) => setOvAdj((a) => ({ ...a, rot: +(a.rot + d).toFixed(2) }));
  const scaleOv = (d) => setOvAdj((a) => ({ ...a, scale: +(a.scale + d).toFixed(3) }));
  const resetOv = () => setOvAdj({ dx: 0, dy: 0, rot: 0, scale: 1 });
  const ovAdjusted = ovAdj.dx || ovAdj.dy || ovAdj.rot || ovAdj.scale !== 1;

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
        setLastSociety(m.society_id);
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
      setEdgeThrough([null, null, null, null]);
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

  const setBlock = (nextCorners, nextThrough) => {
    setCorners(nextCorners);
    setEdgeThrough(nextThrough);
    setPending(ringToGeometry(nextCorners));
  };

  const clearPending = () => {
    if (pendingLayer.current) {
      pendingLayer.current.remove();
      pendingLayer.current = null;
    }
    setPending(null);
    setCorners(null);
    setEdgeThrough([null, null, null, null]);
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
    const verts = coonsVertexGrid(corners, edgeThrough, rows, cols);
    return { rows, cols, verts, cells: cellsFromGrid(verts) };
  }, [corners, edgeThrough, sub]);

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
      const streetOf = (row) =>
        sub.streetMode === "row"
          ? (sub.streetRows[row] || "").trim() || null
          : sub.street || null;
      const plots = grid.cells.map((c) => ({
        geometry: c.geometry,
        block: sub.block || null,
        street: streetOf(c.row),
        plot_no: String(plotNumber(c.row, c.col, grid.rows, grid.cols)),
        plot_type: sub.plot_type,
        width_ft: w,
        depth_ft: d,
        group_id: groupId,
        cell_row: c.row,
        cell_col: c.col,
      }));
      const res = await api.createPlotsBatch(mapId, plots, {
        id: groupId,
        verts: grid.verts,
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

  const selectPlot = (p, additive) => {
    if (additive) {
      setSelected(null);
      setMultiSel((s) => {
        const n = new Set(s);
        n.has(p.id) ? n.delete(p.id) : n.add(p.id);
        return n;
      });
      return;
    }
    setSelected(p);
    setMultiSel(new Set());
    setEditing(false);
  };

  const selectAllShown = (feats) => setMultiSel(new Set(feats.map((f) => f.properties.id)));
  const clearMulti = () => setMultiSel(new Set());
  const toggleMulti = (id) =>
    setMultiSel((s) => {
      const n = new Set(s);
      n.has(id) ? n.delete(id) : n.add(id);
      return n;
    });
  const setBulkF = (k) => (e) => setBulk({ ...bulk, [k]: e.target.value });

  const applyBulk = async () => {
    const patch = {};
    if (bulk.block.trim()) patch.block = bulk.block.trim();
    if (bulk.street.trim()) patch.street = bulk.street.trim();
    if (bulk.plot_type) patch.plot_type = bulk.plot_type;
    if (bulk.sizeW !== "") patch.width_ft = Number(bulk.sizeW);
    if (bulk.sizeD !== "") patch.depth_ft = Number(bulk.sizeD);
    if (Object.keys(patch).length === 0) {
      setError("Fill at least one field to apply.");
      return;
    }
    setError(null);
    try {
      const res = await api.bulkUpdatePlots([...multiSel], patch);
      setBulk(BULK_EMPTY);
      await refreshPlots();
      setMsg(`Updated ${res.updated} plot(s).`);
    } catch (e) {
      setError(e.message);
    }
  };

  const deleteBulk = async () => {
    if (!window.confirm(`Delete ${multiSel.size} selected plot(s)? (drafts only)`)) return;
    setError(null);
    try {
      const res = await api.bulkDeletePlots([...multiSel]);
      clearMulti();
      await refreshPlots();
      setMsg(`Deleted ${res.deleted} plot(s).`);
    } catch (e) {
      setError(e.message);
    }
  };

  const startEdit = () => {
    setEdit({
      block: selected.block ?? "",
      street: selected.street ?? "",
      plot_no: selected.plot_no ?? "",
      plot_type: selected.plot_type,
      sizeW: selected.width_ft ?? "",
      sizeD: selected.depth_ft ?? "",
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
            <BaseLayer language="en" variant={baseVariant} />
            <RotatedOverlay
              imageUrl={map.image_url}
              transform={map.transform}
              width={map.width}
              height={map.height}
              opacity={opacity}
              adjust={ovAdj}
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
                    selectPlot(p, e.originalEvent.shiftKey);
                  });
                }}
              />
            )}
            {plots && multiSel.size > 0 && (
              <GeoJSON
                key={`ms-${[...multiSel].sort((a, b) => a - b).join(",")}`}
                interactive={false}
                data={{
                  type: "FeatureCollection",
                  features: plots.features.filter((f) => multiSel.has(f.properties.id)),
                }}
                style={{ color: "#0891b2", weight: 3, fillColor: "#06b6d4", fillOpacity: 0.45 }}
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
            {pending && corners && (
              <QuadEditor
                corners={corners}
                edgeThrough={edgeThrough}
                onChange={setBlock}
              />
            )}
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
            <OverlayDrag onDelta={nudge} />
            {!pending && !shapeEdit && !blockEdit && (
              <DeselectOnClick
                onDeselect={() => {
                  setSelected(null);
                  clearMulti();
                }}
              />
            )}
          </MapContainer>
        </div>

        <div className="extract-panel">
          <div className="panel-bar">
            <span className="pb-title">Extract plots</span>
            <select
              className="base-select"
              value={baseVariant}
              onChange={(e) => setBaseVariant(e.target.value)}
              title="Base map"
            >
              <option value="streets">Streets</option>
              <option value="satellite">Satellite</option>
              <option value="google-roads">Google Roads</option>
              <option value="google">Google Satellite</option>
              <option value="google-hybrid">Google Hybrid</option>
            </select>
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

          <details className="card ov-adjust" open={ovAdjusted}>
            <summary>
              Align overlay {ovAdjusted && <span className="pill amber">nudged</span>}
            </summary>
            <p className="muted small">
              Hold <strong>Ctrl</strong> and drag the map to move the reference image into
              local alignment. Fine-tune with rotate/scale, then reset. This does
              <strong> not</strong> change the saved georeference.
            </p>
            <div className="two ov-fine">
              <div className="ov-ctl">
                <span>Rotate</span>
                <button onClick={() => rotateOv(-0.3)}>−</button>
                <button onClick={() => rotateOv(0.3)}>+</button>
              </div>
              <div className="ov-ctl">
                <span>Scale</span>
                <button onClick={() => scaleOv(-0.01)}>−</button>
                <button onClick={() => scaleOv(0.01)}>+</button>
              </div>
            </div>
            <button onClick={resetOv} className="ghost reset-ov">
              Reset to fitted
            </button>
          </details>

          {multiSel.size > 0 && (
            <div className="card sel-card bulk-card">
              <div className="sel-head">
                <strong>{multiSel.size} plots selected</strong>
                <button className="x" onClick={clearMulti} title="Clear selection">
                  ×
                </button>
              </div>
              <p className="muted small">
                Shift-click plots (or tick rows) to select. Filled fields apply to all;
                blanks are left unchanged.
              </p>
              <div className="form">
                <div className="two">
                  <label>
                    Block
                    <input value={bulk.block} onChange={setBulkF("block")} placeholder="unchanged" />
                  </label>
                  <label>
                    Street
                    <input value={bulk.street} onChange={setBulkF("street")} placeholder="unchanged" />
                  </label>
                </div>
                <label>
                  Plot size (ft) — width × depth
                  <div className="dim-row">
                    <input type="number" value={bulk.sizeW} onChange={setBulkF("sizeW")} placeholder="w" />
                    <span>×</span>
                    <input type="number" value={bulk.sizeD} onChange={setBulkF("sizeD")} placeholder="d" />
                  </div>
                </label>
                <div className="two">
                  <label>
                    Type
                    <select value={bulk.plot_type} onChange={setBulkF("plot_type")}>
                      <option value="">unchanged</option>
                      {Object.keys(TYPE_COLORS).map((t) => (
                        <option key={t} value={t}>
                          {t}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>
                <button onClick={applyBulk}>Apply to {multiSel.size}</button>
                <button className="del-btn" onClick={deleteBulk}>
                  Delete {multiSel.size} selected
                </button>
              </div>
            </div>
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
                    Drag <b>corners</b> to reshape. Drag an <b>edge dot</b> to curve
                    it into an arc; double-click the dot to straighten, or a corner
                    to remove it. Number, block, size &amp; group are kept.
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
                <strong>Polygon</strong> tool → a single plot. Drag corners/edges to
                reshape, the <strong>◆</strong> to curve an edge into an arc (double-click
                it to straighten), <strong>⟳</strong> to rotate. Drafts stay hidden until
                you confirm.
              </p>
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

                  <div className="numbering">
                    <div className="num-head">
                      <span>Numbering</span>
                      <span className="num-sum">
                        #{Math.floor(Number(sub.startNo) || 1)}{" "}
                        {{ tl: "↖", tr: "↗", bl: "↙", br: "↘" }[
                          (sub.revV ? "b" : "t") + (sub.revH ? "r" : "l")
                        ]}{" "}
                        · +{Math.floor(Number(sub.colInc) || 1)}/col ·{" "}
                        {String(sub.rowInc).trim() === ""
                          ? "consecutive"
                          : `+${Math.floor(Number(sub.rowInc) || 1)}/row`}
                      </span>
                    </div>
                    <div className="num-grid">
                      <label title="First plot number">
                        Start #
                        <input type="number" value={sub.startNo} onChange={setSubF("startNo")} />
                      </label>
                      <label title="Amount added moving across each column">
                        +/col
                        <input type="number" value={sub.colInc} onChange={setSubF("colInc")} />
                      </label>
                      <label title="Amount added moving down each row. Blank = continue consecutively.">
                        +/row
                        <input
                          type="number"
                          value={sub.rowInc}
                          onChange={setSubF("rowInc")}
                          placeholder={`${grid.cols * (Math.floor(Number(sub.colInc) || 1))}`}
                        />
                      </label>
                      <div className="corner-inline" title="Where the start number sits">
                        <span className="lbl">Corner</span>
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
                                type="button"
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
                    </div>
                    <p className="hint-line">
                      Blank +/row continues consecutively. Odd/even per row: +/col 2, +/row 1.
                    </p>
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
                      Type
                      <select value={sub.plot_type} onChange={setSubF("plot_type")}>
                        {Object.keys(TYPE_COLORS).map((t) => (
                          <option key={t} value={t}>
                            {t}
                          </option>
                        ))}
                      </select>
                    </label>
                  </div>

                  <div className="street-sec">
                    <div className="row-between">
                      <span className="lbl">Street</span>
                      <select value={sub.streetMode} onChange={setSubF("streetMode")}>
                        <option value="same">Same for block</option>
                        <option value="row">Per row</option>
                      </select>
                    </div>
                    {sub.streetMode === "same" ? (
                      <input value={sub.street} onChange={setSubF("street")} placeholder="5" />
                    ) : (
                      <div className="street-rows">
                        {Array.from({ length: grid.rows }).map((_, i) => (
                          <label key={i} className="street-row">
                            <span>Row {i + 1}</span>
                            <input
                              value={sub.streetRows[i] || ""}
                              onChange={(e) =>
                                setSub({
                                  ...sub,
                                  streetRows: { ...sub.streetRows, [i]: e.target.value },
                                })
                              }
                              placeholder="5"
                            />
                          </label>
                        ))}
                      </div>
                    )}
                  </div>

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
            <div className="list-subhead">
              <span className="muted small">
                {query || fStatus !== "all" || fType !== "all"
                  ? `Showing ${visibleFeatures.length} of ${features.length}`
                  : `${features.length} total`}
              </span>
              {visibleFeatures.length > 0 && (
                <button className="mini-btn" onClick={() => selectAllShown(visibleFeatures)}>
                  Select shown
                </button>
              )}
            </div>

            <ul className="list plot-list">
              {visibleFeatures.map((f) => (
                <li
                  key={f.properties.id}
                  className={
                    "plot-row" +
                    (selected?.id === f.properties.id ? " sel" : "") +
                    (multiSel.has(f.properties.id) ? " multisel" : "")
                  }
                  onClick={(e) => selectPlot(f.properties, e.shiftKey)}
                >
                  <input
                    type="checkbox"
                    className="row-check"
                    checked={multiSel.has(f.properties.id)}
                    onClick={(e) => e.stopPropagation()}
                    onChange={() => toggleMulti(f.properties.id)}
                  />
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
