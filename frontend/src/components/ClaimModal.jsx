import { useState } from "react";
import { api } from "../api.js";

export default function ClaimModal({ plot, onClose, onDone }) {
  const [note, setNote] = useState("");
  const [files, setFiles] = useState([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);

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
      const claim = await api.createClaim(plot.id, { note: note || null });
      for (const f of files) {
        await api.uploadEvidence(claim.id, f);
      }
      onDone(claim);
    } catch (e) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <form
        className="modal claim-modal"
        onClick={(e) => e.stopPropagation()}
        onSubmit={submit}
      >
        <h2>Claim ownership</h2>
        <p className="muted">{label}</p>

        <label>
          Message to the admin (optional)
          <textarea
            rows={3}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Briefly describe your ownership…"
          />
        </label>

        <label>
          Evidence (image or PDF — allotment letter, transfer, CNIC, etc.)
          <input
            type="file"
            accept="image/png,image/jpeg,application/pdf"
            multiple
            onChange={(e) => setFiles(Array.from(e.target.files || []))}
          />
        </label>
        {files.length > 0 && (
          <ul className="file-list">
            {files.map((f, i) => (
              <li key={i}>{f.name}</li>
            ))}
          </ul>
        )}

        <p className="muted small">
          An admin will review your claim and evidence before ownership is
          granted. Your documents are private and visible only to you and the
          reviewing admin.
        </p>

        {err && <p className="error">{err}</p>}

        <div className="two">
          <button type="submit" disabled={busy}>
            {busy ? "Submitting…" : "Submit claim"}
          </button>
          <button type="button" className="ghost" onClick={onClose}>
            Cancel
          </button>
        </div>
      </form>
    </div>
  );
}
