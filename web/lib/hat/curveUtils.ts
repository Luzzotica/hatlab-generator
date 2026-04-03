import * as THREE from "three";
import type { HatSkeletonSpec } from "@/lib/skeleton/types";

export type Vec3 = [number, number, number];

export function dot3(
  a: readonly [number, number, number],
  b: readonly [number, number, number],
): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

export function norm3(v: Vec3): Vec3 {
  const L = Math.hypot(v[0], v[1], v[2]);
  if (L < 1e-15) return [0, 0, 1];
  return [v[0] / L, v[1] / L, v[2] / L];
}

export function cross3(a: Vec3, b: Vec3): Vec3 {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}

export function lerp3(a: Vec3, b: Vec3, t: number): Vec3 {
  return [
    a[0] + (b[0] - a[0]) * t,
    a[1] + (b[1] - a[1]) * t,
    a[2] + (b[2] - a[2]) * t,
  ];
}

const POLY_DEDUPE_EPS_M = 1e-5;

export function dedupeConsecutivePoints(
  points: Vec3[],
  eps: number = POLY_DEDUPE_EPS_M,
): Vec3[] {
  const out: Vec3[] = [];
  for (const p of points) {
    if (out.length === 0) {
      out.push(p);
      continue;
    }
    const q = out[out.length - 1]!;
    const d = Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
    if (d > eps) out.push(p);
  }
  return out;
}

/**
 * Outward normal of a dome-like ellipsoid (rim ellipse x crown height).
 * Matches crown curvature better than a purely horizontal offset.
 */
export function outwardCrownNormalApprox(
  p: Vec3,
  spec: HatSkeletonSpec,
): Vec3 {
  const [x, y, z] = p;
  const sx = spec.semiAxisX;
  const sy = spec.semiAxisY;
  const H = spec.crownHeight;
  if (H < 1e-10) return [0, 0, 1];
  const gx = x / (sx * sx);
  const gy = y / (sy * sy);
  const gz = z / (H * H);
  return norm3([gx, gy, gz]);
}

/**
 * Sample the stadium arch as an open path: left rail (rim -> top), semicircle across the top,
 * right rail (top -> rim). No bottom chord.
 */
export function sampleOpenArchPath(
  halfW: number,
  straightH: number,
  arcSegments: number,
  archRise: number = halfW,
): [number, number][] {
  const pts: [number, number][] = [];
  const railSteps = Math.max(8, Math.round(arcSegments * 0.35));
  for (let i = 0; i <= railSteps; i++) {
    const t = i / railSteps;
    pts.push([-halfW, t * straightH]);
  }
  const arcSteps = Math.max(12, arcSegments);
  for (let i = 1; i < arcSteps; i++) {
    const theta = Math.PI - (i / arcSteps) * Math.PI;
    pts.push([halfW * Math.cos(theta), straightH + archRise * Math.sin(theta)]);
  }
  for (let i = railSteps; i >= 0; i--) {
    const t = i / railSteps;
    pts.push([halfW, t * straightH]);
  }
  return pts;
}

/** Filled stadium region in closure local (lw, lh). */
export function pointInStadiumLocal(
  lw: number,
  lh: number,
  widthM: number,
  straightM: number,
): boolean {
  const halfW = widthM * 0.5;
  const R = halfW;
  const h = straightM;
  const topH = h + R;
  if (lh < -1e-6 || lh > topH + 1e-5) return false;
  if (lh <= h) {
    return Math.abs(lw) <= halfW + 1e-5;
  }
  const dy = lh - h;
  if (dy > R + 1e-5) return false;
  return lw * lw + dy * dy <= R * R + 1e-7;
}

export function segmentPolylineExcludingStadium(
  points: Vec3[],
  rimAnchor: Vec3,
  tW: Vec3,
  tH: Vec3,
  stadiumW: number,
  stadiumS: number,
): Vec3[][] {
  const segments: Vec3[][] = [];
  let cur: Vec3[] = [];
  for (const p of points) {
    const vx = p[0] - rimAnchor[0];
    const vy = p[1] - rimAnchor[1];
    const vz = p[2] - rimAnchor[2];
    const lw = vx * tW[0] + vy * tW[1] + vz * tW[2];
    const lh = vx * tH[0] + vy * tH[1] + vz * tH[2];
    if (pointInStadiumLocal(lw, lh, stadiumW, stadiumS)) {
      if (cur.length >= 2) segments.push(cur);
      cur = [];
    } else {
      cur.push(p);
    }
  }
  if (cur.length >= 2) segments.push(cur);
  return segments;
}

/**
 * Flat ribbon in the surface tangent plane.
 * normalFn returns the outward surface normal at each point; the width direction is tangent x normal.
 */
