import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api.js";
import { useAuth } from "../auth.jsx";
import { formatPKR } from "../status.js";

const plotLabel = (p) =>
  [p.block && `Block ${p.block}`, p.street && `Street ${p.street}`, `Plot ${p.plot_no ?? p.id}`]
    .filter(Boolean)
    .join(" · ");

export default function DealsPage() {
  const { user, loading } = useAuth();
  const [tab, setTab] = useState("offers");
  const [listings, setListings] = useState([]);
  const [offers, setOffers] = useState([]);
  const [agreements, setAgreements] = useState([]);
  const [error, setError] = useState(null);

  const load = () => {
    api.myListings().then(setListings).catch((e) => setError(e.message));
    api.myOffers().then(setOffers).catch((e) => setError(e.message));
    api.myAgreements().then(setAgreements).catch((e) => setError(e.message));
  };
  useEffect(() => {
    if (user) load();
  }, [user]);

  if (loading) return <div className="admin-page">Loading…</div>;
  if (!user)
    return (
      <div className="admin-page">
        <p>
          Please <Link to="/login">sign in</Link> to see your deals.
        </p>
      </div>
    );

  const tabs = [
    ["offers", `My offers (${offers.length})`],
    ["listings", `My listings (${listings.length})`],
    ["deals", `Agreements (${agreements.length})`],
  ];

  return (
    <div className="admin-page">
      <p>
        <Link to="/">← Back to map</Link>
      </p>
      <h1>My deals</h1>
      {error && <p className="error">{error}</p>}

      <div className="filter-tabs">
        {tabs.map(([k, label]) => (
          <button key={k} className={tab === k ? "on" : ""} onClick={() => setTab(k)}>
            {label}
          </button>
        ))}
      </div>

      {tab === "offers" && (
        <div className="claim-list">
          {offers.length === 0 && <p className="muted">You haven’t made any offers.</p>}
          {offers.map((o) => (
            <BuyerOfferCard key={o.id} offer={o} onChange={load} />
          ))}
        </div>
      )}

      {tab === "listings" && (
        <div className="claim-list">
          {listings.length === 0 && <p className="muted">You have no listings.</p>}
          {listings.map((l) => (
            <ListingCard key={l.id} listing={l} onChange={load} />
          ))}
        </div>
      )}

      {tab === "deals" && (
        <div className="claim-list">
          {agreements.length === 0 && <p className="muted">No agreements yet.</p>}
          {agreements.map((a) => (
            <AgreementCard key={a.id} agreement={a} />
          ))}
        </div>
      )}
    </div>
  );
}

function amountPrompt(current) {
  const raw = window.prompt("Enter amount (PKR):", current ? Math.round(current) : "");
  if (raw == null) return null;
  const n = Number(raw);
  return n > 0 ? n : null;
}

// Buyer's view of one negotiation thread.
function BuyerOfferCard({ offer, onChange }) {
  const [err, setErr] = useState(null);
  const myTurn = offer.status === "pending" && offer.proposed_by === "owner";
  const waiting = offer.status === "pending" && offer.proposed_by === "buyer";
  const atLimit = offer.counters_used >= offer.counter_limit;

  const act = async (fn) => {
    setErr(null);
    try {
      await fn();
      onChange();
    } catch (e) {
      setErr(e.message);
    }
  };

  return (
    <div className="card claim-card">
      <div className="claim-head">
        <strong>{plotLabel(offer.plot)}</strong>
        <span className={`pill offer-${offer.status}`}>{offer.status}</span>
      </div>
      <div className="deal-figures">
        <span>Asking {formatPKR(offer.asking_price)}</span>
        <span className="cur">
          Current {formatPKR(offer.amount)}{" "}
          <em className="muted">({offer.proposed_by}’s move)</em>
        </span>
      </div>
      {offer.message && <p className="muted small">“{offer.message}”</p>}
      <p className="muted small">
        Counters used {offer.counters_used}/{offer.counter_limit}
      </p>

      {err && <p className="error">{err}</p>}

      {myTurn && (
        <div className="btn-row">
          <button className="btn-primary" onClick={() => act(() => api.acceptOffer(offer.id))}>
            Accept {formatPKR(offer.amount)}
          </button>
          <button
            className="btn-link"
            disabled={atLimit}
            title={atLimit ? "Counter limit reached" : ""}
            onClick={() => {
              const a = amountPrompt(offer.amount);
              if (a) act(() => api.counterOffer(offer.id, { amount: a }));
            }}
          >
            Counter
          </button>
          <button className="btn-link danger" onClick={() => act(() => api.rejectOffer(offer.id))}>
            Reject
          </button>
        </div>
      )}
      {waiting && (
        <div className="btn-row">
          <span className="muted small">Waiting for the seller…</span>
          <button className="btn-link danger" onClick={() => act(() => api.withdrawOffer(offer.id))}>
            Withdraw
          </button>
        </div>
      )}
      {offer.status === "accepted" && (
        <p className="muted small">
          Accepted — pending admin approval. It’ll appear under Agreements.
        </p>
      )}
    </div>
  );
}

