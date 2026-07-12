import { useEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { api } from "../api.js";

export default function SocietyDetailPage() {
  const { id } = useParams();
  const [society, setSociety] = useState(null);
  const [maps, setMaps] = useState([]);
  const [error, setError] = useState(null);
  const [uploading, setUploading] = useState(false);
  const fileRef = useRef(null);

  const loadMaps = () => api.listMaps(id).then(setMaps).catch((e) => setError(e.message));

  useEffect(() => {
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
      <h1>{society.name}</h1>
      <p className="muted">
        {society.region || "—"} · center {society.center_lat.toFixed(4)},{" "}
        {society.center_lng.toFixed(4)} · zoom {society.default_zoom}
      </p>

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