export function ribbonGeometryOpen(
  pointsIn: Vec3[],
  halfWidth: number,
  normalFn: (p: Vec3) => Vec3,
): THREE.BufferGeometry {
  const points = dedupeConsecutivePoints(pointsIn);
  const n = points.length;
  if (n < 2) {
    return new THREE.BufferGeometry();
  }

  const tangents: Vec3[] = [];
  for (let i = 0; i < n; i++) {
    const p = points[i]!;
    let t: Vec3;
    if (i === 0) {
      t = norm3([
        points[1]![0] - p[0],
        points[1]![1] - p[1],
        points[1]![2] - p[2],
      ]);
    } else if (i === n - 1) {
      t = norm3([
        p[0] - points[i - 1]![0],
        p[1] - points[i - 1]![1],
        p[2] - points[i - 1]![2],
      ]);
    } else {
      const t0 = norm3([
        p[0] - points[i - 1]![0],
        p[1] - points[i - 1]![1],
        p[2] - points[i - 1]![2],
      ]);
      const t1 = norm3([
        points[i + 1]![0] - p[0],
        points[i + 1]![1] - p[1],
        points[i + 1]![2] - p[2],
      ]);
      t = norm3([t0[0] + t1[0], t0[1] + t1[1], t0[2] + t1[2]]);
    }
    tangents.push(t);
  }

  const widths: Vec3[] = [];
  for (let i = 0; i < n; i++) {
    const ti = tangents[i]!;
    const ni = normalFn(points[i]!);
    let w = cross3(ti, ni);
    let len = Math.hypot(w[0], w[1], w[2]);
    if (len < 1e-10) {
      w = cross3(ti, [0, 0, 1]);
      len = Math.hypot(w[0], w[1], w[2]);
    }
    if (len < 1e-10) {
      w = [1, 0, 0];
    } else {
      w = [w[0] / len, w[1] / len, w[2] / len];
    }
    if (i > 0 && dot3(w, widths[i - 1]!) < 0) {
      w = [-w[0], -w[1], -w[2]];
    }
    widths.push(w);
  }

  const positions: number[] = [];
  const indices: number[] = [];
  const hw = halfWidth;
  for (let i = 0; i < n; i++) {
    const p = points[i]!;
    const w = widths[i]!;
    positions.push(
      p[0] + w[0] * hw,
      p[1] + w[1] * hw,
      p[2] + w[2] * hw,
      p[0] - w[0] * hw,
      p[1] - w[1] * hw,
      p[2] - w[2] * hw,
    );
  }

  for (let i = 0; i < n - 1; i++) {
    const a = i * 2;
    const b = a + 1;
    const c = a + 2;
    const d = a + 3;
    indices.push(a, b, c, b, d, c);
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geo.setIndex(indices);
  geo.computeVertexNormals();
  return geo;
}

/**
 * Two flat ribbons along the same path with width directions orthogonal in the plane ⊥ tangent.
 * When one strip is edge-on to the camera, the other usually has non-zero screen thickness (sweatband).
 */
export function ribbonGeometryOpenDualOrthogonal(
  pointsIn: Vec3[],
  halfWidth: number,
  normalFn: (p: Vec3) => Vec3,
): THREE.BufferGeometry {
  const points = dedupeConsecutivePoints(pointsIn);
  const n = points.length;
  if (n < 2) {
    return new THREE.BufferGeometry();
  }

  const tangents: Vec3[] = [];
  for (let i = 0; i < n; i++) {
    const p = points[i]!;
    let t: Vec3;
    if (i === 0) {
      t = norm3([
        points[1]![0] - p[0],
        points[1]![1] - p[1],
        points[1]![2] - p[2],
      ]);
    } else if (i === n - 1) {
      t = norm3([
        p[0] - points[i - 1]![0],
        p[1] - points[i - 1]![1],
        p[2] - points[i - 1]![2],
      ]);
    } else {
      const t0 = norm3([
        p[0] - points[i - 1]![0],
        p[1] - points[i - 1]![1],
        p[2] - points[i - 1]![2],
      ]);
      const t1 = norm3([
        points[i + 1]![0] - p[0],
        points[i + 1]![1] - p[1],
        points[i + 1]![2] - p[2],
      ]);
      t = norm3([t0[0] + t1[0], t0[1] + t1[1], t0[2] + t1[2]]);
    }
    tangents.push(t);
  }

  const widths1: Vec3[] = [];
  const widths2: Vec3[] = [];
  for (let i = 0; i < n; i++) {
    const ti = tangents[i]!;
    const ni = normalFn(points[i]!);
    let w = cross3(ti, ni);
    let len = Math.hypot(w[0], w[1], w[2]);
    if (len < 1e-10) {
      w = cross3(ti, [0, 0, 1]);
      len = Math.hypot(w[0], w[1], w[2]);
    }
    if (len < 1e-10) {
      w = [1, 0, 0];
    } else {
      w = [w[0] / len, w[1] / len, w[2] / len];
    }
    if (i > 0 && dot3(w, widths1[i - 1]!) < 0) {
      w = [-w[0], -w[1], -w[2]];
    }
    widths1.push(w);

    let wO = cross3(ti, w);
    len = Math.hypot(wO[0], wO[1], wO[2]);
    if (len < 1e-10) {
      wO = cross3(ti, [0, 0, 1]);
      len = Math.hypot(wO[0], wO[1], wO[2]);
    }
    if (len < 1e-10) {
      wO = [1, 0, 0];
    } else {
      wO = [wO[0] / len, wO[1] / len, wO[2] / len];
    }
    if (i > 0 && dot3(wO, widths2[i - 1]!) < 0) {
      wO = [-wO[0], -wO[1], -wO[2]];
    }
    widths2.push(wO);
  }

  const positions: number[] = [];
  const indices: number[] = [];
  const hw = halfWidth;
  for (let i = 0; i < n; i++) {
    const p = points[i]!;
    const w = widths1[i]!;
    positions.push(
      p[0] + w[0] * hw,
      p[1] + w[1] * hw,
      p[2] + w[2] * hw,
      p[0] - w[0] * hw,
      p[1] - w[1] * hw,
      p[2] - w[2] * hw,
    );
  }
  const strip2Base = (positions.length / 3) | 0;
  for (let i = 0; i < n; i++) {
    const p = points[i]!;
    const w = widths2[i]!;
    positions.push(
      p[0] + w[0] * hw,
      p[1] + w[1] * hw,
      p[2] + w[2] * hw,
      p[0] - w[0] * hw,
      p[1] - w[1] * hw,
      p[2] - w[2] * hw,
    );
  }

  for (let i = 0; i < n - 1; i++) {
    const a = i * 2;
    const b = a + 1;
    const c = a + 2;
    const d = a + 3;
    indices.push(a, b, c, b, d, c);
  }
  for (let i = 0; i < n - 1; i++) {
    const a = strip2Base + i * 2;
    const b = a + 1;
    const c = a + 2;
    const d = a + 3;
    indices.push(a, b, c, b, d, c);
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geo.setIndex(indices);
  geo.computeVertexNormals();
  return geo;
}

/**
 * Compute cumulative arc-lengths for a polyline.
 * Returns array of length points.length where result[0] = 0.
 */
export function cumulativeArcLengths(points: Vec3[]): number[] {
  const lengths = [0];
  for (let i = 1; i < points.length; i++) {
    const prev = points[i - 1]!;
    const cur = points[i]!;
    const d = Math.hypot(cur[0] - prev[0], cur[1] - prev[1], cur[2] - prev[2]);
    lengths.push(lengths[i - 1]! + d);
  }
  return lengths;
}

/**
 * Interpolate along a polyline at a given arc-length distance.
 * arcLens is the precomputed cumulative arc-length array.
 */
export function interpolatePolylineAtArcLength(
  points: Vec3[],
  arcLens: number[],
  targetLen: number,
): Vec3 {
  const total = arcLens[arcLens.length - 1]!;
  if (targetLen <= 0) return points[0]!;
  if (targetLen >= total) return points[points.length - 1]!;

  let lo = 0;
  let hi = arcLens.length - 1;
  while (lo < hi - 1) {
    const mid = (lo + hi) >> 1;
    if (arcLens[mid]! <= targetLen) lo = mid;
    else hi = mid;
  }

  const segLen = arcLens[hi]! - arcLens[lo]!;
  if (segLen < 1e-15) return points[lo]!;
  const t = (targetLen - arcLens[lo]!) / segLen;
  return lerp3(points[lo]!, points[hi]!, t);
}

/**
 * Split a polyline into dash sub-polylines by arc-length.
 * `startOffset` shifts the dash pattern origin along the curve (for staggering between rows).
 * Returns an array of polylines (one per dash).
 */
export function splitPolylineIntoDashes(
  points: Vec3[],
  dashLen: number,
  gapLen: number,
  samplesPerDash: number = 4,
  startOffset: number = 0,
): Vec3[][] {
  if (points.length < 2) return [];
  const arcLens = cumulativeArcLengths(points);
  const totalLen = arcLens[arcLens.length - 1]!;
  if (totalLen < 1e-8) return [];

  const dashes: Vec3[][] = [];
  const period = dashLen + gapLen;

  let k = Math.ceil(-(startOffset + dashLen) / period);

  while (true) {
    const rawStart = startOffset + k * period;
    const rawEnd = rawStart + dashLen;
    k++;

    if (rawStart >= totalLen) break;

    const clampedStart = Math.max(rawStart, 0);
    const clampedEnd = Math.min(rawEnd, totalLen);
    if (clampedEnd - clampedStart < dashLen * 0.3) continue;

    const pts: Vec3[] = [];
    const nSamples = Math.max(2, samplesPerDash);
    for (let i = 0; i <= nSamples; i++) {
      const t = clampedStart + (i / nSamples) * (clampedEnd - clampedStart);
      pts.push(interpolatePolylineAtArcLength(points, arcLens, t));
    }
    dashes.push(pts);
  }
  return dashes;
}

/**
 * Build a merged dashed ribbon geometry from a polyline.
 * Each dash is a short ribbon; all are merged into one BufferGeometry.
 * `startOffset` shifts the dash pattern along the curve for staggering.
 */
export function dashedRibbonGeometry(
  polyline: Vec3[],
  halfWidth: number,
  normalFn: (p: Vec3) => Vec3,
  dashLen: number,
  gapLen: number,
  startOffset: number = 0,
): THREE.BufferGeometry {
  const dashes = splitPolylineIntoDashes(polyline, dashLen, gapLen, 4, startOffset);
  if (dashes.length === 0) return new THREE.BufferGeometry();

  const allPositions: number[] = [];
  const allIndices: number[] = [];
  let vertexOffset = 0;

  for (const dash of dashes) {
    const geo = ribbonGeometryOpen(dash, halfWidth, normalFn);
    const posAttr = geo.getAttribute("position") as THREE.BufferAttribute | null;
    const idxAttr = geo.getIndex();
    if (!posAttr || posAttr.count === 0) {
      geo.dispose();
      continue;
    }
    const posArr = posAttr.array as Float32Array;
    for (let i = 0; i < posArr.length; i++) {
      allPositions.push(posArr[i]!);
    }
    if (idxAttr) {
      const idxArr = idxAttr.array;
      for (let i = 0; i < idxArr.length; i++) {
        allIndices.push(idxArr[i]! + vertexOffset);
      }
    }
    vertexOffset += posAttr.count;
    geo.dispose();
  }

  if (allPositions.length === 0) return new THREE.BufferGeometry();

  const merged = new THREE.BufferGeometry();
  merged.setAttribute(
    "position",
    new THREE.Float32BufferAttribute(allPositions, 3),
  );
  if (allIndices.length > 0) {
    merged.setIndex(allIndices);
  }
  merged.computeVertexNormals();
  return merged;
}

/**
 * Like {@link dashedRibbonGeometry}, but each dash uses {@link ribbonGeometryOpenDualOrthogonal}.
 */
export function dashedRibbonGeometryDualOrthogonal(
  polyline: Vec3[],
  halfWidth: number,
  normalFn: (p: Vec3) => Vec3,
  dashLen: number,
  gapLen: number,
  startOffset: number = 0,
): THREE.BufferGeometry {
  const dashes = splitPolylineIntoDashes(polyline, dashLen, gapLen, 4, startOffset);
  if (dashes.length === 0) return new THREE.BufferGeometry();

  const allPositions: number[] = [];
  const allIndices: number[] = [];
  let vertexOffset = 0;

  for (const dash of dashes) {
    const geo = ribbonGeometryOpenDualOrthogonal(dash, halfWidth, normalFn);
    const posAttr = geo.getAttribute("position") as THREE.BufferAttribute | null;
    const idxAttr = geo.getIndex();
    if (!posAttr || posAttr.count === 0) {
      geo.dispose();
      continue;
    }
    const posArr = posAttr.array as Float32Array;
    for (let i = 0; i < posArr.length; i++) {
      allPositions.push(posArr[i]!);
    }
    if (idxAttr) {
      const idxArr = idxAttr.array;
      for (let i = 0; i < idxArr.length; i++) {
        allIndices.push(idxArr[i]! + vertexOffset);
      }
    }
    vertexOffset += posAttr.count;
    geo.dispose();
  }

  if (allPositions.length === 0) return new THREE.BufferGeometry();

  const merged = new THREE.BufferGeometry();
  merged.setAttribute(
    "position",
    new THREE.Float32BufferAttribute(allPositions, 3),
  );
  if (allIndices.length > 0) {
    merged.setIndex(allIndices);
  }
  merged.computeVertexNormals();
  return merged;
}
