import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { MapContainer, GeoJSON } from "react-leaflet";
import BaseLayer, { HAS_VECTOR } from "../BaseLayer.jsx";
import { api } from "../api.js";
import { useAuth } from "../auth.jsx";
import AppHeader from "../components/AppHeader.jsx";
import ClaimModal from "../components/ClaimModal.jsx";
import ListingModal from "../components/ListingModal.jsx";
import OfferModal from "../components/OfferModal.jsx";
import {
  colorFor,
  areaBreakdown,
  formatPKR,
  formatSize,
  STATUS_COLORS,
  STATUS_LABELS,
} from "../status.js";

const LANGUAGES = [
  { code: "en", label: "English" },
  { code: "ur", label: "اردو" },
  { code: "native", label: "Native" },
];

const CLAIMABLE = new Set(["unclaimed", "claim_pending"]);

export default function MapView() {
  const { user } = useAuth();
  const [society, setSociety] = useState(null);
  const [plots, setPlots] = useState(null);
  const [selected, setSelected] = useState(null);
  const [error, setError] = useState(null);
  const [language, setLanguage] = useState("en");
  const [baseVariant, setBaseVariant] = useState("streets");
  const [myClaims, setMyClaims] = useState([]);
  const [claiming, setClaiming] = useState(null); // plot being claimed
  const [myPlotIds, setMyPlotIds] = useState(() => new Set());
  const [listing, setListing] = useState(null); // active listing for selected plot
  const [listingFor, setListingFor] = useState(null); // {plot, listing?} modal
  const [offerFor, setOfferFor] = useState(null); // {plot, listing} modal

  const refreshPlots = (sid) =>
    fetch(`/api/societies/${sid}/plots`)
      .then((r) => r.json())
      .then(setPlots);

  useEffect(() => {
    fetch("/api/societies")
      .then((r) => r.json())
      .then((list) => {
        if (!list.length) throw new Error("No societies. Run the seed script.");
        setSociety(list[0]);
        return refreshPlots(list[0].id);
      })
      .catch((e) => setError(e.message));
  }, []);

  const loadMyClaims = () => {
    if (!user) return setMyClaims([]);
    api.myClaims().then(setMyClaims).catch(() => setMyClaims([]));
  };
  useEffect(loadMyClaims, [user]);

  const loadMyPlots = () => {
    if (!user) return setMyPlotIds(new Set());
    api
      .myPlots()
      .then((ps) => setMyPlotIds(new Set(ps.map((p) => p.id))))
      .catch(() => setMyPlotIds(new Set()));
  };
  useEffect(loadMyPlots, [user]);

  // Fetch the active listing for whichever plot is selected.
  const loadListing = (plotId) => {
    if (!plotId) return setListing(null);
    api
      .getPlotListing(plotId)
      .then(setListing)
      .catch(() => setListing(null));
  };
  useEffect(() => {
    loadListing(selected?.id);
  }, [selected?.id]);

  // plot_id -> my most recent claim on it
  const claimByPlot = useMemo(() => {
    const m = new Map();
    for (const c of myClaims) if (!m.has(c.plot.id)) m.set(c.plot.id, c);
    return m;
  }, [myClaims]);

  const center = useMemo(
    () => (society ? [society.center_lat, society.center_lng] : [31.4805, 74.42]),
    [society]
  );

  const style = (feature) => ({
    color: "#1e293b",
    weight: 1,
    fillColor: colorFor(feature.properties.status),
    fillOpacity: 0.55,
  });

  const onEachFeature = (feature, layer) => {
    layer.on({
      click: () => setSelected(feature.properties),
      mouseover: () => layer.setStyle({ fillOpacity: 0.8 }),
      mouseout: () => layer.setStyle({ fillOpacity: 0.55 }),
    });
    const p = feature.properties;
    layer.bindTooltip(`Block ${p.block ?? "—"} · Plot ${p.plot_no ?? "—"}`, {
      sticky: true,
    });
  };

  return (
    <div className="app">
      <AppHeader>
        <span className="map-society">
          {society ? `${society.name} — ${society.region ?? ""}` : "Loading…"}
        </span>
        <select
          className="lang-select"
          value={baseVariant}
          onChange={(e) => setBaseVariant(e.target.value)}
          title="Base map"
        >
          <option value="streets">Streets</option>
          <option value="satellite">Satellite</option>
        </select>
        {HAS_VECTOR && (
          <select
            className="lang-select"
            value={language}
            onChange={(e) => setLanguage(e.target.value)}
            title="Map label language"
          >
            {LANGUAGES.map((l) => (
              <option key={l.code} value={l.code}>
                {l.label}
              </option>
            ))}
          </select>
        )}
      </AppHeader>

      <div className="main">
        <div className="map">
          <MapContainer
            center={center}
            zoom={society?.default_zoom ?? 17}
            style={{ height: "100%" }}
            maxZoom={24}
          >
            <BaseLayer language={language} variant={baseVariant} />
            {plots && (
              <GeoJSON
                key={society?.id}
                data={plots}
                style={style}
                onEachFeature={onEachFeature}
              />
            )}
          </MapContainer>
        </div>

        <SidePanel
          society={society}
          selected={selected}
          error={error}
          user={user}
          myClaim={selected ? claimByPlot.get(selected.id) : null}
          onClaim={() => setClaiming(selected)}
          isMine={selected ? myPlotIds.has(selected.id) : false}
          listing={listing}
          onList={() => setListingFor({ plot: selected, listing })}
          onOffer={() => setOfferFor({ plot: selected, listing })}
        />
      </div>

      {claiming && (
        <ClaimModal
          plot={claiming}
          onClose={() => setClaiming(null)}
          onDone={() => {
            setClaiming(null);
            if (society) refreshPlots(society.id);
            loadMyClaims();
          }}
        />
      )}

      {listingFor && (
        <ListingModal
          plot={listingFor.plot}
          listing={listingFor.listing}
          onClose={() => setListingFor(null)}
          onDone={() => {
            setListingFor(null);
            if (society) refreshPlots(society.id);
            loadListing(selected?.id);
            loadMyPlots();
          }}
        />
      )}

      {offerFor && (
        <OfferModal
          plot={offerFor.plot}
          listing={offerFor.listing}
          onClose={() => setOfferFor(null)}
          onDone={() => setOfferFor(null)}
        />
      )}
    </div>
  );
}

