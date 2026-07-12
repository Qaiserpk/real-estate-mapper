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

// Drapes a georeferenced drawing over the map using its affine corners.
export default function RotatedOverlay({ imageUrl, transform, width, height, opacity }) {
  const map = useMap();
  const ref = useRef(null);

  useEffect(() => {
    if (!transform) return;
    let cancelled = false;
    ensureRotatedPlugin().then(() => {
      if (cancelled) return;
      const { topLeft, topRight, bottomLeft } = overlayCorners(transform, width, height);
      const layer = L.imageOverlay.rotated(
        imageUrl,
        L.latLng(topLeft),
        L.latLng(topRight),
        L.latLng(bottomLeft),
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

  useEffect(() => {
    if (ref.current) ref.current.setOpacity(opacity);
  }, [opacity]);

  return null;
}
