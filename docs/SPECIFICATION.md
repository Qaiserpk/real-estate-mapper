# Property Map Platform — Specification (Planning)

> Status: **Planning complete. Not yet in development.**
> This document consolidates all decisions. It is the reference to develop against.

---

## 1. Product summary

A web platform where a scanned/hand-drawn society map is turned into real,
georeferenced property polygons over an OpenStreetMap base map. Each polygon is a
property record. Users claim ownership (admin-validated), and buyers/dealers make
price-limited offers. When both sides agree and an admin approves, contact
information is revealed. One society is active at a time; the model is multi-tenant.

---

## 2. Locked decisions

| Area | Decision |
|---|---|
| Base map | OpenStreetMap (Leaflet + react-leaflet) |
| Backend | Python + FastAPI |
| Extraction | Hybrid — OpenCV auto-detect for clean plots, manual trace/edit for difficult ones + correction |
| Tenancy | One society active at a time; multi-tenant schema (`society_id` on core records) |
| Validation | Admin eyeball; no land-registry integration |
| Identity | Global account, society-scoped roles |
| Area units | Store canonical **sq ft**; show kanal/marla on tooltip; conversion factors configurable per society |
| Currency | PKR (Rs), single currency |
| Counter-offers | Limited rounds per thread; owner can reset a locked thread |
| Evidence | Image uploads of any official document; private to admin + claimant |

Regional area factors (defaults, per-society overridable):
1 marla = 272.25 sq ft, 1 kanal = 20 marla = 5,445 sq ft.

---

## 3. Tech stack

| Concern | Choice |
|---|---|
| Base map | Leaflet + react-leaflet + OSM tiles |
| Polygon draw/edit | Leaflet-Geoman (or Leaflet.draw) |
| Frontend | React |
| Backend | Python + FastAPI |
| Image pipeline | OpenCV + NumPy |
| Database | PostgreSQL + PostGIS |
| Auth | JWT, role-based, society-scoped |
| File storage | S3-compatible or local (source maps, evidence images) |

---

## 4. Roles (society-scoped)

- **Guest** — browse map + public plot data. No contact info.
- **Registered user** — can claim, make offers, list.
- **Owner** — verified; sets price limits, manages offers on their plots.
- **Buyer / Dealer** — makes offers (dealer may act across many plots).
- **Admin** — uploads maps, georeferences, runs extraction, validates claims,
  approves agreements, moderates. Scoped to a society.
- **Super-admin** (platform) — creates societies, assigns society admins.

---

## 5. Hybrid extraction pipeline

```
Upload image → Georeference (3–4 control points → transform)
   → Auto-detect (OpenCV, scored)
        ├─ high confidence → draft polygon ──┐
        └─ low confidence  → manual trace  ──┤→ admin review/edit → CONFIRM → Properties
```

- **Georeference:** admin matches points on the drawing to real OSM locations →
  affine/homography transform → every pixel maps to lat/lng.
- **Auto-detect:** OpenCV edge/contour/line detection emits candidate polygons with
  a confidence score. High-confidence, clean-grid plots auto-accepted as drafts.
- **Manual:** low-confidence / irregular / overlapping regions traced by hand; any
  auto polygon is editable (drag vertices, split, merge, delete).
- **Safety rule:** nothing becomes a real Property until the map is **confirmed**.
  Auto output is a suggestion layer, never trusted blind.

---

## 6. Core workflows

**Ownership claim**
`unclaimed → claim_pending → owned | rejected`
Select plot → upload evidence images (any official doc) → admin eyeballs → decision.
Only owners set limits / list. All transitions logged.

**Offers**
Owner presets limits per plot (min price, offers open y/n, step rules, counter limit).
Buyer/dealer submits offer within limits (out-of-bounds auto-rejected) → owner
accepts / counters / declines. Counter-offers capped per thread; when cap hit,
thread locks. Owner can reset a locked thread to reopen negotiation. Full history kept.

**Agreement → reveal**
Owner accepts → `agreement_reached` → **admin approves** → contact info of both
parties revealed to each other. Before approval, everyone is handle-only.

---

## 7. Data model

- **Society** — name, region, center coords, default zoom, source map(s), status,
  `area_units_config`, `default_counter_limit`. *(tenant root)*
- **User** — global login, profile, hidden contact info.
- **SocietyMembership** — user ↔ society ↔ role(s).
- **MapSource** — society, image, control points/transform, status (draft/confirmed).
- **Property/Plot** — society, PostGIS polygon, classification, block/plot no.,
  `area_sqft`, price limits, `counter_offer_limit`, status, current owner,
  source (auto/manual), confidence.