// Owner's view of a listing plus the offers on it.
function ListingCard({ listing, onChange }) {
  const [offers, setOffers] = useState(null);
  const [err, setErr] = useState(null);

  const loadOffers = () =>
    api.listingOffers(listing.id).then(setOffers).catch((e) => setErr(e.message));
  useEffect(() => {
    loadOffers();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [listing.id]);

  const act = async (fn) => {
    setErr(null);
    try {
      await fn();
      await loadOffers();
      onChange();
    } catch (e) {
      setErr(e.message);
    }
  };

  const pending = (offers || []).filter((o) => o.status === "pending");

  return (
    <div className="card claim-card">
      <div className="claim-head">
        <strong>{plotLabel(listing.plot)}</strong>
        <span className={`pill listing-${listing.status}`}>{listing.status}</span>
      </div>
      <div className="deal-figures">
        <span>Asking {formatPKR(listing.asking_price)}</span>
        {listing.floor_price != null && (
          <span className="muted">Floor {formatPKR(listing.floor_price)}</span>
        )}
      </div>
      {listing.description && <p className="muted small">{listing.description}</p>}

      {err && <p className="error">{err}</p>}

      {listing.status === "active" && (
        <div className="btn-row" style={{ marginBottom: 6 }}>
          <button className="btn-link" onClick={() => act(() => api.resetCounters(listing.id))}>
            Reset counter limits
          </button>
          <button className="btn-link danger" onClick={() => act(() => api.withdrawListing(listing.id))}>
            Withdraw listing
          </button>
        </div>
      )}

      <div className="offers-sub">
        <div className="muted small">
          {pending.length} pending · {offers?.length ?? 0} total offers
        </div>
        {offers?.map((o) => (
          <OwnerOfferRow key={o.id} offer={o} onAct={act} />
        ))}
      </div>
    </div>
  );
}

function OwnerOfferRow({ offer, onAct }) {
  const myTurn = offer.status === "pending" && offer.proposed_by === "buyer";
  const atLimit = offer.counters_used >= offer.counter_limit;
  return (
    <div className="offer-row">
      <div>
        <b>{offer.buyer.full_name || `Buyer #${offer.buyer.id}`}</b> ·{" "}
        {formatPKR(offer.amount)}{" "}
        <span className={`pill offer-${offer.status}`}>{offer.status}</span>
        <div className="muted small">
          {offer.proposed_by}’s move · counters {offer.counters_used}/{offer.counter_limit}
          {offer.message ? ` · “${offer.message}”` : ""}
        </div>
      </div>
      {myTurn && (
        <div className="btn-row">
          <button className="btn-primary sm" onClick={() => onAct(() => api.acceptOffer(offer.id))}>
            Accept
          </button>
          <button
            className="btn-link"
            disabled={atLimit}
            title={atLimit ? "Counter limit reached — reset to continue" : ""}
            onClick={() => {
              const a = amountPrompt(offer.amount);
              if (a) onAct(() => api.counterOffer(offer.id, { amount: a }));
            }}
          >
            Counter
          </button>
          <button className="btn-link danger" onClick={() => onAct(() => api.rejectOffer(offer.id))}>
            Reject
          </button>
        </div>
      )}
    </div>
  );
}

function AgreementCard({ agreement }) {
  const [contact, setContact] = useState(null);
  const [err, setErr] = useState(null);

  const reveal = async () => {
    setErr(null);
    try {
      setContact(await api.revealContact(agreement.id));
    } catch (e) {
      setErr(e.message);
    }
  };

  return (
    <div className="card claim-card">
      <div className="claim-head">
        <strong>{plotLabel(agreement.plot)}</strong>
        <span className={`pill agreement-${agreement.status}`}>{agreement.status}</span>
      </div>
      <div className="deal-figures">
        <span>Agreed {formatPKR(agreement.amount)}</span>
      </div>
      {agreement.review_note && (
        <p className="muted small">
          <b>Admin:</b> {agreement.review_note}
        </p>
      )}

      {agreement.status === "pending" && (
        <p className="muted small">Awaiting admin approval before contacts are shared.</p>
      )}
      {agreement.status === "rejected" && (
        <p className="muted small">The admin did not approve this agreement.</p>
      )}
      {agreement.status === "approved" && !contact && (
        <button className="btn-primary" onClick={reveal}>
          Reveal contact details
        </button>
      )}
      {err && <p className="error">{err}</p>}
      {contact && (
        <div className="contact-cards">
          <ContactCard card={contact.owner} />
          <ContactCard card={contact.buyer} />
        </div>
      )}
    </div>
  );
}

function ContactCard({ card }) {
  return (
    <div className="contact-card">
      <div className="role">{card.role}</div>
      <div className="name">{card.full_name || "—"}</div>
      <a href={`mailto:${card.email}`}>{card.email}</a>
      {card.phone && <div>☎ {card.phone}</div>}
    </div>
  );
}
