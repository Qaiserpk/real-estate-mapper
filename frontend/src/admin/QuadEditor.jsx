import { useMemo, useRef } from "react";
import { Marker, Polygon, useMap } from "react-leaflet";
import L from "leaflet";

// Handles: round corner dots, bar edge handles, and a distinct rotate icon.
const cornerIcon = L.divIcon({
  className: "qe-handle qe-corner",
  iconSize: [16, 16],
  iconAnchor: [8, 8],
});
const edgeIcon = L.divIcon({
  className: "qe-handle qe-edge",
  iconSize: [20, 20],
  iconAnchor: [10, 10],
});
const rotateIcon = L.divIcon({
  className: "qe-handle qe-rotate",
  html: "⟳",
  iconSize: [30, 30],
  iconAnchor: [15, 15],
});

const toLatLng = (c) => [c[1], c[0]]; // [lng,lat] -> [lat,lng]

function centroid(corners) {
  const n = corners.length;
  return [
    corners.reduce((a, c) => a + c[0], 0) / n,
    corners.reduce((a, c) => a + c[1], 0) / n,
  ];
}

// Editable quad: drag corners, slide edges to resize, rotate the whole block.
export default function QuadEditor({ corners, onChange }) {
  const map = useMap();
  const rot = useRef(null);

  const P = (c) => map.latLngToLayerPoint(L.latLng(c[1], c[0])); // [lng,lat]->pt
  const LL = (pt) => {
    const ll = map.layerPointToLatLng(pt);
    return [ll.lng, ll.lat];
  };

  const setCorner = (i, e) => {
    const ll = e.target.getLatLng();
    onChange(corners.map((c, idx) => (idx === i ? [ll.lng, ll.lat] : c)));
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
    onChange(next);
  };

  const onRotStart = (e) => {
    const c = centroid(corners);
    const cp = P(c);
    const d = map.latLngToLayerPoint(e.target.getLatLng());
    rot.current = {
      start: corners.map((x) => x.slice()),
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
    const next = rot.current.start.map((pt) => {
      const p = P(pt);
      const dx = p.x - cp.x;
      const dy = p.y - cp.y;
      return LL({ x: cp.x + dx * cos - dy * sin, y: cp.y + dx * sin + dy * cos });
    });
    onChange(next);
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

  // Rotate handle sits just outside the first edge's midpoint.
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

  return (
    <>
      <Polygon
        positions={corners.map(toLatLng)}
        pathOptions={{ color: "#7c3aed", weight: 2, fill: false }}
      />
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
