import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import {
  MapContainer,
  CircleMarker,
  Tooltip,
  useMap,
  useMapEvents,
} from "react-leaflet";
import { api } from "../api.js";
import RotatedOverlay from "../RotatedOverlay.jsx";
import BaseLayer from "../BaseLayer.jsx";
import { residualMeters, rmsMeters } from "../geo.js";

// On first load, frame the existing control points instead of the society center.
function FitToPoints({ points }) {
  const lmap = useMap();
  const done = useRef(false);
  useEffect(() => {
    if (done.current) return;
    done.current = true;
    const pts = points.filter((p) => p.lat != null).map((p) => [p.lat, p.lng]);
    if (pts.length >= 2) {
      lmap.fitBounds(pts, { padding: [40, 40] });
    } else if (pts.length === 1) {
      lmap.setView(pts[0], lmap.getZoom());
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  return null;
}

// Map pane: double-click registers a point; Ctrl+wheel zooms (drag pans as usual).
function MapInteractions({ onRegister }) {
  const lmap = useMap();
  useMapEvents({ dblclick: (e) => onRegister(e.latlng) });
  useEffect(() => {
    const c = lmap.getContainer();
    const onWheel = (e) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      const ll = lmap.containerPointToLatLng(lmap.mouseEventToContainerPoint(e));
      lmap.setZoomAround(ll, lmap.getZoom() + (e.deltaY < 0 ? 1 : -1));
    };
    c.addEventListener("wheel", onWheel, { passive: false });
    return () => c.removeEventListener("wheel", onWheel);
  }, [lmap]);
  return null;
}

export default function GeoreferencePage() {
  const { mapId } = useParams();
  const [map, setMap] = useState(null);
  const [society, setSociety] = useState(null);
  const [points, setPoints] = useState([]); // {px,py,lat,lng}
  const [pending, setPending] = useState(null); // partial {px,py} or {lat,lng}
  const [transform, setTransform] = useState(null);
  const [showOverlay, setShowOverlay] = useState(false);
  const [opacity, setOpacity] = useState(0.6);
  const [baseVariant, setBaseVariant] = useState("streets");
  const [msg, setMsg] = useState(null);
  const [error, setError] = useState(null);
  const [saving, setSaving] = useState(false);
  const [zoom, setZoom] = useState(1);
  const imgRef = useRef(null);
  const wrapRef = useRef(null);
  const zoomRef = useRef(1);
  const pendingScroll = useRef(null);

  useEffect(() => {
    zoomRef.current = zoom;
  }, [zoom]);

  // Keep the point under the cursor stationary after a Ctrl+wheel zoom.
  useLayoutEffect(() => {
    if (pendingScroll.current && wrapRef.current) {
      wrapRef.current.scrollLeft = pendingScroll.current.x;
      wrapRef.current.scrollTop = pendingScroll.current.y;
      pendingScroll.current = null;
    }
  }, [zoom]);

  // Drawing pane: Ctrl+wheel zoom (cursor-anchored) + drag-to-pan.
  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    const clamp = (z) => Math.min(20, Math.max(1, z));

    const onWheel = (e) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      const prev = zoomRef.current;
      const next = clamp(+(prev * (e.deltaY < 0 ? 1.2 : 1 / 1.2)).toFixed(3));
      if (next === prev) return;
      const rect = wrap.getBoundingClientRect();
      const cx = e.clientX - rect.left;
      const cy = e.clientY - rect.top;
      const k = next / prev;
      pendingScroll.current = {
        x: (wrap.scrollLeft + cx) * k - cx,
        y: (wrap.scrollTop + cy) * k - cy,
      };
      setZoom(next);
    };

    let dragging = false, sx = 0, sy = 0, sl = 0, st = 0;
    const onDown = (e) => {
      if (e.button !== 0) return;
      dragging = true;
      sx = e.clientX;
      sy = e.clientY;
      sl = wrap.scrollLeft;
      st = wrap.scrollTop;
      wrap.classList.add("grabbing");
    };
    const onMove = (e) => {
      if (!dragging) return;
      wrap.scrollLeft = sl - (e.clientX - sx);
      wrap.scrollTop = st - (e.clientY - sy);
    };
    const onUp = () => {
      dragging = false;
      wrap.classList.remove("grabbing");
    };

    wrap.addEventListener("wheel", onWheel, { passive: false });
    wrap.addEventListener("mousedown", onDown);
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      wrap.removeEventListener("wheel", onWheel);
      wrap.removeEventListener("mousedown", onDown);
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    // Re-run once the pane is actually rendered (map/society load after mount).
  }, [map, society]);

  useEffect(() => {
    api
      .getMap(mapId)
      .then((m) => {
        setMap(m);
        if (m.transform) {
          setTransform(m.transform);
          setShowOverlay(true);
        }
        if (m.control_points) setPoints(m.control_points);
        return api.getSociety(m.society_id).then(setSociety);
      })
      .catch((e) => setError(e.message));
  }, [mapId]);

  const onImageDblClick = (e) => {
    const img = imgRef.current;
    const rect = img.getBoundingClientRect();
    const px = ((e.clientX - rect.left) / rect.width) * map.width;
    const py = ((e.clientY - rect.top) / rect.height) * map.height;
    if (pending && pending.lat != null) {
      setPoints([...points, { ...pending, px, py }]);
      setPending(null);
    } else {
      setPending({ px, py });
    }
  };

  const onMapClick = (latlng) => {
    if (pending && pending.px != null) {
      setPoints([...points, { ...pending, lat: latlng.lat, lng: latlng.lng }]);
      setPending(null);
    } else {
      setPending({ lat: latlng.lat, lng: latlng.lng });
    }
  };

  const undo = () => {
    if (pending) return setPending(null);
    setPoints(points.slice(0, -1));
  };

  const removePoint = (i) => setPoints(points.filter((_, idx) => idx !== i));

  const save = async () => {
    setSaving(true);
    setError(null);
    setMsg(null);
    try {
      const updated = await api.georeference(mapId, points);
      setTransform(updated.transform);
      setShowOverlay(true);
      setMsg("Transform computed and saved. Preview overlay enabled.");
    } catch (e) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  };

  if (!map || !society) {
    return (
      <div className="admin-page">
        {error ? <p className="error">{error}</p> : <p className="muted">Loading…</p>}
      </div>
    );
  }

  const hint = pending
    ? pending.px != null
      ? "Now double-click the matching spot on the MAP →"
      : "Now double-click the matching spot on the DRAWING ←"
    : "Double-click a spot on the drawing, then its match on the map. Drag to pan · Ctrl+wheel to zoom.";

  const rms = rmsMeters(transform, points);

  return (
    <div className="admin-page wide">
      <p>
        <Link to={`/admin/societies/${map.society_id}`}>← {society.name}</Link>
      </p>
      <h1>Georeference — {map.original_name || `map #${map.id}`}</h1>

      <ol className="steps">
        <li>1 · Upload map</li>
        <li className="active">2 · Georeference</li>
        <li>3 · Extract plots</li>
        <li>4 · Confirm</li>
      </ol>

      <div className="geo-bar">
        <span className="hint">{hint}</span>
        <span className="count">{points.length} point{points.length === 1 ? "" : "s"} (min 3)</span>
        <button className="ghost" onClick={undo} disabled={!points.length && !pending}>
          Undo
        </button>
        <button onClick={save} disabled={points.length < 3 || saving}>
          {saving
            ? "Saving…"
            : transform
              ? `Recompute with ${points.length} points`
              : "Compute & save transform"}
        </button>
        {rms != null && (
          <span className={"rms " + (rms < 5 ? "good" : rms < 20 ? "ok" : "bad")}>
            RMS error: {rms < 10 ? rms.toFixed(2) : Math.round(rms)} m
          </span>
        )}
        {transform && (
          <label className="overlay-toggle">
            <input
              type="checkbox"
              checked={showOverlay}
              onChange={(e) => setShowOverlay(e.target.checked)}
            />
            Preview overlay
          </label>
        )}
        {transform && showOverlay && (
          <label className="opacity">
            Opacity
            <input
              type="range"
              min="0"
              max="1"
              step="0.05"
              value={opacity}
              onChange={(e) => setOpacity(Number(e.target.value))}
            />
          </label>
        )}
        {transform && (
          <Link className="next-link" to={`/admin/maps/${map.id}/extract`}>
            Next: extract plots →
          </Link>
        )}
      </div>
      {msg && <p className="ok">{msg}</p>}
      {error && <p className="error">{error}</p>}

      {points.length > 0 && (
        <div className="cp-panel">
          <div className="cp-panel-head">
            Control points ({points.length})
            {transform && (
              <span className="muted">
                {" "}
                — add more where the fit is off, then Recompute
              </span>
            )}
          </div>
          <div className="cp-chips">
            {points.map((p, i) => {
              const err = residualMeters(transform, p);
              const cls = err == null ? "" : err < 5 ? "good" : err < 20 ? "ok" : "bad";
              return (
                <span className={"cp-chip " + cls} key={i}>
                  <b>{i + 1}</b>
                  {err != null && <span className="cp-err">{err < 10 ? err.toFixed(1) : Math.round(err)} m</span>}
                  <button title="Remove point" onClick={() => removePoint(i)}>
                    ×
                  </button>
                </span>
              );
            })}
          </div>
        </div>
      )}

      <div className="geo-split">
        <div className="geo-pane">
          <div className="pane-label">
            <span>Drawing</span>
            <span className="zoom-ctl">
              <button
                onClick={() => setZoom((z) => Math.max(1, +(z - 0.5).toFixed(2)))}
                disabled={zoom <= 1}
                title="Zoom out"
              >
                −
              </button>
              <span className="zoom-val">{Math.round(zoom * 100)}%</span>
              <button
                onClick={() => setZoom((z) => Math.min(20, +(z + 0.5).toFixed(2)))}
                disabled={zoom >= 20}
                title="Zoom in"
              >
                +
              </button>
              <button className="fit" onClick={() => setZoom(1)} disabled={zoom === 1}>
                Fit
              </button>
            </span>
          </div>
          <div className="img-wrap grab" ref={wrapRef} onDoubleClick={onImageDblClick}>
            <div className="img-inner" style={{ width: `${zoom * 100}%` }}>
              <img ref={imgRef} src={map.image_url} alt="drawing" draggable={false} />
              {points.map((p, i) => (
                <Dot
                  key={i}
                  n={i + 1}
                  left={(p.px / map.width) * 100}
                  top={(p.py / map.height) * 100}
                />
              ))}
              {pending?.px != null && (
                <Dot
                  n="?"
                  pending
                  left={(pending.px / map.width) * 100}
                  top={(pending.py / map.height) * 100}
                />
              )}
            </div>
          </div>
        </div>

        <div className="geo-pane">
          <div className="pane-label">
            <select
              className="base-select"
              value={baseVariant}
              onChange={(e) => setBaseVariant(e.target.value)}
              title="Base map"
            >
              <option value="streets">Streets</option>
              <option value="satellite">Satellite</option>
              <option value="google">Google Satellite</option>
              <option value="google-hybrid">Google Hybrid</option>
            </select>
            <span className="pane-hint">drag to pan · Ctrl+wheel zoom · double-click to set</span>
          </div>
          <MapContainer
            center={[society.center_lat, society.center_lng]}
            zoom={society.default_zoom}
            style={{ height: "520px" }}
            scrollWheelZoom={false}
            doubleClickZoom={false}
            maxZoom={24}
          >
            <BaseLayer language="en" variant={baseVariant} />
            <MapInteractions onRegister={onMapClick} />
            <FitToPoints points={points} />
            {points.map((p, i) =>
              p.lat != null ? (
                <CircleMarker
                  key={i}
                  center={[p.lat, p.lng]}
                  radius={9}
                  pathOptions={{ color: "#111827", fillColor: "#2563eb", fillOpacity: 1 }}
                >
                  <Tooltip permanent direction="top">{i + 1}</Tooltip>
                </CircleMarker>
              ) : null
            )}
            {pending?.lat != null && (
              <CircleMarker
                center={[pending.lat, pending.lng]}
                radius={9}
                pathOptions={{ color: "#111827", fillColor: "#f59e0b", fillOpacity: 1 }}
              />
            )}
            {showOverlay && transform && (
              <RotatedOverlay
                imageUrl={map.image_url}
                transform={transform}
                width={map.width}
                height={map.height}
                opacity={opacity}
              />
            )}
          </MapContainer>
        </div>
      </div>
    </div>
  );
}

function Dot({ n, left, top, pending }) {
  return (
    <span
      className={"cp-dot" + (pending ? " pending" : "")}
      style={{ left: `${left}%`, top: `${top}%` }}
    >
      {n}
    </span>
  );
}
