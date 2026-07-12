import { useEffect, useRef } from "react";
import { TileLayer, useMap } from "react-leaflet";
import L from "leaflet";
import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";

const MAPTILER_KEY = import.meta.env.VITE_MAPTILER_KEY;
export const HAS_VECTOR = Boolean(MAPTILER_KEY);

const STYLE_URL = `https://api.maptiler.com/maps/streets-v2/style.json?key=${MAPTILER_KEY}`;

// maplibre-gl-leaflet expects globals `L` and `maplibregl`; load it dynamically after setting them.
let bridgeReady = null;
function ensureBridge() {
  if (!bridgeReady) {
    window.L = L;
    window.maplibregl = maplibregl;
    bridgeReady = import("@maplibre/maplibre-gl-leaflet");
  }
  return bridgeReady;
}

// Rewrite every label layer to the chosen language (falls back to local name).
function applyLanguage(glMap, language) {
  const field =
    language === "native"
      ? ["get", "name"]
      : ["coalesce", ["get", `name:${language}`], ["get", "name"]];
  const layers = glMap.getStyle()?.layers || [];
  for (const lyr of layers) {
    if (lyr.type === "symbol" && lyr.layout && "text-field" in lyr.layout) {
      try {
        glMap.setLayoutProperty(lyr.id, "text-field", field);
      } catch {
        /* layer without a settable text-field */
      }
    }
  }
}

function VectorBaseLayer({ language }) {
  const map = useMap();
  const glRef = useRef(null);

  useEffect(() => {
    let removed = false;
    ensureBridge().then(() => {
      if (removed) return;
      const gl = L.maplibreGL({ style: STYLE_URL });
      gl.addTo(map);
      glRef.current = gl;
      map.attributionControl?.addAttribution(
        '© <a href="https://www.maptiler.com/">MapTiler</a> © OpenStreetMap contributors'
      );
      const glMap = gl.getMaplibreMap();
      const run = () => applyLanguage(glMap, language);
      glMap.isStyleLoaded() ? run() : glMap.once("styledata", run);
    });
    return () => {
      removed = true;
      if (glRef.current) {
        map.removeLayer(glRef.current);
        glRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map]);

  // React to language changes without rebuilding the layer.
  useEffect(() => {
    const gl = glRef.current;
    if (!gl) return;
    const glMap = gl.getMaplibreMap();
    if (glMap?.isStyleLoaded()) applyLanguage(glMap, language);
  }, [language]);

  return null;
}

export default function BaseLayer({ language = "en" }) {
  if (HAS_VECTOR) return <VectorBaseLayer language={language} />;
  // Fallback: raster OpenStreetMap (native-language labels, over-zoom past 19).
  return (
    <TileLayer
      attribution="&copy; OpenStreetMap contributors"
      url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
      maxZoom={24}
      maxNativeZoom={19}
    />
  );
}
