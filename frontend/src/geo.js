// Apply an affine transform (from the backend) to a drawing pixel.
// lng = a*px + b*py + c ; lat = d*px + e*py + f  -> returns [lat, lng] for Leaflet.
export function pixelToLatLng(t, px, py) {
  return [t.d * px + t.e * py + t.f, t.a * px + t.b * py + t.c];
}

// The three corner LatLngs an image-overlay needs, given the map's pixel size.
export function overlayCorners(t, width, height) {
  return {
    topLeft: pixelToLatLng(t, 0, 0),
    topRight: pixelToLatLng(t, width, 0),
    bottomLeft: pixelToLatLng(t, 0, height),
  };
}

// How far (metres) a control point lands from where the transform predicts it.
// This is the reprojection residual — smaller is a better fit.
export function residualMeters(t, p) {
  if (!t || p.px == null || p.lat == null) return null;
  const [predLat, predLng] = pixelToLatLng(t, p.px, p.py);
  const dLat = (predLat - p.lat) * 111320;
  const dLng = (predLng - p.lng) * 111320 * Math.cos((p.lat * Math.PI) / 180);
  return Math.sqrt(dLat * dLat + dLng * dLng);
}

// Root-mean-square reprojection error across all points (overall fit quality).
export function rmsMeters(t, points) {
  const pts = points.filter((p) => p.px != null && p.lat != null);
  if (!t || !pts.length) return null;
  const sum = pts.reduce((a, p) => a + residualMeters(t, p) ** 2, 0);
  return Math.sqrt(sum / pts.length);
}

// Reorder a quad's 4 corners to a consistent [TL, TR, BR, BL] by geographic
// position, so numbering doesn't depend on where the rectangle was drawn from.
// Falls back to the original order for degenerate/steeply-rotated quads.
export function normalizeQuad(corners) {
  if (!corners || corners.length !== 4) return corners;
  const cLng = corners.reduce((a, c) => a + c[0], 0) / 4;
  const cLat = corners.reduce((a, c) => a + c[1], 0) / 4;
  let TL, TR, BR, BL;
  for (const p of corners) {
    const left = p[0] < cLng;
    const top = p[1] > cLat; // higher latitude = visually "up"
    if (top && left) TL = p;
    else if (top && !left) TR = p;
    else if (!top && left) BL = p;
    else BR = p;
  }
  if (!TL || !TR || !BR || !BL) return corners;
  return [TL, TR, BR, BL];
}

// ---- Block subdivision (grid drawing tool) ----
// Corners are [lng, lat] in perimeter order A -> B -> C -> D.
// u runs along A->B (columns), v runs along A->D (rows).
function bilinear(A, B, C, D, u, v) {
  const top = [A[0] + (B[0] - A[0]) * u, A[1] + (B[1] - A[1]) * u];
  const bot = [D[0] + (C[0] - D[0]) * u, D[1] + (C[1] - D[1]) * u];
  return [top[0] + (bot[0] - top[0]) * v, top[1] + (bot[1] - top[1]) * v];
}

// Split a quad into rows x cols cells; returns [{geometry, row, col}], row-major.
export function subdivideQuad(corners, rows, cols) {
  const [A, B, C, D] = corners;
  const cells = [];
  for (let i = 0; i < rows; i++) {
    for (let j = 0; j < cols; j++) {
      const u0 = j / cols, u1 = (j + 1) / cols, v0 = i / rows, v1 = (i + 1) / rows;
      const p00 = bilinear(A, B, C, D, u0, v0);
      const p10 = bilinear(A, B, C, D, u1, v0);
      const p11 = bilinear(A, B, C, D, u1, v1);
      const p01 = bilinear(A, B, C, D, u0, v1);
      cells.push({
        geometry: { type: "Polygon", coordinates: [[p00, p10, p11, p01, p00]] },
        row: i,
        col: j,
      });
    }
  }
  return cells;
}

// The full (rows+1) x (cols+1) vertex grid of a quad, by bilinear interpolation.
export function quadVertexGrid(corners, rows, cols) {
  const [A, B, C, D] = corners;
  const verts = [];
  for (let i = 0; i <= rows; i++) {
    const row = [];
    for (let j = 0; j <= cols; j++) {
      row.push(bilinear(A, B, C, D, j / cols, i / rows));
    }
    verts.push(row);
  }
  return verts;
}

