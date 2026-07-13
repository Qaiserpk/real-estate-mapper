import { useEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { api, setLastSociety } from "../api.js";
import { useAuth } from "../auth.jsx";

export default function SocietyDetailPage() {
  const { id } = useParams();
  const { user } = useAuth();
  const [society, setSociety] = useState(null);
  const [maps, setMaps] = useState([]);
  const [error, setError] = useState(null);
  const [uploading, setUploading] = useState(false);
  const [editing, setEditing] = useState(false);
  const fileRef = useRef(null);

  const loadMaps = () => api.listMaps(id).then(setMaps).catch((e) => setError(e.message));

  useEffect(() => {
    setLastSociety(id); // remember this as the society being worked on
    api.getSociety(id).then(setSociety).catch((e) => setError(e.message));
    loadMaps();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  const onUpload = async (e) => {
    e.preventDefault();
    const file = fileRef.current?.files?.[0];
    if (!file) return;
    setUploading(true);
    setError(null);
    try {
      await api.uploadMap(id, file);
      fileRef.current.value = "";
      loadMaps();
    } catch (e) {
      setError(e.message);
    } finally {
      setUploading(false);
    }
  };

  if (!society) {
    return (
      <div className="admin-page">
        {error ? <p className="error">{error}</p> : <p className="muted">Loading…</p>}
      </div>
    );
  }

  return (
    <div className="admin-page">
      <p>
        <Link to="/admin">← Societies</Link>
      </p>
      <div className="page-head">
        <div>
          <h1>{society.name}</h1>
          <p className="muted">
            {society.region || "—"} · center {society.center_lat.toFixed(4)},{" "}
            {society.center_lng.toFixed(4)} · zoom {society.default_zoom} ·{" "}
            <span className={`pill pill-${society.status}`}>{society.status}</span>
          </p>
        </div>
        {user?.is_superadmin && !editing && (
          <button className="btn-outline" onClick={() => setEditing(true)}>
            Edit details
          </button>
        )}
      </div>

      {editing && (
        <SocietyEditForm
          society={society}
          onCancel={() => setEditing(false)}
          onSaved={(s) => {
            setSociety(s);
            setEditing(false);
          }}
        />
      )}

      {/* Map-setup steps: upload → georeference → extract → confirm */}
      <ol className="steps">
        <li className="active">1 · Upload map</li>
        <li>2 · Georeference</li>
        <li>3 · Extract plots</li>
        <li>4 · Confirm</li>
      </ol>

      <div className="admin-grid">
        <section className="card">
          <h2>Upload a map drawing</h2>
          <p className="muted">PNG or JPEG of the society layout / plot map.</p>
          <form onSubmit={onUpload} className="form">
            <input ref={fileRef} type="file" accept="image/png,image/jpeg" required />
            {error && <p className="error">{error}</p>}
            <button disabled={uploading} type="submit">
              {uploading ? "Uploading…" : "Upload"}
            </button>
          </form>
        </section>

        <section className="card">
          <h2>Map sources</h2>
          {maps.length === 0 && <p className="muted">No maps uploaded yet.</p>}
          <ul className="maps">
            {maps.map((m) => (
              <li key={m.id} className="map-item">
                <img src={m.image_url} alt={m.original_name || "map"} />
                <div>
                  <strong>{m.original_name || `map #${m.id}`}</strong>
                  <div className="muted">
                    {m.width}×{m.height}px · {m.status}
                    {m.transform ? " · ✓ georeferenced" : ""}
                  </div>
                  <div className="btn-row">
                    <Link className="btn-link" to={`/admin/maps/${m.id}/georeference`}>
                      {m.transform ? "Edit georeference →" : "Georeference →"}
                    </Link>
                    {m.transform && (
                      <Link className="btn-link" to={`/admin/maps/${m.id}/extract`}>
                        Extract plots →
                      </Link>
                    )}
                  </div>
                </div>
              </li>
            ))}
          </ul>
        </section>
      </div>
    </div>
  );
}

function SocietyEditForm({ society, onCancel, onSaved }) {
  const [form, setForm] = useState({
    name: society.name ?? "",
    region: society.region ?? "",
    center_lat: society.center_lat,
    center_lng: society.center_lng,
    default_zoom: society.default_zoom,
    status: society.status,
    sqft_per_marla: society.sqft_per_marla,
    marla_per_kanal: society.marla_per_kanal,
    default_counter_limit: society.default_counter_limit,
  });
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });

  const save = async (e) => {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      const updated = await api.updateSociety(society.id, {
        name: form.name,
        region: form.region || null,
        center_lat: Number(form.center_lat),
        center_lng: Number(form.center_lng),
        default_zoom: Number(form.default_zoom),
        status: form.status,
        sqft_per_marla: Number(form.sqft_per_marla),
        marla_per_kanal: Number(form.marla_per_kanal),
        default_counter_limit: Number(form.default_counter_limit),
      });
      onSaved(updated);
    } catch (e) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="card society-edit">
      <h2>Edit society details</h2>
      <form onSubmit={save} className="form">
        <label>
          Name
          <input value={form.name} onChange={set("name")} required />
        </label>
        <label>
          Region
          <input value={form.region} onChange={set("region")} placeholder="City, Province" />
        </label>
        <div className="two">
          <label>
            Center latitude
            <input type="number" step="any" value={form.center_lat} onChange={set("center_lat")} required />
          </label>
          <label>
            Center longitude
            <input type="number" step="any" value={form.center_lng} onChange={set("center_lng")} required />
          </label>
        </div>
        <div className="two">
          <label>
            Default zoom
            <input type="number" value={form.default_zoom} onChange={set("default_zoom")} />
          </label>
          <label>
            Status
            <select value={form.status} onChange={set("status")}>
              <option value="active">active</option>
              <option value="archived">archived</option>
            </select>
          </label>
        </div>
        <div className="two">
          <label>
            Sq ft per marla
            <input type="number" step="any" value={form.sqft_per_marla} onChange={set("sqft_per_marla")} />
          </label>
          <label>
            Marla per kanal
            <input type="number" value={form.marla_per_kanal} onChange={set("marla_per_kanal")} />
          </label>
        </div>
        <label>
          Default counter-offer limit
          <input type="number" value={form.default_counter_limit} onChange={set("default_counter_limit")} />
        </label>
        {err && <p className="error">{err}</p>}
        <div className="two">
          <button disabled={busy} type="submit">
            {busy ? "Saving…" : "Save changes"}
          </button>
          <button type="button" className="ghost" onClick={onCancel}>
            Cancel
          </button>
        </div>
      </form>
    </section>
  );
}
