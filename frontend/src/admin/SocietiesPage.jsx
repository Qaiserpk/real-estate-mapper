import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api.js";

const EMPTY = {
  name: "",
  region: "",
  center_lat: 31.4805,
  center_lng: 74.42,
  default_zoom: 17,
};

export default function SocietiesPage() {
  const [societies, setSocieties] = useState([]);
  const [form, setForm] = useState(EMPTY);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  const load = () => api.listSocieties().then(setSocieties).catch((e) => setError(e.message));
  useEffect(() => {
    load();
  }, []);

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.createSociety({
        ...form,
        center_lat: Number(form.center_lat),
        center_lng: Number(form.center_lng),
        default_zoom: Number(form.default_zoom),
      });
      setForm(EMPTY);
      load();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });

  return (
    <div className="admin-page">
      <h1>Societies</h1>
      <p className="muted">
        Each society is a tenant. Create one, then upload and georeference its map.
      </p>

      <div className="admin-grid">
        <section className="card">
          <h2>All societies</h2>
          {societies.length === 0 && <p className="muted">None yet.</p>}
          <ul className="list">
            {societies.map((s) => (
              <li key={s.id}>
                <Link to={`/admin/societies/${s.id}`}>
                  <strong>{s.name}</strong>
                </Link>
                <span className="muted">
                  {" "}
                  · {s.region || "—"} · zoom {s.default_zoom}
                </span>
              </li>
            ))}
          </ul>
        </section>

        <section className="card">
          <h2>New society</h2>
          <form onSubmit={submit} className="form">
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
            <label>
              Default zoom
              <input type="number" value={form.default_zoom} onChange={set("default_zoom")} />
            </label>
            {error && <p className="error">{error}</p>}
            <button disabled={busy} type="submit">
              {busy ? "Creating…" : "Create society"}
            </button>
          </form>
        </section>
      </div>
    </div>
  );
}
