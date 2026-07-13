import { useState } from "react";
import { api } from "../api.js";
import { formatPKR } from "../status.js";

export default function OfferModal({ plot, listing, onClose, onDone }) {
  const [form, setForm] = useState({ amount: "", message: "" });
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
    try {
      const offer = await api.makeOffer(listing.id, {
        amount: Number(form.amount),
        message: form.message || null,
      });
      onDone(offer);
    } catch (e) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <form className="modal" onClick={(e) => e.stopPropagation()} onSubmit={submit}>
        <h2>Make an offer</h2>
        <p className="muted">{label}</p>
        <p className="asking">
          Asking price <strong>{formatPKR(listing.asking_price)}</strong>
        </p>

        <label>
          Your offer (PKR)
          <input
            type="number"
            value={form.amount}
            onChange={set("amount")}
            required
            min="1"
            placeholder={Math.round(listing.asking_price)}
          />
        </label>
        <label>
          Message to the seller (optional)
          <textarea
            rows={2}
            value={form.message}
            onChange={set("message")}
            placeholder="Cash ready, can close this week…"
          />
        </label>

        <p className="muted small">
          The seller can accept, reject, or counter. Contact details are shared
          only after an admin approves the final agreement.
        </p>

        {err && <p className="error">{err}</p>}
        <div className="two">
          <button type="submit" disabled={busy}>
            {busy ? "Sending…" : "Send offer"}
          </button>
          <button type="button" className="ghost" onClick={onClose}>
            Cancel
          </button>
        </div>
      </form>
    </div>
  );
}
