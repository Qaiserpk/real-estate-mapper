import { useEffect, useState } from "react";
import { api } from "../api.js";
import { EvidenceList } from "../pages/ClaimsPage.jsx";

const FILTERS = ["pending", "approved", "rejected", ""];
const FILTER_LABEL = { pending: "Pending", approved: "Approved", rejected: "Rejected", "": "All" };

export default function ClaimsReviewPage() {
  const [societies, setSocieties] = useState([]);
  const [societyId, setSocietyId] = useState(null);
  const [filter, setFilter] = useState("pending");
  const [claims, setClaims] = useState([]);
  const [error, setError] = useState(null);

  useEffect(() => {
    api
      .listSocieties()
      .then((list) => {
        setSocieties(list);
        if (list.length) setSocietyId(list[0].id);
      })
      .catch((e) => setError(e.message));
  }, []);

  const load = () => {
    if (!societyId) return;
    api
      .listSocietyClaims(societyId, filter || undefined)
      .then(setClaims)
      .catch((e) => setError(e.message));
  };
  useEffect(load, [societyId, filter]);

  async function review(claim, decision) {
    const note =
      decision === "reject"
        ? window.prompt("Reason for rejection (optional):", "") ?? ""
        : window.prompt("Approval note (optional):", "") ?? "";
    try {
      await api.reviewClaim(claim.id, { decision, note: note || null });
      load();
    } catch (e) {
      setError(e.message);
    }
  }

  return (
    <div className="admin-page">
      <div className="page-head">
        <h1>Ownership claims</h1>
        {societies.length > 1 && (
          <select
            value={societyId ?? ""}
            onChange={(e) => setSocietyId(Number(e.target.value))}
          >
            {societies.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        )}
      </div>

      <div className="filter-tabs">
        {FILTERS.map((f) => (
          <button
            key={f || "all"}
            className={filter === f ? "on" : ""}
            onClick={() => setFilter(f)}
          >
            {FILTER_LABEL[f]}
          </button>
        ))}
      </div>

      {error && <p className="error">{error}</p>}
      {claims.length === 0 && <p className="muted">No claims here.</p>}

      <div className="claim-list">
        {claims.map((c) => (
          <div className="card claim-card" key={c.id}>
            <div className="claim-head">
              <strong>
                {[
                  c.plot.block && `Block ${c.plot.block}`,
                  c.plot.street && `Street ${c.plot.street}`,
                  `Plot ${c.plot.plot_no ?? c.plot.id}`,
                ]
                  .filter(Boolean)
                  .join(" · ")}
              </strong>
              <span className={`pill claim-${c.status}`}>{c.status}</span>
            </div>

            <div className="claimant">
              <div>
                <b>{c.claimant.full_name || "—"}</b> · {c.claimant.email}
              </div>
              {c.claimant.phone && <div className="muted small">☎ {c.claimant.phone}</div>}
            </div>

            {c.note && <p className="muted small">“{c.note}”</p>}
            {c.review_note && (
              <p className="muted small">
                <b>Decision note:</b> {c.review_note}
              </p>
            )}

            <EvidenceList claim={c} />

            {c.status === "pending" && (
              <div className="btn-row" style={{ marginTop: 10 }}>
                <button className="btn-primary" onClick={() => review(c, "approve")}>
                  Approve — grant ownership
                </button>
                <button className="btn-link danger" onClick={() => review(c, "reject")}>
                  Reject
                </button>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
