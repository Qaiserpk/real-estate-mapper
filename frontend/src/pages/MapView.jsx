import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { MapContainer, GeoJSON } from "react-leaflet";
import BaseLayer, { HAS_VECTOR } from "../BaseLayer.jsx";
import {
  colorFor,
  areaBreakdown,
  formatPKR,
  formatSize,
  STATUS_COLORS,
  STATUS_LABELS,
} from "../status.js";

const LANGUAGES = [
  { code: "en", label: "English" },
  { code: "ur", label: "اردو" },
  { code: "native", label: "Native" },
];

export default function MapView() {
  const [society, setSociety] = useState(null);
  const [plots, setPlots] = useState(null);
  const [selected, setSelected] = useState(null);
  const [error, setError] = useState(null);
  const [language, setLanguage] = useState("en");

  useEffect(() => {
    fetch("/api/societies")
      .then((r) => r.json())
      .then((list) => {
        if (!list.length) throw new Error("No societies. Run the seed script.");
        return fetch(`/api/societies/${list[0].id}/plots`).then((r) => r.json()).then(
          (fc) => {
            setSociety(list[0]);
            setPlots(fc);
          }
        );
      })
      .catch((e) => setError(e.message));
  }, []);

  const center = useMemo(
    () => (society ? [society.center_lat, society.center_lng] : [31.4805, 74.42]),
    [society]
  );

  const style = (feature) => ({
    color: "#1e293b",
    weight: 1,
    fillColor: colorFor(feature.properties.status),
    fillOpacity: 0.55,
  });

  const onEachFeature = (feature, layer) => {
    layer.on({
      click: () => setSelected(feature.properties),
      mouseover: () => layer.setStyle({ fillOpacity: 0.8 }),
      mouseout: () => layer.setStyle({ fillOpacity: 0.55 }),
    });
    const p = feature.properties;
    layer.bindTooltip(
      `Block ${p.block ?? "—"} · Plot ${p.plot_no ?? "—"}`,
      { sticky: true }
    );
  };

  return (
    <div className="app">
      <div className="topbar">
        <h1>Property Map Platform</h1>
        <span className="society">
          {society ? `${society.name} — ${society.region ?? ""}` : "Loading…"}
        </span>
        {HAS_VECTOR && (
          <select
            className="lang-select"
            value={language}
            onChange={(e) => setLanguage(e.target.value)}
            title="Map label language"
          >
            {LANGUAGES.map((l) => (
              <option key={l.code} value={l.code}>
                {l.label}
              </option>
            ))}
          </select>
        )}
        <Link to="/admin" className="admin-link">
          Admin
        </Link>
      </div>

      <div className="main">
        <div className="map">
          <MapContainer
            center={center}
            zoom={society?.default_zoom ?? 17}
            style={{ height: "100%" }}
            maxZoom={24}
          >
            <BaseLayer language={language} />
            {plots && (
              <GeoJSON
                key={society?.id}
                data={plots}
                style={style}
                onEachFeature={onEachFeature}
              />
            )}
          </MapContainer>
        </div>

        <SidePanel society={society} selected={selected} error={error} />
      </div>
    </div>
  );
}

function SidePanel({ society, selected, error }) {
  if (error) {
    return (
      <div className="panel">
        <h2>Something went wrong</h2>
        <p className="muted">{error}</p>
      </div>
    );
  }

  if (!selected) {
    return (
      <div className="panel">
        <h2>Plots</h2>
        <p className="muted">Click a plot on the map to see its details.</p>
        <div className="legend">
          {Object.keys(STATUS_COLORS).map((s) => (
            <div className="item" key={s}>
              <span className="swatch" style={{ background: STATUS_COLORS[s] }} />
              {STATUS_LABELS[s]}
            </div>
          ))}
        </div>
      </div>
    );
  }

  const area = areaBreakdown(
    selected.area_sqft,
    society?.sqft_per_marla,
    society?.marla_per_kanal
  );

  return (
    <div className="panel">
      <h2>
        Block {selected.block ?? "—"} · Plot {selected.plot_no ?? "—"}
      </h2>
      <span className="badge" style={{ background: colorFor(selected.status) }}>
        {STATUS_LABELS[selected.status] ?? selected.status}
      </span>

      <div style={{ marginTop: 12 }}>
        <Row k="Type" v={selected.plot_type} />
        <Row k="Size" v={formatSize(selected)} />
        {area && (
          <Row
            k="Area"
            v={
              <span
                title={`${area.marla} marla · ${area.kanal} kanal`}
                className="tooltip-units"
              >
                {area.sqft.toLocaleString()} sq ft ▾
              </span>
            }
          />
        )}
        <Row k="Min price" v={formatPKR(selected.min_price)} />
        <Row k="Source" v={selected.source} />
        <Row k="Plot ID" v={selected.id} />
      </div>

      <p className="muted" style={{ marginTop: 16 }}>
        Claim / offer actions arrive in later phases (auth, ownership, offers).
      </p>
    </div>
  );
}

function Row({ k, v }) {
  return (
    <div className="row">
      <span className="k">{k}</span>
      <span className="v">{v}</span>
    </div>
  );
}
