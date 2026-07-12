"""OpenCV auto-extraction of plot polygons from a society drawing.

Region-based pipeline that tolerates colored boundary lines and text printed
inside plots:
  1. "Ink" = every pixel that isn't near-white (captures black + colored lines
     *and* text), computed from the color channels.
  2. Dilate slightly to seal 1px gaps in boundaries.
  3. The enclosed plot interiors are the connected non-ink regions. The white
     ring around a plot's printed number stays connected, so its outer contour
     still traces the plot boundary.
  4. Keep regions in a plausible size range that are reasonably rectangular;
     confidence = how well the region fills its bounding box.

NOTE (important, honest): dense CAD parcel maps where every tiny plot is filled
with numbers/dimensions and subdivided by separate short line segments are a
poor fit for raster CV — expect partial, noisy coverage that needs manual
cleanup. For CAD-origin maps the vector source (DXF/DWG/PDF) yields far better
results; see the DXF import path if available.
"""

import cv2
import numpy as np


def detect_plots(
    image_path: str,
    white_thresh: int = 205,
    min_area_frac: float = 1.2e-5,
    max_area_frac: float = 1.2e-3,
    dilate_iter: int = 1,
):
    """Return a list of (pixel_polygon, confidence, pixel_area).

    white_thresh: pixels whose darkest channel is below this count as ink/lines.
    min/max_area_frac: keep regions between these fractions of the whole page.
    dilate_iter: how aggressively to seal small gaps in boundary lines.
    """
    bgr = cv2.imread(image_path, cv2.IMREAD_COLOR)
    if bgr is None:
        return []

    h, w = bgr.shape[:2]
    img_area = float(h * w)
    min_area = img_area * min_area_frac
    max_area = img_area * max_area_frac

    b, g, r = cv2.split(bgr)
    mn = cv2.min(cv2.min(b, g), r)
    ink = (mn < white_thresh).astype(np.uint8) * 255
    kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (3, 3))
    if dilate_iter > 0:
        ink = cv2.dilate(ink, kernel, iterations=dilate_iter)

    regions = cv2.bitwise_not(ink)
    num, labels, stats, _ = cv2.connectedComponentsWithStats(regions, 4)

    results = []
    for i in range(1, num):
        area = float(stats[i, cv2.CC_STAT_AREA])
        if area < min_area or area > max_area:
            continue
        bw = stats[i, cv2.CC_STAT_WIDTH]
        bh = stats[i, cv2.CC_STAT_HEIGHT]
        rectangularity = area / (bw * bh) if bw * bh > 0 else 0.0
        aspect = max(bw, bh) / max(1, min(bw, bh))
        if rectangularity < 0.45 or aspect > 7:
            continue

        mask = (labels == i).astype(np.uint8) * 255
        cnts, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        if not cnts:
            continue
        c = max(cnts, key=cv2.contourArea)
        approx = cv2.approxPolyDP(c, 0.03 * cv2.arcLength(c, True), True)
        if len(approx) < 4 or len(approx) > 8:
            continue

        confidence = round(min(1.0, float(rectangularity)), 2)
        pts = [(float(p[0][0]), float(p[0][1])) for p in approx]
        results.append((pts, confidence, area))

    results.sort(key=lambda r: r[1], reverse=True)
    return results[:2000]
