import { useState } from "react";
import { api } from "../api.js";

export default function ListingModal({ plot, listing, onClose, onDone }) {
  const editing = !!listing;
  const [form, setForm] = useState({
    asking_price: listing?.asking_price ?? "",
    floor_price: listing?.floor_price ?? "",
    description: listing?.description ?? "",
  });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });

  const label = [
    plot.block && `Block ${plot.block}`,
    plot.street && `Street ${plot.street}`,
    `Plot ${plot.plot_no ?? plot.id}`,
  ]
    .filter(Boolean)
    .join(" · ");

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    const body = {
      asking_price: Number(form.asking_price),
      floor_price: form.floor_price ? Number(form.floor_price) : null,
      description: form.description || null,
    };
    try {
      const res = editing
        ? await api.updateListing(listing.id, body)
        : await api.createListing(plot.id, body);
      onDone(res);
    } catch (e) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <form className="modal" onClick={(e) => e.stopPropagation()} onSubmit={submit}>
        <h2>{editing ? "Edit listing" : "List for sale"}</h2>
        <p className="muted">{label}</p>

        <label>
          Asking price (PKR)
          <input
            type="number"
            value={form.asking_price}
            onChange={set("asking_price")}
            required
            min="1"
            placeholder="10000000"
          />
        </label>
        <label>
          Floor price — your private minimum (optional)
          <input
            type="number"
            value={form.floor_price}
            onChange={set("floor_price")}
            min="1"
            placeholder="8000000"
          />
        </label>
        <p className="muted small">
          Offers below the floor are rejected automatically. Buyers never see
          it.
        </p>
        <label>
          Description (optional)
          <textarea
            rows={3}
            value={form.description}
            onChange={set("description")}
            placeholder="Corner plot, park facing…"
          />
        </label>

        {err && <p className="error">{err}</p>}
        <div className="two">
          <button type="submit" disabled={busy}>
            {busy ? "Saving…" : editing ? "Save changes" : "Publish listing"}
          </button>
          <button type="button" className="ghost" onClick={onClose}>
            Cancel
          </button>
        </div>
      </form>
    </div>
  );
}