- **OwnershipClaim** — user, plot, `evidence_images[]` (private), status,
  admin decision, timestamps.
- **Offer** — buyer, plot, amount, status, `counter_count`, `is_locked`, history.
- **Agreement** — offer, parties, admin approval, reveal flag.
- **AuditLog** — actor, action, entity, timestamp.

Plot status vocabulary: `unclaimed / claim_pending / owned / listed / under_offer / sold`.
Classification type: `residential / commercial / agricultural / amenity / other`.

---

## 8. Admin UI — screen-by-screen flow

Admin is a **multi-screen workspace** (setup is sequential and detailed).

**A0 — Society switcher / dashboard**
- Pick active society (or create one, super-admin). Shows the active-society context.
- KPI tiles: plots, pending claims, active offers, agreements awaiting approval.
- Links into each queue below.

**A1 — Map upload**
- Upload source image (PNG/JPEG). Set society metadata (name, region, center, zoom).
- Lists existing MapSources with status (draft / confirmed).

**A2 — Georeference**
- Split view: drawing on the left, OSM map on the right.
- Drop 3–4 matching control points (drawing pixel ↔ real location).
- System computes transform; preview overlays the drawing on OSM to check alignment.
- Save transform → unlocks extraction.

**A3 — Extraction & review**
- Aligned image over OSM with the auto-detected polygon suggestion layer + scores.
- Tools: accept auto polygon, edit vertices, split, merge, delete, **manual trace**
  for difficult plots. Filter by confidence to focus on low-confidence areas.
- Assign classification + block/plot no.; area auto-computed and displayed.

**A4 — Confirm map**
- Review summary (counts by type/status). **Confirm** promotes drafts to Properties.
- After confirm, plots go live on the user map.

**A5 — Claim validation queue**
- List of `claim_pending` claims. Open one → see plot + evidence images + claimant.
- Approve (→ owner) or reject (with reason). Logged to audit trail.

**A6 — Agreement approval queue**
- List of `agreement_reached` deals. Review offer, parties, plot.
- Approve → triggers contact reveal. Reject → back to owner.

**A7 — Audit log / moderation**
- Searchable log of all state changes (who/what/when). User moderation actions.

Admin navigation: `A0 dashboard → A1 → A2 → A3 → A4` (map setup path),
plus queues `A5` and `A6` reachable any time from A0.

---

## 9. User UI — single screen (map-centric)

One screen. **Map is the main surface**; everything else is a **side panel**
(data or form) that slides in over/beside the map.

**Base layout**
- Full-screen OSM map with the confirmed property overlay (colored by type/status).
- Top bar: active society name, search/filter, account menu.
- Collapsible **side panel** on the right for data and forms.

**Side-panel states (context-driven):**
- **Idle:** filter/legend + list of plots; click a plot on map or list to select.
- **Plot details:** selected plot info — classification, area (sq ft; kanal/marla on
  tooltip), status, owner handle, price limits. Action buttons per role.
- **Claim form:** upload evidence images, submit claim. Shows claim status after.
- **Make offer form:** enter amount (validated against limits, PKR), submit.
- **Offer thread:** offer/counter history, counter within cap, accept/decline;
  shows "locked" when cap hit; owner sees "reset" control.
- **My activity:** my claims, my offers, my plots — quick tabs in the panel.
- **Reveal card:** after admin approval, shows the other party's contact info.

Interaction rule: selecting a plot on the map drives the panel; submitting a form
updates the plot's status and reflects on the overlay. Guests see details but
role-gated actions are disabled with a sign-in prompt.

---

## 10. Build phases

1. Foundation — repo, PostgreSQL+PostGIS, auth, society/tenant model, OSM base map.
2. Map ingestion — upload, control-point georeferencing, save MapSource.
3. Hybrid extraction — OpenCV auto-detect (scored) + manual trace/edit + confirm.
4. Overlay & classification — colored overlay, click-plot-for-details.
5. Ownership — claim + evidence upload + admin validation + audit log.
6. Offers — owner limits, buyer offers, accept/counter/decline, counter cap + reset.
7. Agreement & reveal — admin approval, gated contact reveal.
8. Polish — search/filter, notifications, dashboards, second-society onboarding.

---

## 11. Open/derived items to confirm at development kickoff

- File-type/size limits for evidence and source-map uploads.
- Notification channel (in-app / email) for claim/offer/agreement status changes.
- Exact default counter-offer limit value.
- Whether dealers need any distinct capabilities beyond buyer (multi-plot dashboards).