function SidePanel({
  society,
  selected,
  error,
  user,
  myClaim,
  onClaim,
  isMine,
  listing,
  onList,
  onOffer,
}) {
  if (error) {
    return (
      <div className="panel">
        <h2>Something went wrong</h2>
        <p className="muted">{error}</p>
      </div>
    );
  }

  if (!selected) {
    return (
      <div className="panel">
        <h2>Plots</h2>
        <p className="muted">Click a plot on the map to see its details.</p>
        <div className="legend">
          {Object.keys(STATUS_COLORS).map((s) => (
            <div className="item" key={s}>
              <span className="swatch" style={{ background: STATUS_COLORS[s] }} />
              {STATUS_LABELS[s]}
            </div>
          ))}
        </div>
      </div>
    );
  }

  const area = areaBreakdown(
    selected.area_sqft,
    society?.sqft_per_marla,
    society?.marla_per_kanal
  );

  return (
    <div className="panel">
      <h2>
        {[
          selected.block && `Block ${selected.block}`,
          selected.street && `Street ${selected.street}`,
          `Plot ${selected.plot_no ?? "—"}`,
        ]
          .filter(Boolean)
          .join(" · ")}
      </h2>
      <span className="badge" style={{ background: colorFor(selected.status) }}>
        {STATUS_LABELS[selected.status] ?? selected.status}
      </span>

      <div style={{ marginTop: 12 }}>
        <Row k="Type" v={selected.plot_type} />
        <Row k="Size" v={formatSize(selected)} />
        {area && (
          <Row
            k="Area"
            v={
              <span
                title={`${area.marla} marla · ${area.kanal} kanal`}
                className="tooltip-units"
              >
                {area.sqft.toLocaleString()} sq ft ▾
              </span>
            }
          />
        )}
        <Row k="Source" v={selected.source} />
        <Row k="Plot ID" v={selected.id} />
      </div>

      {CLAIMABLE.has(selected.status) ? (
        <ClaimSection
          selected={selected}
          user={user}
          myClaim={myClaim}
          onClaim={onClaim}
        />
      ) : (
        <MarketSection
          selected={selected}
          user={user}
          isMine={isMine}
          listing={listing}
          onList={onList}
          onOffer={onOffer}
        />
      )}
    </div>
  );
}