// ---- Curved block edges (arcs) via a bilinearly-blended Coons patch ----
// A block can have any of its 4 edges bulged into a circular arc. edgeThrough is
// [t0,t1,t2,t3] (perimeter edges A-B, B-C, C-D, D-A); each entry is a [lng,lat]
// through-point the arc passes through, or null for a straight edge. With all
// edges straight the Coons patch is identical to plain bilinear interpolation.

function projLocal(corners) {
  const lat0 = corners.reduce((s, c) => s + c[1], 0) / corners.length;
  const lng0 = corners.reduce((s, c) => s + c[0], 0) / corners.length;
  const mLat = 110540;
  const mLng = 111320 * Math.cos((lat0 * Math.PI) / 180);
  return {
    to: ([lng, lat]) => [(lng - lng0) * mLng, (lat - lat0) * mLat],
    from: ([x, y]) => [lng0 + x / mLng, lat0 + y / mLat],
  };
}
function circle3(a, b, c) {
  const d = 2 * (a[0] * (b[1] - c[1]) + b[0] * (c[1] - a[1]) + c[0] * (a[1] - b[1]));
  if (Math.abs(d) < 1e-6) return null;
  const ua = a[0] ** 2 + a[1] ** 2;
  const ub = b[0] ** 2 + b[1] ** 2;
  const uc = c[0] ** 2 + c[1] ** 2;
  const cx = (ua * (b[1] - c[1]) + ub * (c[1] - a[1]) + uc * (a[1] - b[1])) / d;
  const cy = (ua * (c[0] - b[0]) + ub * (a[0] - c[0]) + uc * (b[0] - a[0])) / d;
  return [cx, cy, Math.hypot(a[0] - cx, a[1] - cy)];
}
// Edge evaluator in metres: t in [0,1] from P0 to P1, along the arc through Tm.
function arcEvaluator(P0, P1, Tm) {
  const line = (t) => [P0[0] + (P1[0] - P0[0]) * t, P0[1] + (P1[1] - P0[1]) * t];
  if (!Tm) return line;
  const circ = circle3(P0, P1, Tm);
  if (!circ) return line;
  const [cx, cy, r] = circ;
  const norm = (x) => ((x % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
  const ang = (p) => Math.atan2(p[1] - cy, p[0] - cx);
  const a1 = ang(P0);
  const spanCCW = norm(ang(P1) - a1);
  const ccw = norm(ang(Tm) - a1) <= spanCCW;
  const span = ccw ? spanCCW : spanCCW - 2 * Math.PI;
  return (t) => {
    const a = a1 + span * t;
    return [cx + r * Math.cos(a), cy + r * Math.sin(a)];
  };
}

// (rows+1) x (cols+1) vertex grid honouring curved edges (Coons patch).
export function coonsVertexGrid(corners, edgeThrough, rows, cols) {
  const [A, B, C, D] = corners;
  const proj = projLocal(corners);
  const a = proj.to(A), b = proj.to(B), c = proj.to(C), d = proj.to(D);
  const ET = edgeThrough || [null, null, null, null];
  const tp = (i) => (ET[i] ? proj.to(ET[i]) : null);
  const top = arcEvaluator(a, b, tp(0)); // A->B (v=0)
  const right = arcEvaluator(b, c, tp(1)); // B->C (u=1)
  const bottom = arcEvaluator(d, c, tp(2)); // D->C (v=1)
  const left = arcEvaluator(a, d, tp(3)); // A->D (u=0)
  const verts = [];
  for (let i = 0; i <= rows; i++) {
    const v = i / rows;
    const row = [];
    for (let j = 0; j <= cols; j++) {
      const u = j / cols;
      const T = top(u), Bt = bottom(u), Lf = left(v), Rt = right(v);
      const bx = (1 - u) * (1 - v) * a[0] + u * (1 - v) * b[0] + (1 - u) * v * d[0] + u * v * c[0];
      const by = (1 - u) * (1 - v) * a[1] + u * (1 - v) * b[1] + (1 - u) * v * d[1] + u * v * c[1];
      const x = (1 - v) * T[0] + v * Bt[0] + (1 - u) * Lf[0] + u * Rt[0] - bx;
      const y = (1 - v) * T[1] + v * Bt[1] + (1 - u) * Lf[1] + u * Rt[1] - by;
      row.push(proj.from([x, y]));
    }
    verts.push(row);
  }
  return verts;
}

// Equal-area annular-sector grid: when one block edge is a circular arc, treat
// the block as a sector about that arc's centre. Columns split the angular span
// into equal angles (partition lines radial from the one centre); rows split the
// depth into equal-AREA radius bands (r^2 spaced evenly) so every plot has the
// same area. Returns a (rows+1) x (cols+1) [lng,lat] grid, or null if no edge is
// curved / the arc is degenerate.
export function annularVertexGrid(corners, edgeThrough, rows, cols) {
  const ET = edgeThrough || [null, null, null, null];
  const k = ET.findIndex((t) => t); // first curved edge (perimeter A-B-C-D)
  if (k < 0) return null;
  const proj = projLocal(corners);
  const c = corners.map(proj.to);
  const Pk = c[k], Pk1 = c[(k + 1) % 4], Pk2 = c[(k + 2) % 4], Pk3 = c[(k + 3) % 4];
  const apex = proj.to(ET[k]);
  const circ = circle3(Pk, apex, Pk1);
  if (!circ) return null;
  const [ox, oy, Rout] = circ;
  const norm = (x) => ((x % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
  const ang = (p) => Math.atan2(p[1] - oy, p[0] - ox);
  const th0 = ang(Pk);
  const spanCCW = norm(ang(Pk1) - th0);
  const ccw = norm(ang(apex) - th0) <= spanCCW;
  const span = ccw ? spanCCW : spanCCW - 2 * Math.PI;
  // Inner radius from the two opposite corners (Pk pairs with Pk3, Pk1 with Pk2).
  const dist = (p) => Math.hypot(p[0] - ox, p[1] - oy);
  const Rin = (dist(Pk3) + dist(Pk2)) / 2;
  const R2 = Rout * Rout - Rin * Rin;
  const rAt = (b) => Math.sqrt(Math.max(0, Rout * Rout - b * R2)); // b: 0 outer -> 1 inner
  const vertAt = (a, b) => {
    const th = th0 + span * a;
    const r = rAt(b);
    return proj.from([ox + r * Math.cos(th), oy + r * Math.sin(th)]);
  };
  const grid = [];
  for (let i = 0; i <= rows; i++) {
    const row = [];
    for (let j = 0; j <= cols; j++) {
      let a, b;
      if (k === 0) { a = j / cols; b = i / rows; }
      else if (k === 2) { a = 1 - j / cols; b = 1 - i / rows; }
      else if (k === 1) { a = i / rows; b = 1 - j / cols; }
      else { a = 1 - i / rows; b = j / cols; } // k === 3
      row.push(vertAt(a, b));
    }
    grid.push(row);
  }
  return grid;
}

// Densified boundary ring [lng,lat] of a (possibly curved) block, for display.
export function blockOutline(corners, edgeThrough, perEdge = 20) {
  const [A, B, C, D] = corners;
  const proj = projLocal(corners);
  const ET = edgeThrough || [null, null, null, null];
  const edges = [[A, B, 0], [B, C, 1], [C, D, 2], [D, A, 3]];
  const ring = [];
  for (const [P, Q, k] of edges) {
    const ev = arcEvaluator(proj.to(P), proj.to(Q), ET[k] ? proj.to(ET[k]) : null);
    for (let s = 0; s < perEdge; s++) ring.push(proj.from(ev(s / perEdge)));
  }
  return ring;
}

// Cells (plots) from a vertex grid; each cell is the quad of its 4 grid corners.
// Returns [{ row, col, geometry }].
export function cellsFromGrid(verts) {
  const cells = [];
  for (let i = 0; i < verts.length - 1; i++) {
    for (let j = 0; j < verts[i].length - 1; j++) {
      const p00 = verts[i][j];
      const p10 = verts[i][j + 1];
      const p11 = verts[i + 1][j + 1];
      const p01 = verts[i + 1][j];
      cells.push({
        row: i,
        col: j,
        geometry: { type: "Polygon", coordinates: [[p00, p10, p11, p01, p00]] },
      });
    }
  }
  return cells;
}

function haversineFt(p, q) {
  const R = 6371000;
  const rad = (x) => (x * Math.PI) / 180;
  const dLat = rad(q[1] - p[1]);
  const dLng = rad(q[0] - p[0]);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(p[1])) * Math.cos(rad(q[1])) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a)) * 3.28084;
}

// Measured block size in feet: width along A->B (cols), height along A->D (rows).
export function measureQuadFeet(corners) {
  const [A, B, C, D] = corners;
  return {
    width: (haversineFt(A, B) + haversineFt(D, C)) / 2,
    height: (haversineFt(A, D) + haversineFt(B, C)) / 2,
  };
}
