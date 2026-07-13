import { useEffect, useRef } from "react";
import { TileLayer, useMap } from "react-leaflet";
import L from "leaflet";
import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";

const MAPTILER_KEY = import.meta.env.VITE_MAPTILER_KEY;
export const HAS_VECTOR = Boolean(MAPTILER_KEY);

const styleFor = (variant) =>
  variant === "satellite"
    ? `https://api.maptiler.com/maps/hybrid/style.json?key=${MAPTILER_KEY}`
    : `https://api.maptiler.com/maps/streets-v2/style.json?key=${MAPTILER_KEY}`;

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

function VectorBaseLayer({ language, styleUrl }) {
  const map = useMap();
  const glRef = useRef(null);

  useEffect(() => {
    let removed = false;
    ensureBridge().then(() => {
      if (removed) return;
      const gl = L.maplibreGL({ style: styleUrl });
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

// Google raster tiles for reference. NOTE: these direct tile endpoints are
// unofficial and against Google's ToS — fine as an internal reference overlay,
// but production should use the paid Google Map Tiles API with a key.
// lyrs: s = satellite, y = hybrid (satellite + roads/labels), m = roads.
function GoogleLayer({ lyrs }) {
  return (
    <TileLayer
      key={lyrs}
      attribution="Imagery &copy; Google"
      url={`https://mt{s}.google.com/vt/lyrs=${lyrs}&x={x}&y={y}&z={z}`}
      subdomains={["0", "1", "2", "3"]}
      maxZoom={24}
      maxNativeZoom={21}
    />
  );
}

export default function BaseLayer({ language = "en", variant = "streets" }) {
  // Google imagery is raster regardless of whether the MapTiler key is set.
  if (variant === "google") return <GoogleLayer lyrs="s" />;
  if (variant === "google-hybrid") return <GoogleLayer lyrs="y" />;

  if (HAS_VECTOR) {
    // Remount on variant change so the GL style rebuilds cleanly.
    return <VectorBaseLayer key={variant} language={language} styleUrl={styleFor(variant)} />;
  }
  // No key -> raster fallbacks.
  if (variant === "satellite") {
    return (
      <TileLayer
        attribution="Imagery &copy; Esri"
        url="https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}"
        maxZoom={24}
        maxNativeZoom={19}
      />
    );
  }
  return (
    <TileLayer
      attribution="&copy; OpenStreetMap contributors"
      url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
      maxZoom={24}
      maxNativeZoom={19}
    />
  );
}
