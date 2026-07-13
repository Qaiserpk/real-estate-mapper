// Overlay coloring by plot status (spec §3 / §9).
export const STATUS_COLORS = {
  unclaimed: "#94a3b8",
  claim_pending: "#f59e0b",
  owned: "#3b82f6",
  listed: "#22c55e",
  under_offer: "#a855f7",
  sold: "#ef4444",
};

export const STATUS_LABELS = {
  unclaimed: "Unclaimed",
  claim_pending: "Claim pending",
  owned: "Owned",
  listed: "Listed",
  under_offer: "Under offer",
  sold: "Sold",
};

export function colorFor(status) {
  return STATUS_COLORS[status] || "#64748b";
}

// Area conversions for the tooltip (spec §2: sq ft default, kanal/marla on hover).
export function areaBreakdown(sqft, sqftPerMarla = 272.25, marlaPerKanal = 20) {
  if (sqft == null) return null;
  const marla = sqft / sqftPerMarla;
  const kanal = marla / marlaPerKanal;
  return {
    sqft: Math.round(sqft),
    marla: marla.toFixed(2),
    kanal: kanal.toFixed(3),
  };
}

export function formatPKR(amount) {
  if (amount == null) return "—";
  return "Rs " + Math.round(amount).toLocaleString("en-PK");
}

// ---- Society address hierarchy ----
export const DEFAULT_HIERARCHY = [
  { key: "number", label: "Number" },
  { key: "street", label: "Street" },
  { key: "block", label: "Block" },
];

// Turn a level label into a storage key. "number"/"street"/"block" map to the
// plot's first-class columns; anything else is stored in plot.attrs.
export function slugKey(label) {
  return String(label || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_|_$/g, "");
}

// Value of one level for a plot (props from the GeoJSON feature).
export function levelValue(props, key) {
  if (key === "number") return props.plot_no;
  if (key === "street") return props.street;
  if (key === "block") return props.block;
  return props.attrs ? props.attrs[key] : undefined;
}

// Human label for a plot, built from the society hierarchy (broadest → finest).
export function plotLabel(props, hierarchy) {
  const levels = hierarchy && hierarchy.length ? hierarchy : DEFAULT_HIERARCHY;
  const parts = [];
  for (let i = levels.length - 1; i >= 0; i--) {
    const v = levelValue(props, levels[i].key);
    if (v == null || v === "") continue;
    parts.push(`${levels[i].label} ${v}`);
  }
  return parts.join(" · ") || `Plot ${props.plot_no ?? props.id}`;
}

// Prefer stated dimensions (e.g. "60×90 ft"); fall back to area in sq ft.
export function formatSize(p) {
  if (p.width_ft && p.depth_ft) {
    const n = (x) => (Number.isInteger(x) ? x : +x.toFixed(1));
    return `${n(p.width_ft)}×${n(p.depth_ft)} ft`;
  }
  if (p.area_sqft) return `${Math.round(p.area_sqft)} sq ft`;
  return "—";
}
