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
