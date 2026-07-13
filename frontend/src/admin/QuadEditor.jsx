import { useEffect, useMemo, useRef } from "react";
import { Marker, Polygon, useMap } from "react-leaflet";
import L from "leaflet";
import { blockOutline } from "../geo.js";

// Handles: round corner dots, bar edge (resize) handles, diamond bulge (arc)
// handles, and a distinct rotate icon.
const cornerIcon = L.divIcon({ className: "qe-handle qe-corner", iconSize: [16, 16], iconAnchor: [8, 8] });
const edgeIcon = L.divIcon({ className: "qe-handle qe-edge", iconSize: [20, 20], iconAnchor: [10, 10] });
const bulgeIcon = L.divIcon({ className: "qe-handle qe-bulge", iconSize: [16, 16], iconAnchor: [8, 8] });
const rotateIcon = L.divIcon({ className: "qe-handle qe-rotate", html: "⟳", iconSize: [30, 30], iconAnchor: [15, 15] });

const toLatLng = (c) => [c[1], c[0]]; // [lng,lat] -> [lat,lng]

function centroid(corners) {
  const n = corners.length;
  return [
    corners.reduce((a, c) => a + c[0], 0) / n,
    corners.reduce((a, c) => a + c[1], 0) / n,
  ];
}

// Editable block: drag corners, slide edges to resize, drag the diamond to bulge
// an edge into an arc (double-click it to straighten), rotate the whole block.
export default function QuadEditor({ corners, edgeThrough, onChange }) {
  const map = useMap();
  const rot = useRef(null);
  const ET = edgeThrough || [null, null, null, null];

  // Curving uses double-click; keep the map's own double-click zoom out of the way.
  useEffect(() => {
    map.doubleClickZoom.disable();
    return () => {
      try {
        map.doubleClickZoom.enable();
      } catch {
        /* noop */
      }
    };
  }, [map]);

  const P = (c) => map.latLngToLayerPoint(L.latLng(c[1], c[0])); // [lng,lat]->pt
  const LL = (pt) => {
    const ll = map.layerPointToLatLng(pt);
    return [ll.lng, ll.lat];
  };

  const setCorner = (i, e) => {
    const ll = e.target.getLatLng();
    onChange(
      corners.map((c, idx) => (idx === i ? [ll.lng, ll.lat] : c)),
      ET
    );
  };

  // Slide the whole edge along its normal -> increases/decreases that dimension.
  const moveEdge = (i, e) => {
    const j = (i + 1) % corners.length;
    const p0 = P(corners[i]);
    const p1 = P(corners[j]);
    const mid = { x: (p0.x + p1.x) / 2, y: (p0.y + p1.y) / 2 };
    const d = map.latLngToLayerPoint(e.target.getLatLng());
    let nx = -(p1.y - p0.y);
    let ny = p1.x - p0.x;
    const len = Math.hypot(nx, ny) || 1;
    nx /= len;
    ny /= len;
    const proj = (d.x - mid.x) * nx + (d.y - mid.y) * ny;
    const next = corners.slice();
    next[i] = LL({ x: p0.x + nx * proj, y: p0.y + ny * proj });
    next[j] = LL({ x: p1.x + nx * proj, y: p1.y + ny * proj });
    onChange(next, ET);
  };

  const setBulge = (i, e) => {
    const ll = e.target.getLatLng();
    onChange(corners, ET.map((t, idx) => (idx === i ? [ll.lng, ll.lat] : t)));
  };
  const straighten = (i) => {
    onChange(corners, ET.map((t, idx) => (idx === i ? null : t)));
  };

  const rotatePt = (pt, cp, cos, sin) => {
    const p = P(pt);
    const dx = p.x - cp.x;
    const dy = p.y - cp.y;
    return LL({ x: cp.x + dx * cos - dy * sin, y: cp.y + dx * sin + dy * cos });
  };
  const onRotStart = (e) => {
    const c = centroid(corners);
    const cp = P(c);
    const d = map.latLngToLayerPoint(e.target.getLatLng());
    rot.current = {
      corners: corners.map((x) => x.slice()),
      through: ET.map((t) => (t ? t.slice() : null)),
      c,
      angle: Math.atan2(d.y - cp.y, d.x - cp.x),
    };
  };
  const onRot = (e) => {
    if (!rot.current) return;
    const cp = P(rot.current.c);
    const d = map.latLngToLayerPoint(e.target.getLatLng());
    const delta = Math.atan2(d.y - cp.y, d.x - cp.x) - rot.current.angle;
    const cos = Math.cos(delta);
    const sin = Math.sin(delta);
    const nextC = rot.current.corners.map((pt) => rotatePt(pt, cp, cos, sin));
    const nextT = rot.current.through.map((t) => (t ? rotatePt(t, cp, cos, sin) : null));
    onChange(nextC, nextT);
  };

  const edgeMids = useMemo(
    () =>
      corners.map((c, i) => {
        const j = (i + 1) % corners.length;
        const p0 = P(c);
        const p1 = P(corners[j]);
        return LL({ x: (p0.x + p1.x) / 2, y: (p0.y + p1.y) / 2 });
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [corners, map]
  );

  // Bulge handle sits at the arc apex (through-point), or just outside the edge
  // midpoint when the edge is still straight.
  const bulgePos = useMemo(
    () =>
      corners.map((c, i) => {
        if (ET[i]) return ET[i];
        const j = (i + 1) % corners.length;
        const p0 = P(c);
        const p1 = P(corners[j]);
        const mid = { x: (p0.x + p1.x) / 2, y: (p0.y + p1.y) / 2 };
        const cp = P(centroid(corners));
        let ox = mid.x - cp.x;
        let oy = mid.y - cp.y;
        const l = Math.hypot(ox, oy) || 1;
        ox /= l;
        oy /= l;
        const edgeLen = Math.hypot(p1.x - p0.x, p1.y - p0.y);
        return LL({ x: mid.x + ox * edgeLen * 0.14, y: mid.y + oy * edgeLen * 0.14 });
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [corners, edgeThrough, map]
  );

  const rotPos = useMemo(() => {
    const cp = P(centroid(corners));
    const e0 = P(edgeMids[0]);
    let ox = e0.x - cp.x;
    let oy = e0.y - cp.y;
    const len = Math.hypot(ox, oy) || 1;
    ox /= len;
    oy /= len;
    return LL({ x: e0.x + ox * 34, y: e0.y + oy * 34 });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [corners, edgeMids, map]);

  const outline = useMemo(
    () => blockOutline(corners, ET).map(toLatLng),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [corners, edgeThrough]
  );

  return (
    <>
      <Polygon positions={outline} pathOptions={{ color: "#7c3aed", weight: 2, fill: false }} />
      {corners.map((c, i) => (
        <Marker
          key={`c${i}`}
          position={toLatLng(c)}
          icon={cornerIcon}
          draggable
          eventHandlers={{ drag: (e) => setCorner(i, e), dragend: (e) => setCorner(i, e) }}
        />
      ))}
      {edgeMids.map((m, i) => (
        <Marker
          key={`e${i}`}
          position={toLatLng(m)}
          icon={edgeIcon}
          draggable
          eventHandlers={{ drag: (e) => moveEdge(i, e) }}
        />
      ))}
      {bulgePos.map((m, i) => (
        <Marker
          key={`b${i}`}
          position={toLatLng(m)}
          icon={bulgeIcon}
          draggable
          eventHandlers={{
            drag: (e) => setBulge(i, e),
            dblclick: () => straighten(i),
          }}
        />
      ))}
      <Marker
        position={toLatLng(rotPos)}
        icon={rotateIcon}
        draggable
        eventHandlers={{
          dragstart: onRotStart,
          drag: onRot,
          dragend: () => {
            rot.current = null;
          },
        }}
      />
    </>
  );
}