function MarketSection({ selected, user, isMine, listing, onList, onOffer }) {
  const status = selected.status;
  const active = listing && listing.status === "active";

  if (isMine) {
    if (active) {
      return (
        <div className="claim-box owned">
          <strong>Your plot — listed</strong>
          <div className="price-line">{formatPKR(listing.asking_price)}</div>
          <Link to="/deals" className="btn-primary">
            Manage listing &amp; offers
          </Link>
        </div>
      );
    }
    if (listing && listing.status === "agreed") {
      return (
        <div className="claim-box pending">
          <strong>Your plot — offer accepted</strong>
          <p className="muted small">
            Awaiting admin approval — see <Link to="/deals">My deals</Link>.
          </p>
        </div>
      );
    }
    if (status === "sold")
      return (
        <div className="claim-box owned">
          <strong>Sold ✓</strong>
        </div>
      );
    return (
      <div className="claim-box owned">
        <strong>You own this plot ✓</strong>
        <button className="btn-primary" onClick={onList}>
          List for sale
        </button>
      </div>
    );
  }

  if (active) {
    return (
      <div className="claim-box">
        <div className="price-line">{formatPKR(listing.asking_price)}</div>
        {listing.description && (
          <p className="muted small">{listing.description}</p>
        )}
        {user ? (
          <button className="btn-primary" onClick={onOffer}>
            Make an offer
          </button>
        ) : (
          <Link to="/login" className="btn-primary">
            Sign in to make an offer
          </Link>
        )}
      </div>
    );
  }
  if (status === "sold")
    return (
      <p className="muted" style={{ marginTop: 16 }}>
        This plot has been sold.
      </p>
    );
  return (
    <p className="muted" style={{ marginTop: 16 }}>
      This plot is {STATUS_LABELS[status] ?? status} and isn’t listed for sale.
    </p>
  );
}

function ClaimSection({ selected, user, myClaim, onClaim }) {
  const claimable = CLAIMABLE.has(selected.status);

  if (myClaim && myClaim.status === "pending") {
    return (
      <div className="claim-box pending">
        <strong>Your claim is pending review</strong>
        <p className="muted small">
          An admin will verify your evidence. Track it under{" "}
          <Link to="/claims">My claims</Link>.
        </p>
      </div>
    );
  }
  if (myClaim && myClaim.status === "approved") {
    return (
      <div className="claim-box owned">
        <strong>You own this plot ✓</strong>
      </div>
    );
  }

  if (!claimable) {
    return (
      <p className="muted" style={{ marginTop: 16 }}>
        This plot is {STATUS_LABELS[selected.status] ?? selected.status} and
        isn’t open to claims.
      </p>
    );
  }

  if (!user) {
    return (
      <div className="claim-box">
        <p className="muted small">Own this plot?</p>
        <Link to="/login" className="btn-primary">
          Sign in to claim
        </Link>
      </div>
    );
  }

  return (
    <div className="claim-box">
      <button className="btn-primary" onClick={onClaim}>
        Claim this plot
      </button>
      {selected.status === "claim_pending" && (
        <p className="muted small">
          Another claim is under review; you can still submit yours.
        </p>
      )}
    </div>
  );
}

function Row({ k, v }) {
  return (
    <div className="row">
      <span className="k">{k}</span>
      <span className="v">{v}</span>
    </div>
  );
}
