import { useEffect, useState } from "react";
import { api } from "../api.js";
import { formatPKR } from "../status.js";

const FILTERS = ["pending", "approved", "rejected", ""];
const LABEL = { pending: "Pending", approved: "Approved", rejected: "Rejected", "": "All" };

const plotLabel = (p) =>
  [p.block && `Block ${p.block}`, p.street && `Street ${p.street}`, `Plot ${p.plot_no ?? p.id}`]
    .filter(Boolean)
    .join(" · ");

export default function AgreementsPage() {
  const [societies, setSocieties] = useState([]);
  const [societyId, setSocietyId] = useState(null);
  const [filter, setFilter] = useState("pending");
  const [rows, setRows] = useState([]);
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
      .listSocietyAgreements(societyId, filter || undefined)
      .then(setRows)
      .catch((e) => setError(e.message));
  };
  useEffect(load, [societyId, filter]);

  async function review(a, decision) {
    const note = window.prompt(
      decision === "approve" ? "Approval note (optional):" : "Reason (optional):",
      ""
    );
    if (note === null) return;
    try {
      await api.reviewAgreement(a.id, { decision, note: note || null });
      load();
    } catch (e) {
      setError(e.message);
    }
  }

  return (
    <div className="admin-page">
      <div className="page-head">
        <h1>Sale agreements</h1>
        {societies.length > 1 && (
          <select value={societyId ?? ""} onChange={(e) => setSocietyId(Number(e.target.value))}>
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
          <button key={f || "all"} className={filter === f ? "on" : ""} onClick={() => setFilter(f)}>
            {LABEL[f]}
          </button>
        ))}
      </div>

      {error && <p className="error">{error}</p>}
      {rows.length === 0 && <p className="muted">No agreements here.</p>}

      <div className="claim-list">
        {rows.map((a) => (
          <div className="card claim-card" key={a.id}>
            <div className="claim-head">
              <strong>{plotLabel(a.plot)}</strong>
              <span className={`pill agreement-${a.status}`}>{a.status}</span>
            </div>
            <div className="deal-figures">
              <span>Agreed {formatPKR(a.amount)}</span>
            </div>
            <div className="muted small">
              Seller: <b>{a.owner.full_name || `#${a.owner.id}`}</b> · Buyer:{" "}
              <b>{a.buyer.full_name || `#${a.buyer.id}`}</b>
            </div>
            {a.review_note && (
              <p className="muted small">
                <b>Note:</b> {a.review_note}
              </p>
            )}
            {a.status === "pending" && (
              <div className="btn-row" style={{ marginTop: 10 }}>
                <button className="btn-primary" onClick={() => review(a, "approve")}>
                  Approve — reveal contacts
                </button>
                <button className="btn-link danger" onClick={() => review(a, "reject")}>
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
