import { useEffect, useRef } from "react";
import { useMap } from "react-leaflet";
import L from "leaflet";
import { overlayCorners } from "./geo.js";

// The plugin references a bare global `L` at load time and has no ESM/UMD wrapper,
// so expose L on window and load it dynamically before first use.
let rotatedReady = null;
export function ensureRotatedPlugin() {
  if (!rotatedReady) {
    window.L = L;
    rotatedReady = import("leaflet-imageoverlay-rotated");
  }
  return rotatedReady;
}

const NO_ADJUST = { dx: 0, dy: 0, rot: 0, scale: 1 };

// Apply a temporary similarity transform (pixel translate + rotate + scale about
// the overlay centre) to the base affine corners. Used to nudge the reference
// image into local alignment without changing the saved georeference.
function adjustedCorners(map, transform, width, height, adj) {
  const base = overlayCorners(transform, width, height); // {topLeft,topRight,bottomLeft} [lat,lng]
  if (!adj || (adj.dx === 0 && adj.dy === 0 && adj.rot === 0 && adj.scale === 1)) {
    return base;
  }
  const P = (ll) => map.latLngToLayerPoint(L.latLng(ll));
  const LL = (pt) => {
    const p = map.layerPointToLatLng(pt);
    return [p.lat, p.lng];
  };
  const tl = P(base.topLeft);
  const tr = P(base.topRight);
  const bl = P(base.bottomLeft);
  const br = { x: tr.x + bl.x - tl.x, y: tr.y + bl.y - tl.y };
  const cx = (tl.x + tr.x + bl.x + br.x) / 4;
  const cy = (tl.y + tr.y + bl.y + br.y) / 4;
  const t = (adj.rot * Math.PI) / 180;
  const cos = Math.cos(t);
  const sin = Math.sin(t);
  const s = adj.scale || 1;
  const tf = (p) => {
    const x = (p.x - cx) * s;
    const y = (p.y - cy) * s;
    return { x: cx + (x * cos - y * sin) + adj.dx, y: cy + (x * sin + y * cos) + adj.dy };
  };
  return {
    topLeft: LL(tf(tl)),
    topRight: LL(tf(tr)),
    bottomLeft: LL(tf(bl)),
  };
}

// Drapes a georeferenced drawing over the map using its affine corners, with an
// optional temporary alignment nudge.
export default function RotatedOverlay({
  imageUrl,
  transform,
  width,
  height,
  opacity,
  adjust = NO_ADJUST,
}) {
  const map = useMap();
  const ref = useRef(null);
  const adjRef = useRef(adjust);
  adjRef.current = adjust;

  useEffect(() => {
    if (!transform) return;
    let cancelled = false;
    ensureRotatedPlugin().then(() => {
      if (cancelled) return;
      const c = adjustedCorners(map, transform, width, height, adjRef.current);
      const layer = L.imageOverlay.rotated(
        imageUrl,
        L.latLng(c.topLeft),
        L.latLng(c.topRight),
        L.latLng(c.bottomLeft),
        { opacity }
      );
      layer.addTo(map);
      ref.current = layer;
    });
    return () => {
      cancelled = true;
      if (ref.current) {
        map.removeLayer(ref.current);
        ref.current = null;
      }
    };
  }, [map, imageUrl, transform, width, height]);

  // Reposition (not rebuild) when the temporary alignment changes.
  useEffect(() => {
    if (!ref.current || !transform) return;
    const c = adjustedCorners(map, transform, width, height, adjust);
    ref.current.reposition(L.latLng(c.topLeft), L.latLng(c.topRight), L.latLng(c.bottomLeft));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [adjust.dx, adjust.dy, adjust.rot, adjust.scale]);

  useEffect(() => {
    if (ref.current) ref.current.setOpacity(opacity);
  }, [opacity]);

  return null;
}
