import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api.js";
import { useAuth } from "../auth.jsx";

const STATUS_LABEL = {
  pending: "Pending review",
  approved: "Approved — you own this plot",
  rejected: "Rejected",
  withdrawn: "Withdrawn",
};

export default function ClaimsPage() {
  const { user, loading } = useAuth();
  const [claims, setClaims] = useState(null);
  const [error, setError] = useState(null);

  const load = () =>
    api.myClaims().then(setClaims).catch((e) => setError(e.message));

  useEffect(() => {
    if (user) load();
  }, [user]);

  if (loading) return <div className="admin-page">Loading…</div>;
  if (!user)
    return (
      <div className="admin-page">
        <p>
          Please <Link to="/login">sign in</Link> to see your claims.
        </p>
      </div>
    );

  async function withdraw(id) {
    if (!window.confirm("Withdraw this claim?")) return;
    try {
      await api.withdrawClaim(id);
      load();
    } catch (e) {
      setError(e.message);
    }
  }

  return (
    <div className="admin-page">
      <p>
        <Link to="/">← Back to map</Link>
      </p>
      <h1>My claims</h1>
      {error && <p className="error">{error}</p>}
      {claims && claims.length === 0 && (
        <p className="muted">
          You haven’t claimed any plots yet. Open a plot on the map and choose{" "}
          <b>Claim this plot</b>.
        </p>
      )}
      <div className="claim-list">
        {claims?.map((c) => (
          <ClaimCard key={c.id} claim={c} onWithdraw={withdraw} onChange={load} />
        ))}
      </div>
    </div>
  );
}

function ClaimCard({ claim, onWithdraw, onChange }) {
  const label = [
    claim.plot.block && `Block ${claim.plot.block}`,
    claim.plot.street && `Street ${claim.plot.street}`,
    `Plot ${claim.plot.plot_no ?? claim.plot.id}`,
  ]
    .filter(Boolean)
    .join(" · ");

  const [adding, setAdding] = useState(false);

  async function addEvidence(e) {
    const files = Array.from(e.target.files || []);
    if (!files.length) return;
    setAdding(true);
    try {
      for (const f of files) await api.uploadEvidence(claim.id, f);
      onChange();
    } finally {
      setAdding(false);
    }
  }

  return (
    <div className="card claim-card">
      <div className="claim-head">
        <strong>{label}</strong>
        <span className={`pill claim-${claim.status}`}>
          {STATUS_LABEL[claim.status] ?? claim.status}
        </span>
      </div>
      {claim.note && <p className="muted small">“{claim.note}”</p>}
      {claim.review_note && (
        <p className="muted small">
          <b>Admin:</b> {claim.review_note}
        </p>
      )}

      <EvidenceList claim={claim} />

      {claim.status === "pending" && (
        <div className="btn-row" style={{ marginTop: 8 }}>
          <label className="btn-link file-add">
            {adding ? "Uploading…" : "+ Add evidence"}
            <input
              type="file"
              accept="image/png,image/jpeg,application/pdf"
              multiple
              hidden
              onChange={addEvidence}
            />
          </label>
          <button className="btn-link danger" onClick={() => onWithdraw(claim.id)}>
            Withdraw
          </button>
        </div>
      )}
    </div>
  );
}

export function EvidenceList({ claim }) {
  if (!claim.evidence?.length)
    return <p className="muted small">No evidence attached.</p>;
  return (
    <ul className="evidence-list">
      {claim.evidence.map((ev) => (
        <li key={ev.id}>
          <EvidenceLink claim={claim} ev={ev} />
        </li>
      ))}
    </ul>
  );
}

function EvidenceLink({ claim, ev }) {
  const [busy, setBusy] = useState(false);
  async function open() {
    setBusy(true);
    try {
      const url = await api.evidenceBlobUrl(claim.id, ev.id);
      window.open(url, "_blank", "noopener");
    } finally {
      setBusy(false);
    }
  }
  return (
    <button className="evidence-item" onClick={open} disabled={busy}>
      📎 {ev.original_name || `evidence #${ev.id}`}
    </button>
  );
}
