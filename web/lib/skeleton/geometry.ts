import type { HatSkeletonSpec, PanelCount, SeamEndpointStyle, VisorSpec } from "./types";

/** 3D point [x, y, z]; +Z up, +Y forward. */
export type Vec3 = readonly [number, number, number];

export type SeamCurve =
  | { kind: "bezier"; ctrl: [Vec3, Vec3, Vec3] }
  | { kind: "cubic"; ctrl: [Vec3, Vec3, Vec3, Vec3] }
  | {
      kind: "superellipse";
      rim: Vec3;
      top: Vec3;
      n: number;
      bulgeFraction: number;
    }
  | {
      kind: "split";
      tSplit: number;
      left: [Vec3, Vec3, Vec3];
      right: [Vec3, Vec3, Vec3];
    }
  | {
      kind: "vSplit";
      rim: Vec3;
      top: Vec3;
      vPoint: Vec3;
      /** 0 = base Bézier curve, 1 = piecewise-linear V */
      blend: number;
      baseCurve: [Vec3, Vec3, Vec3];
      /** Chord-length split (linear V); used when leg strengths are 0. */
      tSplit: number;
      legBottomStrength: number;
      legTopStrength: number;
      /** Cached quadratics for bulged legs; arc-length param split. */
      lowerQuad: [Vec3, Vec3, Vec3];
      upperQuad: [Vec3, Vec3, Vec3];
      arcLenTSplit: number;
    };

const Z_UP: Vec3 = [0, 0, 1];

function add(a: Vec3, b: Vec3): [number, number, number] {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}

function scale(v: Vec3, s: number): [number, number, number] {
  return [v[0] * s, v[1] * s, v[2] * s];
}

function sub(a: Vec3, b: Vec3): [number, number, number] {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function len(v: Vec3): number {
  return Math.hypot(v[0], v[1], v[2]);
}

function norm(v: Vec3): [number, number, number] {
  const L = len(v);
  if (L < 1e-15) throw new Error("degenerate vector");
  return [v[0] / L, v[1] / L, v[2] / L];
}

function cross(a: Vec3, b: Vec3): [number, number, number] {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}

function rotationZ(angleRad: number): number[][] {
  const c = Math.cos(angleRad);
  const s = Math.sin(angleRad);
  return [
    [c, -s, 0],
    [s, c, 0],
    [0, 0, 1],
  ];
}

function matVec(m: number[][], v: Vec3): [number, number, number] {
  return [
    m[0][0] * v[0] + m[0][1] * v[1] + m[0][2] * v[2],
    m[1][0] * v[0] + m[1][1] * v[1] + m[1][2] * v[2],
    m[2][0] * v[0] + m[2][1] * v[1] + m[2][2] * v[2],
  ];
}

export function sweatbandPoint(
  theta: number,
  semiAxisX: number,
  semiAxisY: number,
  yawRad: number,
  center: Vec3 = [0, 0, 0]
): [number, number, number] {
  const local: Vec3 = [
    semiAxisX * Math.cos(theta),
    semiAxisY * Math.sin(theta),
    0,
  ];
  const r = rotationZ(yawRad);
  const p = matVec(r, local);
  return add(center, p);
}

/** Unit tangent to sweatband ellipse w.r.t. θ (circumferential direction on the rim). */
export function sweatbandTangentTheta(
  theta: number,
  semiAxisX: number,
  semiAxisY: number,
  yawRad: number
): [number, number, number] {
  const dLocal: Vec3 = [-semiAxisX * Math.sin(theta), semiAxisY * Math.cos(theta), 0];
  const r = rotationZ(yawRad);
  const v = matVec(r, dLocal);
  const L = Math.hypot(v[0], v[1], v[2]);
  if (L < 1e-15) throw new Error("degenerate sweatband tangent");
  return [v[0] / L, v[1] / L, v[2] / L];
}

/** Rear center seam index (6-panel: 4; 5-panel: 3). Matches `seamGroupIndices` rear group. */
export function rearCenterSeamIndex(nSeams: PanelCount): number {
  return nSeams === 6 ? 4 : 3;
}

/**
 * Pairs of seam indices for interior cross seam tape meridians (BL→FR, BR→FL).
 * Uses {@link sampleVToArcGuideMeridian} with α = 0.5 between each pair.
 */
export function crossSeamTapeIndices(nSeams: PanelCount): [[number, number], [number, number]] {
  if (nSeams === 6) {
    // Opposite side seams (not front/back center): forms an X on the interior.
    // Order: smaller index first so meridian math is stable (neither seam is front V).
    return [
      [0, 3],
      [2, 5],
    ];
  }
  return [
    [2, 0],
    [4, 1],
  ];
}

/**
 * Point on the small top ellipse at z = crownHeight (button ring). Same θ as sweatband; semi-axes
 * scaled by `fraction` so seams end horizontally instead of at a single apex point.
 */
export function topRimPoint(
  theta: number,
  semiAxisX: number,
  semiAxisY: number,
  yawRad: number,
  crownHeight: number,
  fraction: number
): [number, number, number] {
  const local: Vec3 = [
    semiAxisX * fraction * Math.cos(theta),
    semiAxisY * fraction * Math.sin(theta),
    crownHeight,
  ];
  const r = rotationZ(yawRad);
  return matVec(r, local);
}

export function sweatbandTangent(
  theta: number,
  semiAxisX: number,
  semiAxisY: number,
  yawRad: number
): [number, number, number] {
  const local: Vec3 = [
    -semiAxisX * Math.sin(theta),
    semiAxisY * Math.cos(theta),
    0,
  ];
  const r = rotationZ(yawRad);
  const t = matVec(r, local);
  return norm(t);
}

export function uniformSeamAngles(nSeams: number): Float64Array {
  if (nSeams < 3) throw new Error("nSeams must be >= 3");
  const out = new Float64Array(nSeams);
  const step = (2 * Math.PI) / nSeams;
  for (let i = 0; i < nSeams; i++) out[i] = i * step;
  return out;
}

/**
 * Sweatband parameter angles (radians) for seam/rim points at +Y forward (θ = π/2), before `yawRad`.
 *
 * - **5-panel:** The front **panel** (flat facet toward the visor) is centered on +Y — a seam is not on center.
 * - **6-panel:** A **seam** sits on +Y so the visor splits down the middle at a ridge.
 */
export function panelSeamAngles(nSeams: PanelCount): Float64Array {
  const twoPi = 2 * Math.PI;
  const offset = 0.5 * Math.PI - twoPi / 6;
  const step = twoPi / 6;
  const out = new Float64Array(nSeams);
  for (let i = 0; i < nSeams; i++) out[i] = offset + i * step;
  return out;
}

/**
 * Sweatband θ bounds of the **front** region used for visor attach (side seams of the front).
 * Indices match `panelSeamAngles` ordering (CCW, front between first seams for 5-panel;
 * for 6-panel, front spans two panels: seam indices 0–2).
 */
export function frontPanelRimThetaBounds(
  nSeams: PanelCount,
  angles: Float64Array
): { lo: number; hi: number } {
  if (nSeams === 5) {
    return { lo: angles[0]!, hi: angles[1]! };
  }
  return { lo: angles[0]!, hi: angles[2]! };
}

/**
 * Half-angle span (rad) for visor attach: min of user `halfSpanRad` and the front-panel
 * seam window, widened by `rimOutsetBeyondSeamRad` (past the side seams) and narrowed by
 * `rimInsetBehindSeamRad`.
 */
export function effectiveVisorHalfSpanRad(
  visor: VisorSpec,
  nSeams: PanelCount,
  angles: Float64Array
): number {
  const { lo, hi } = frontPanelRimThetaBounds(nSeams, angles);
  const frontHalf = 0.5 * (hi - lo);
  const inset = Math.max(0, visor.rimInsetBehindSeamRad);
  const outset = Math.max(0, visor.rimOutsetBeyondSeamRad ?? 0.035);
  const seamBased = frontHalf - inset + outset;
  return Math.max(0.015, Math.min(visor.halfSpanRad, seamBased));
}

export function seamQuadraticBezier(
  rim: Vec3,
  apex: Vec3,
  squareness: number,
  bulgeScale = 1
): [Vec3, Vec3, Vec3] {
  const p0: Vec3 = [rim[0], rim[1], rim[2]];
  const p2: Vec3 = [apex[0], apex[1], apex[2]];
  const chord = sub(p2, p0);
  const chordLen = len(chord);
  if (chordLen < 1e-15) throw new Error("rim and apex coincide");

  const mid: Vec3 = scale(add(p0, p2), 0.5);
  let n = cross(p0, chord);
  let nn = len(n);
  if (nn < 1e-12) {
    n = cross(chord, Z_UP);
    nn = len(n);
  }
  n = norm(n);
  let perp = cross(chord, n);
  const pn = len(perp);
  if (pn < 1e-15) perp = [0, 1, 0];
  else perp = norm(perp);
  if (dot(perp, p0) < 0) perp = scale(perp, -1);

  const offset = scale(perp, squareness * bulgeScale * chordLen);
  const p1 = add(mid, offset);
  return [p0, p1, p2];
}

/**
 * Solve for the V meeting point in the seam plane given two straight-line lengths.
 * Returns the 3D point on the outward side where a segment of length `Lbase` from `rim`
 * meets a segment of length `Ltop` from `top`.
 */
export function solveVPoint(
  rim: Vec3,
  top: Vec3,
  Lbase: number,
  Ltop: number
): [number, number, number] {
  const chord = sub(top, rim);
  const d = len(chord);
  if (d < 1e-15) return scale(add(rim, top), 0.5) as [number, number, number];

  if (Lbase + Ltop < d) {
    return scale(add(rim, top), 0.5) as [number, number, number];
  }

  const uVec = norm(chord);
  let planeN = cross(rim, chord);
  if (len(planeN) < 1e-12) planeN = cross(chord, Z_UP);
  planeN = norm(planeN);
  let perp = cross(chord, planeN);
  if (len(perp) < 1e-15) perp = [0, 1, 0];
  else perp = norm(perp);
  if (dot(perp, rim) < 0) perp = scale(perp, -1);

  const x = (Lbase * Lbase - Ltop * Ltop + d * d) / (2 * d);
  const ySquared = Lbase * Lbase - x * x;
  const y = ySquared > 0 ? Math.sqrt(ySquared) : 0;

  return add(add(rim, scale(uVec, x)), scale(perp, y));
}

/**
 * Sharp V: rim → V-point → top as two straight segments. `t ∈ [0,1]` is uniform by path length.
 * (Smooth “roll” toward this outline comes from vSplit `blend` with `baseCurve`, not from rounding the V.)
 */
function evalVPath(
  rim: Vec3,
  top: Vec3,
  vPoint: Vec3,
  _tSplit: number,
  t: number
): [number, number, number] {
  const leg1 = len(sub(vPoint, rim));
  const leg2 = len(sub(top, vPoint));
  const total = leg1 + leg2;
  if (total < 1e-15) {
    return add(scale(rim, 1 - t), scale(top, t)) as [number, number, number];
  }
  const s = t * total;
  if (s <= leg1) {
    const u = leg1 < 1e-15 ? 0 : s / leg1;
    return add(scale(rim, 1 - u), scale(vPoint, u)) as [number, number, number];
  }
  const u = leg2 < 1e-15 ? 1 : (s - leg1) / leg2;
  return add(scale(vPoint, 1 - u), scale(top, u)) as [number, number, number];
}

export function evalQuadraticBezier(p0: Vec3, p1: Vec3, p2: Vec3, t: number): [number, number, number] {
  const u = 1 - t;
  return [
    u * u * p0[0] + 2 * u * t * p1[0] + t * t * p2[0],
    u * u * p0[1] + 2 * u * t * p1[1] + t * t * p2[1],
    u * u * p0[2] + 2 * u * t * p1[2] + t * t * p2[2],
  ];
}

export function evalCubicBezier(
  p0: Vec3,
  p1: Vec3,
  p2: Vec3,
  p3: Vec3,
  t: number
): [number, number, number] {
  const u = 1 - t;
  const u2 = u * u;
  const u3 = u2 * u;
  const t2 = t * t;
  const t3 = t2 * t;
  return [
    u3 * p0[0] + 3 * u2 * t * p1[0] + 3 * u * t2 * p2[0] + t3 * p3[0],
    u3 * p0[1] + 3 * u2 * t * p1[1] + 3 * u * t2 * p2[1] + t3 * p3[1],
    u3 * p0[2] + 3 * u2 * t * p1[2] + 3 * u * t2 * p2[2] + t3 * p3[2],
  ];
}

/** Seam plane: +u from rim→top chord, +v outward bulge (matches `seamQuadraticBezier`). */
export function seamPlaneFrameFromRimTop(
  rim: Vec3,
  top: Vec3
): { u: [number, number, number]; v: [number, number, number]; planeN: [number, number, number] } {
  const chord = sub(top, rim);
  const chordLen = len(chord);
  if (chordLen < 1e-15) throw new Error("rim and top coincide");
  const u = norm(chord) as [number, number, number];
  let planeN = cross(rim, chord);
  if (len(planeN) < 1e-12) planeN = cross(chord, Z_UP);
  planeN = norm(planeN);
  let v = cross(chord, planeN);
  if (len(v) < 1e-15) v = [0, 1, 0];
  else v = norm(v);
  if (dot(v, rim) < 0) v = scale(v, -1);
  return { u, v, planeN };
}

/** +Z projected into the seam plane (rim,top plane): “straight up” at the rim vs chord slant. */
function verticalUpInSeamPlane(planeN: Vec3): [number, number, number] {
  const proj = projectOntoPlaneUnnormalized(Z_UP, planeN);
  const L = len(proj);
  if (L < 1e-15) return [0, 0, 1];
  return [proj[0] / L, proj[1] / L, proj[2] / L];
}

/**
 * Orthonormal (e1, e2) in the seam plane for bottom-angle mixing: e1 ≈ vertical, e2 ⟂ e1 toward bulge.
 * `mix2d` assumes orthogonal axes; chord u and vertical-up are not always ⟂ to frame v.
 */
function bottomAngleMixBasis(
  planeN: Vec3,
  uChord: [number, number, number],
  vBulge: [number, number, number],
  useVerticalAsE1: boolean
): { e1: [number, number, number]; e2: [number, number, number] } {
  const e1 = useVerticalAsE1 ? verticalUpInSeamPlane(planeN) : uChord;
  const vProj = sub(vBulge as Vec3, scale(e1 as Vec3, dot(vBulge as Vec3, e1)));
  const L = len(vProj);
  if (L >= 1e-12) {
    return { e1, e2: [vProj[0] / L, vProj[1] / L, vProj[2] / L] };
  }
  const e2 = norm(cross(e1 as Vec3, planeN)) as [number, number, number];
  return { e1, e2 };
}

/** Default cubic endpoint style matching legacy bulge scalar `squareness`. */
export function defaultSeamEndpointStyleFromSquareness(squareness: number): SeamEndpointStyle {
  const s = Math.min(1, Math.max(0, squareness));
  return {
    bottomStrength: s,
    bottomAngleRad: (40 * Math.PI) / 180,
    topStrength: s,
    topAngleRad: -Math.PI / 4,
    lockAnglesToSeamPlane: false,
  };
}

function mix2d(
  u: Vec3,
  v: Vec3,
  angleRad: number
): [number, number, number] {
  const ca = Math.cos(angleRad);
  const sa = Math.sin(angleRad);
  return norm([
    ca * u[0] + sa * v[0],
    ca * u[1] + sa * v[1],
    ca * u[2] + sa * v[2],
  ]) as [number, number, number];
}

function projectOntoPlaneUnnormalized(v: Vec3, planeN: Vec3): [number, number, number] {
  const nn = norm(planeN);
  return sub(v as Vec3, scale(nn, dot(v as Vec3, nn)));
}

function projectOntoPlaneDir(
  d: [number, number, number],
  planeN: Vec3
): [number, number, number] {
  const proj = projectOntoPlaneUnnormalized(d as Vec3, planeN);
  const L = len(proj);
  if (L < 1e-15) return [1, 0, 0];
  return [proj[0] / L, proj[1] / L, proj[2] / L];
}

const ARC_LEN_SEGMENTS = 40;

/** Cubic arc length (mesh + λ solve). Same segment count for both so λ matches the curve we render. */
const CUBIC_ARC_LEN_SEGMENTS = 22;

/** ~0.1 in absolute arc-length error is enough for interactive editing (metres). */
const SEAM_ARC_LENGTH_TOL_M = 0.00254;

/** Max bisection steps per seam λ solve (primary cubic + uniform-handle fallback). */
const SEAM_LAMBDA_MAX_ITERS = 5;

/** Unit vector in XY toward the crown point from the z-axis (horizontal “out” on the top ring). */
export function horizontalRadialOutFromAxisAtTop(top: Vec3): [number, number, number] {
  const x = top[0];
  const y = top[1];
  const r = Math.hypot(x, y);
  if (r < 1e-12) return [1, 0, 0];
  return [x / r, y / r, 0];
}

/**
 * Horizontal “out” for the top seam handle: top ring direction in XY, or when the top is on the
 * z-axis (button / apex), the same direction as the rim point in XY. Using a fixed +X fallback for
 * all seams breaks mirror symmetry between left and right seams by a few mm of arc height.
 */
export function horizontalRadialOutForSeamTop(top: Vec3, rim: Vec3): [number, number, number] {
  const x = top[0];
  const y = top[1];
  const r = Math.hypot(x, y);
  if (r >= 1e-12) {
    return [x / r, y / r, 0];
  }
  const rx = rim[0];
  const ry = rim[1];
  const rr = Math.hypot(rx, ry);
  if (rr < 1e-12) return [1, 0, 0];
  return [rx / rr, ry / rr, 0];
}

/**
 * Endpoint tangents must have positive dot with chord +u (rim→top) so the cubic does not fold.
 * Negating the whole handle flips the bulge side (+v); instead flip only the u component:
 * |uu| u + vv v (u ⟂ v in the seam plane) preserves outward vs inward bulge.
 */
function alignHandleWithChordForwardPreservingBulge(
  d: [number, number, number],
  uChord: [number, number, number],
  vBulge: [number, number, number]
): [number, number, number] {
  const uu = dot(d as Vec3, uChord);
  const vv = dot(d as Vec3, vBulge);
  if (uu >= -1e-9) {
    return d;
  }
  const px = Math.abs(uu) * uChord[0] + vv * vBulge[0];
  const py = Math.abs(uu) * uChord[1] + vv * vBulge[1];
  const pz = Math.abs(uu) * uChord[2] + vv * vBulge[2];
  const L = Math.hypot(px, py, pz);
  if (L < 1e-12) {
    return [uChord[0], uChord[1], uChord[2]];
  }
  return [px / L, py / L, pz / L];
}

export function seamHandleDirectionsFromStyle(
  rim: Vec3,
  top: Vec3,
  style: SeamEndpointStyle
): { dBottom: [number, number, number]; dTop: [number, number, number] } {
  const { u, v, planeN } = seamPlaneFrameFromRimTop(rim, top);
  const { e1, e2 } = bottomAngleMixBasis(planeN, u, v, style.lockAnglesToSeamPlane);
  let d0 = mix2d(e1, e2, style.bottomAngleRad);
  let d1: [number, number, number];
  if (style.lockAnglesToSeamPlane) {
    d0 = projectOntoPlaneDir(d0, planeN);
    const hOut = horizontalRadialOutForSeamTop(top, rim);
    const rawTop = projectOntoPlaneUnnormalized(hOut, planeN);
    const rawLen = len(rawTop);
    if (rawLen < 1e-10) {
      d1 = projectOntoPlaneDir(mix2d(u, v, style.topAngleRad), planeN);
    } else {
      d1 = [rawTop[0] / rawLen, rawTop[1] / rawLen, rawTop[2] / rawLen];
    }
  } else {
    d0 = norm(d0) as [number, number, number];
    d1 = norm(mix2d(u, v, style.topAngleRad)) as [number, number, number];
  }
  d0 = alignHandleWithChordForwardPreservingBulge(d0, u, v);
  d1 = alignHandleWithChordForwardPreservingBulge(d1, u, v);
  return { dBottom: d0, dTop: d1 };
}

/** Build cubic with P1 = P0 + λ s0 d0, P2 = P3 − λ s1 d1. */
export function buildSeamCubicWithLambda(
  rim: Vec3,
  top: Vec3,
  style: SeamEndpointStyle,
  lambda: number
): [Vec3, Vec3, Vec3, Vec3] {
  const { dBottom, dTop } = seamHandleDirectionsFromStyle(rim, top, style);
  const p0: Vec3 = [rim[0], rim[1], rim[2]];
  const p3: Vec3 = [top[0], top[1], top[2]];
  const p1 = add(p0, scale(dBottom, lambda * style.bottomStrength));
  const p2 = sub(p3, scale(dTop, lambda * style.topStrength));
  return [p0, p1, p2, p3];
}

export function cubicBezierArcLength(
  p0: Vec3,
  p1: Vec3,
  p2: Vec3,
  p3: Vec3,
  segments = CUBIC_ARC_LEN_SEGMENTS
): number {
  let L = 0;
  let prev = evalCubicBezier(p0, p1, p2, p3, 0);
  for (let i = 1; i <= segments; i++) {
    const t = i / segments;
    const cur = evalCubicBezier(p0, p1, p2, p3, t);
    L += len(sub(cur, prev));
    prev = cur;
  }
  return L;
}

/**
 * Find λ ≥ 0 so cubic arc length ≈ target. Scales both handles equally.
 */
export function solveLambdaForSeamCubicArcLength(
  rim: Vec3,
  top: Vec3,
  style: SeamEndpointStyle,
  targetLength: number
): number {
  const chord = len(sub(top, rim));
  if (chord < 1e-15) return 0;
  const L0 = cubicBezierArcLength(...buildSeamCubicWithLambda(rim, top, style, 0));
  if (targetLength <= L0 + 1e-9) return 0;

  let hi = 1;
  for (let k = 0; k < 6; k++) {
    const L = cubicBezierArcLength(...buildSeamCubicWithLambda(rim, top, style, hi));
    if (L >= targetLength) break;
    hi *= 2;
    if (hi > 1e6) break;
  }

  let lo = 0;
  const hiL = cubicBezierArcLength(...buildSeamCubicWithLambda(rim, top, style, hi));
  if (hiL < targetLength) {
    return hi;
  }

  for (let i = 0; i < SEAM_LAMBDA_MAX_ITERS; i++) {
    const mid = 0.5 * (lo + hi);
    const L = cubicBezierArcLength(...buildSeamCubicWithLambda(rim, top, style, mid));
    if (Math.abs(L - targetLength) <= SEAM_ARC_LENGTH_TOL_M) {
      return mid;
    }
    if (L < targetLength) lo = mid;
    else hi = mid;
  }
  return 0.5 * (lo + hi);
}

export function buildSeamCubicControlPoints(
  rim: Vec3,
  top: Vec3,
  style: SeamEndpointStyle,
  targetArcLength: number
): [Vec3, Vec3, Vec3, Vec3] {
  const lam = solveLambdaForSeamCubicArcLength(rim, top, style, targetArcLength);
  return buildSeamCubicWithLambda(rim, top, style, lam);
}

/** Unit normal for the plane containing rim, vPoint, top (front V). */
export function vSplitPlaneNormal(rim: Vec3, vPoint: Vec3, top: Vec3): [number, number, number] {
  const a = sub(vPoint, rim);
  const b = sub(top, vPoint);
  let n = cross(a, b);
  if (len(n) < 1e-12) n = cross(rim, sub(top, rim));
  if (len(n) < 1e-12) return [0, 0, 1];
  return norm(n);
}

function quadLegInPlane(
  p0: Vec3,
  p2: Vec3,
  strength: number,
  planeN: Vec3
): [Vec3, Vec3, Vec3] {
  const chord = sub(p2, p0);
  const L = len(chord);
  if (L < 1e-15) {
    return [[p0[0], p0[1], p0[2]], [p0[0], p0[1], p0[2]], [p2[0], p2[1], p2[2]]];
  }
  const uDir = scale(chord, 1 / L);
  let perp = cross(planeN, uDir);
  if (len(perp) < 1e-12) perp = cross(uDir, Z_UP);
  perp = norm(perp);
  if (dot(perp, p0) < 0) perp = scale(perp, -1);
  const mid = scale(add(p0, p2), 0.5);
  const p1 = add(mid, scale(perp, strength * L));
  return [p0, p1, p2];
}

export function buildVSplitQuadraticLegs(
  rim: Vec3,
  top: Vec3,
  vPoint: Vec3,
  legBottomStrength: number,
  legTopStrength: number
): { lower: [Vec3, Vec3, Vec3]; upper: [Vec3, Vec3, Vec3]; tSplit: number } {
  const planeN = vSplitPlaneNormal(rim, vPoint, top);
  const lower = quadLegInPlane(rim, vPoint, legBottomStrength, planeN);
  const upper = quadLegInPlane(vPoint, top, legTopStrength, planeN);
  const L1 = quadraticBezierArcLength(lower[0], lower[1], lower[2]);
  const L2 = quadraticBezierArcLength(upper[0], upper[1], upper[2]);
  const total = L1 + L2;
  const tSplit = total > 1e-15 ? L1 / total : 0.5;
  return { lower, upper, tSplit };
}

function evalVQuadraticLegsAt(
  lower: [Vec3, Vec3, Vec3],
  upper: [Vec3, Vec3, Vec3],
  tSplit: number,
  t: number
): [number, number, number] {
  if (t <= tSplit + 1e-15) {
    const u = tSplit < 1e-12 ? 0 : t / tSplit;
    return evalQuadraticBezier(lower[0], lower[1], lower[2], Math.min(1, Math.max(0, u)));
  }
  const u =
    1 - tSplit < 1e-12 ? 1 : (t - tSplit) / (1 - tSplit);
  return evalQuadraticBezier(upper[0], upper[1], upper[2], Math.min(1, Math.max(0, u)));
}

/** Polyline length of a quadratic Bézier (uniform t samples). */
export function quadraticBezierArcLength(
  p0: Vec3,
  p1: Vec3,
  p2: Vec3,
  segments = ARC_LEN_SEGMENTS
): number {
  let L = 0;
  let prev = evalQuadraticBezier(p0, p1, p2, 0);
  for (let i = 1; i <= segments; i++) {
    const t = i / segments;
    const cur = evalQuadraticBezier(p0, p1, p2, t);
    L += len(sub(cur, prev));
    prev = cur;
  }
  return L;
}

/** Arc length of the seam quadratic from `rim` to `top` at the given squareness. */
export function arcLengthOfSeamQuadratic(rim: Vec3, top: Vec3, squareness: number): number {
  const [p0, p1, p2] = seamQuadraticBezier(rim, top, squareness);
  return quadraticBezierArcLength(p0, p1, p2);
}

/**
 * Find squareness such that arc length ≈ chord(rim, top) × multiplier.
 * Multiplier 1 → straight chord (squareness 0). Larger multipliers increase bulge up to 1.
 */
export function solveSquarenessForArcLengthMultiplier(
  rim: Vec3,
  top: Vec3,
  multiplier: number
): number {
  const chord = len(sub(top, rim));
  if (chord < 1e-12) return 0;
  const target = chord * multiplier;
  const len0 = arcLengthOfSeamQuadratic(rim, top, 0);
  if (target <= len0 + 1e-9) return 0;
  const len1 = arcLengthOfSeamQuadratic(rim, top, 1);
  if (target >= len1 - 1e-9) return 1;

  let lo = 0;
  let hi = 1;
  for (let iter = 0; iter < 48; iter++) {
    const mid = 0.5 * (lo + hi);
    const L = arcLengthOfSeamQuadratic(rim, top, mid);
    if (L < target) lo = mid;
    else hi = mid;
  }
  return 0.5 * (lo + hi);
}

/** De Casteljau split of a quadratic at t ∈ (0,1). */
export function subdivideQuadraticBezier(
  p0: Vec3,
  p1: Vec3,
  p2: Vec3,
  t: number
): { left: [Vec3, Vec3, Vec3]; right: [Vec3, Vec3, Vec3] } {
  const b01: [number, number, number] = [
    (1 - t) * p0[0] + t * p1[0],
    (1 - t) * p0[1] + t * p1[1],
    (1 - t) * p0[2] + t * p1[2],
  ];
  const b12: [number, number, number] = [
    (1 - t) * p1[0] + t * p2[0],
    (1 - t) * p1[1] + t * p2[1],
    (1 - t) * p1[2] + t * p2[2],
  ];
  const b012: [number, number, number] = [
    (1 - t) * b01[0] + t * b12[0],
    (1 - t) * b01[1] + t * b12[1],
    (1 - t) * b01[2] + t * b12[2],
  ];
  const left: [Vec3, Vec3, Vec3] = [p0, b01 as Vec3, b012 as Vec3];
  const right: [Vec3, Vec3, Vec3] = [b012 as Vec3, b12 as Vec3, p2];
  return { left, right };
}

/** Two quadratics: lower uses sVisor, upper uses sCrown, joined at tSplit. */
export function buildSplitSeamCurve(
  rim: Vec3,
  apex: Vec3,
  sVisor: number,
  sCrown: number,
  tSplit: number
): SeamCurve {
  const ts = Math.min(0.999, Math.max(0.001, tSplit));
  const [p0, p1, p2] = seamQuadraticBezier(rim, apex, sVisor);
  const { left, right } = subdivideQuadraticBezier(p0, p1, p2, ts);
  const [r0, , r2] = right;
  const rightSeg = seamQuadraticBezier(r0, r2, sCrown);
  return { kind: "split", tSplit: ts, left, right: rightSeg };
}

export function evalSeamCurve(curve: SeamCurve, t: number): [number, number, number] {
  if (curve.kind === "bezier") {
    const [p0, p1, p2] = curve.ctrl;
    return evalQuadraticBezier(p0, p1, p2, t);
  }
  if (curve.kind === "cubic") {
    const [p0, p1, p2, p3] = curve.ctrl;
    return evalCubicBezier(p0, p1, p2, p3, t);
  }
  if (curve.kind === "superellipse") {
    const { rim, top, n, bulgeFraction } = curve;
    return evalSeamSuperellipse(rim, top, n, bulgeFraction, t);
  }
  if (curve.kind === "vSplit") {
    const { rim, top, vPoint, blend, baseCurve, tSplit, legBottomStrength, legTopStrength } = curve;
    const vPos =
      legBottomStrength <= 1e-12 && legTopStrength <= 1e-12
        ? evalVPath(rim, top, vPoint, tSplit, t)
        : evalVQuadraticLegsAt(curve.lowerQuad, curve.upperQuad, curve.arcLenTSplit, t);
    if (blend >= 1 - 1e-9) return vPos;
    const bPos = evalQuadraticBezier(baseCurve[0], baseCurve[1], baseCurve[2], t);
    if (blend <= 1e-9) return bPos;
    return [
      bPos[0] + blend * (vPos[0] - bPos[0]),
      bPos[1] + blend * (vPos[1] - bPos[1]),
      bPos[2] + blend * (vPos[2] - bPos[2]),
    ];
  }
  const { tSplit, left, right } = curve;
  if (t <= tSplit) {
    const u = tSplit < 1e-12 ? 0 : t / tSplit;
    return evalQuadraticBezier(left[0], left[1], left[2], u);
  }
  const u = 1 - tSplit < 1e-12 ? 1 : (t - tSplit) / (1 - tSplit);
  return evalQuadraticBezier(right[0], right[1], right[2], u);
}

export function sampleSeamCurve(
  curve: SeamCurve,
  segments: number
): [number, number, number][] {
  const pts: [number, number, number][] = [];
  for (let i = 0; i <= segments; i++) {
    pts.push(evalSeamCurve(curve, i / segments));
  }
  return pts;
}

/**
 * Seam guide for 3D lines (blue wireframe): for vSplit, always sample the sharp V
 * (two straight legs) so the meeting point stays visible regardless of blend.
 */
export function sampleSeamWireframe(
  curve: SeamCurve,
  segments: number
): [number, number, number][] {
  if (curve.kind === "vSplit") {
    return sampleSeamCurve({ ...curve, blend: 1 }, segments);
  }
  return sampleSeamCurve(curve, segments);
}

/** Same as {@link sampleSeamWireframe} but only samples `t ∈ [0, tMax]` (e.g. stop below the button ring). */
export function sampleSeamWireframeTo(
  curve: SeamCurve,
  segments: number,
  tMax: number
): [number, number, number][] {
  const tEnd = Math.max(0, Math.min(1, tMax));
  const pts: [number, number, number][] = [];
  for (let i = 0; i <= segments; i++) {
    const t = (i / segments) * tEnd;
    if (curve.kind === "vSplit") {
      pts.push(evalSeamCurve({ ...curve, blend: 1 }, t));
    } else {
      pts.push(evalSeamCurve(curve, t));
    }
  }
  return pts;
}

/** V seam curve for meridian / mesh lerp: uses `frontVSplit.blend` (V strength), not wireframe blend 1. */
function seamVForMeridianLerp(sk: BuiltSkeleton, seamVIdx: number): SeamCurve {
  const c = sk.seamControls[seamVIdx]!;
  if (c.kind !== "vSplit") return c;
  const b = sk.spec.frontVSplit?.blend ?? c.blend;
  return { ...c, blend: b };
}

/** Center-front V seam index (6-panel: seam 1 at +Y; 5-panel: seam 0). */
export function frontCenterSeamIndex(nSeams: number): number {
  return nSeams === 6 ? 1 : 0;
}

/** Arc seam index and front V seam index for V-to-arc guides on a flanking panel. */
export function frontGuideArcAndVIndices(
  panelIdx: number,
  frontSeamIdx: number,
  nSeams: number
): [number, number] {
  const leftSeam = panelIdx;
  const rightSeam = (panelIdx + 1) % nSeams;
  if (rightSeam === frontSeamIdx) {
    return [leftSeam, frontSeamIdx];
  }
  return [rightSeam, frontSeamIdx];
}

/** α = j/M when the front seam is the panel's right edge; mirror when it is the left edge. */
export function frontGuideAlpha(
  panelIdx: number,
  j: number,
  M: number,
  frontSeamIdx: number,
  nSeams: number
): number {
  const rightSeam = (panelIdx + 1) % nSeams;
  return rightSeam === frontSeamIdx ? j / M : 1 - j / M;
}

/**
 * Single point on the V-to-arc meridian (same math as {@link sampleVToArcGuideMeridian}).
 * u ∈ [0,1] from rim to top. The V leg uses {@link HatSkeletonSpec.frontVSplit} `blend` (V strength).
 */
export function evalVToArcGuideMeridianAt(
  sk: BuiltSkeleton,
  seamArcIdx: number,
  seamVIdx: number,
  alpha: number,
  u: number
): [number, number, number] {
  const a = Math.max(0, Math.min(1, alpha));
  const t = Math.max(0, Math.min(1, u));
  const spec = sk.spec;
  const seamA = sk.seamControls[seamArcIdx]!;
  const seamV = seamVForMeridianLerp(sk, seamVIdx);

  const thetaA = sk.angles[seamArcIdx]!;
  const thetaV = sk.angles[seamVIdx]!;
  const thetaMix = (1 - a) * thetaA + a * thetaV;

  const rim = sweatbandPoint(thetaMix, spec.semiAxisX, spec.semiAxisY, spec.yawRad);
  const topFrac = spec.topRimFraction ?? 0;
  const top: [number, number, number] =
    topFrac <= 1e-12
      ? [sk.apex[0], sk.apex[1], sk.apex[2]]
      : topRimPoint(
          thetaMix,
          spec.semiAxisX,
          spec.semiAxisY,
          spec.yawRad,
          spec.crownHeight,
          topFrac
        );

  const pA0 = evalSeamCurve(seamA, 0);
  const pV0 = evalSeamCurve(seamV, 0);
  const pA1 = evalSeamCurve(seamA, 1);
  const pV1 = evalSeamCurve(seamV, 1);
  const naive0 = (1 - a) * pA0[0] + a * pV0[0];
  const naive1 = (1 - a) * pA1[0] + a * pV1[0];
  const naive0y = (1 - a) * pA0[1] + a * pV0[1];
  const naive1y = (1 - a) * pA1[1] + a * pV1[1];
  const naive0z = (1 - a) * pA0[2] + a * pV0[2];
  const naive1z = (1 - a) * pA1[2] + a * pV1[2];

  const rimCorr: [number, number, number] = [rim[0] - naive0, rim[1] - naive0y, rim[2] - naive0z];
  const topCorr: [number, number, number] = [top[0] - naive1, top[1] - naive1y, top[2] - naive1z];

  const pA = evalSeamCurve(seamA, t);
  const pV = evalSeamCurve(seamV, t);
  const nx = (1 - a) * pA[0] + a * pV[0];
  const ny = (1 - a) * pA[1] + a * pV[1];
  const nz = (1 - a) * pA[2] + a * pV[2];
  const w1 = 1 - t;
  return [
    nx + w1 * rimCorr[0] + t * topCorr[0],
    ny + w1 * rimCorr[1] + t * topCorr[1],
    nz + w1 * rimCorr[2] + t * topCorr[2],
  ];
}

/**
 * Polyline morphing from smooth arc seam to V seam. α=0 → arc, α=1 → V at current `frontVSplit.blend`.
 * Rim/top constrained to sweatband and button ring via θ(α).
 *
 * Naive blend (1−α)P_A(u)+αP_V(u) hits the chord at u=0/u=1, not R(α)/T(α). Pinning only k=0 and k=N
 * leaves a tangent jump at the rim. Use the same blend plus linear-in-u endpoint correction:
 *   P(u) = (1−α)P_A(u)+αP_V(u) + (1−u)·rimCorr + u·topCorr
 *   rimCorr = R(α) − naive(0),  topCorr = T(α) − naive(1)
 * so P(0)=R(α), P(1)=T(α) and interior samples lie on one smooth family (no band-aid at the base).
 */
export function sampleVToArcGuideMeridian(
  sk: BuiltSkeleton,
  seamArcIdx: number,
  seamVIdx: number,
  alpha: number,
  N: number
): [number, number, number][] {
  const pts: [number, number, number][] = [];
  for (let k = 0; k <= N; k++) {
    pts.push(evalVToArcGuideMeridianAt(sk, seamArcIdx, seamVIdx, alpha, k / N));
  }
  return pts;
}

/** Resolved bulge for seam `i` (overrides > 6-panel groups > global). */
export function effectiveSquarenessForSeam(spec: HatSkeletonSpec, seamIndex: number): number {
  const o = spec.seamSquarenessOverrides[seamIndex];
  if (o !== null && o !== undefined) return Math.min(1, Math.max(0, o));
  if (spec.nSeams === 6 && spec.sixPanelSeams !== null) {
    const m = spec.sixPanelSeams;
    if (seamIndex === 1) return Math.min(1, Math.max(0, m.front));
    if (seamIndex === 0 || seamIndex === 2) return Math.min(1, Math.max(0, m.sideFront));
    return Math.min(1, Math.max(0, m.back));
  }
  return Math.min(1, Math.max(0, spec.seamSquareness));
}

export function resolveSeamEndpointStyleForIndex(
  spec: HatSkeletonSpec,
  seamIndex: number
): SeamEndpointStyle {
  const eps = spec.seamEndpointStyles;
  if (eps.length > seamIndex && eps[seamIndex]) {
    return eps[seamIndex]!;
  }
  return defaultSeamEndpointStyleFromSquareness(effectiveSquarenessForSeam(spec, seamIndex));
}

/** Target arc length (m) for cubic seam: explicit, else legacy quadratic length at current squareness. */
export function resolveSeamTargetArcLengthForIndex(
  spec: HatSkeletonSpec,
  seamIndex: number,
  rim: Vec3,
  top: Vec3
): number {
  const arr = spec.seamTargetArcLengthM;
  if (arr.length > seamIndex && arr[seamIndex] != null && arr[seamIndex]! > 1e-12) {
    return arr[seamIndex]!;
  }
  const s = effectiveSquarenessForSeam(spec, seamIndex);
  return arcLengthOfSeamQuadratic(rim, top, s);
}

export function blendSeamEndpointStyles(
  a: SeamEndpointStyle,
  b: SeamEndpointStyle,
  t: number
): SeamEndpointStyle {
  const w = Math.max(0, Math.min(1, t));
  return {
    bottomStrength: a.bottomStrength * (1 - w) + b.bottomStrength * w,
    bottomAngleRad: a.bottomAngleRad * (1 - w) + b.bottomAngleRad * w,
    topStrength: a.topStrength * (1 - w) + b.topStrength * w,
    topAngleRad: a.topAngleRad * (1 - w) + b.topAngleRad * w,
    lockAnglesToSeamPlane: w < 0.5 ? a.lockAnglesToSeamPlane : b.lockAnglesToSeamPlane,
  };
}

export function seamSquarenessForIndex(
  base: number,
  overrides: (number | null)[],
  i: number
): number {
  if (overrides.length > i && overrides[i] !== null && overrides[i] !== undefined) {
    return Math.min(1, Math.max(0, overrides[i]!));
  }
  return Math.min(1, Math.max(0, base));
}

/** Same as visor `visorOuterPolyline`: `s ∈ [-1,1]` along chord, bulge perpendicular. */
export function superellipseOffset(s: number, a: number, b: number, n: number): [number, number] {
  const sc = Math.max(-1, Math.min(1, s));
  const lx = a * sc;
  const inside = Math.max(0, 1 - Math.abs(sc) ** n);
  const ly = b * inside ** (1 / n);
  return [lx, ly];
}

/**
 * Rim → top seam as a superellipse in the same plane and bulge direction as `seamQuadraticBezier`.
 * `t ∈ [0,1]` from rim to top; `bulgeFraction` scales max outward offset (same 0–1 as squareness).
 */
export function evalSeamSuperellipse(
  rim: Vec3,
  top: Vec3,
  superN: number,
  bulgeFraction: number,
  t: number
): [number, number, number] {
  const p0: Vec3 = [rim[0], rim[1], rim[2]];
  const p2: Vec3 = [top[0], top[1], top[2]];
  const chord = sub(p2, p0);
  const chordLen = len(chord);
  if (chordLen < 1e-15) throw new Error("rim and top coincide");

  const mid = scale(add(p0, p2), 0.5);
  let planeN = cross(p0, chord);
  let nn = len(planeN);
  if (nn < 1e-12) {
    planeN = cross(chord, Z_UP);
    nn = len(planeN);
  }
  planeN = norm(planeN);
  let perp = cross(chord, planeN);
  const pn = len(perp);
  if (pn < 1e-15) perp = [0, 1, 0];
  else perp = norm(perp);
  if (dot(perp, p0) < 0) perp = scale(perp, -1);

  const uVec = norm(chord);
  const s = 2 * t - 1;
  const a = 0.5 * chordLen;
  const b = bulgeFraction * chordLen;
  const [lx, ly] = superellipseOffset(s, a, b, superN);
  return add(add(mid, scale(uVec, lx)), scale(perp, ly));
}

export interface SampleVisorSuperellipseOptions {
  /** Multiply half-chord length `a` (homothety in chord direction). */
  aScale: number;
  /** Multiply projection `b` (homothety in outward direction). */
  bScale: number;
  /** Start of chord parameter `s` (same convention as visor: typically -1). */
  sMin: number;
  /** End of chord parameter `s` (typically 1). */
  sMax: number;
  /** Number of samples along the curve segment. */
  samples: number;
}

/**
 * Sample the visor superellipse in the same chord frame as {@link visorOuterPolyline}.
 * Nested curves (threading, etc.) use `aScale`/`bScale` &lt; 1 and/or a narrower `[sMin, sMax]`.
 */
export function sampleVisorSuperellipsePolyline(
  semiAxisX: number,
  semiAxisY: number,
  yawRad: number,
  spec: VisorSpec,
  options: SampleVisorSuperellipseOptions,
): [number, number, number][] {
  const { aScale, bScale, sMin, sMax, samples: mIn } = options;
  const c = spec.attachAngleRad;
  const left = sweatbandPoint(c - spec.halfSpanRad, semiAxisX, semiAxisY, yawRad);
  const right = sweatbandPoint(c + spec.halfSpanRad, semiAxisX, semiAxisY, yawRad);
  /** Chord midpoint and unit along the sweatband from left → right (matches rim attach, unlike center ± a·t̂ on an ellipse). */
  const rimMid = scale(add(left, right), 0.5);
  const chord = sub(right, left);
  const chordLen = len(chord);
  const uVec: [number, number, number] =
    chordLen < 1e-15 ? [1, 0, 0] : (norm(chord) as [number, number, number]);
  let outward = cross(uVec, Z_UP);
  outward = norm(outward);
  const halfWidth = 0.5 * chordLen;
  let a = Math.max(halfWidth, 1e-6) * aScale;
  let b = spec.projection * bScale;
  a = Math.max(a, 1e-9);
  b = Math.max(b, 0);
  const m = Math.max(2, Math.floor(mIn));
  const nExp = spec.mode === "circular" ? 2 : spec.superellipseN;
  const pts: [number, number, number][] = [];
  for (let i = 0; i < m; i++) {
    const t = m <= 1 ? 0 : i / (m - 1);
    const s = sMin + (sMax - sMin) * t;
    const [lx, ly] = superellipseOffset(s, a, b, nExp);
    const along = scale(uVec, lx);
    const out = scale(outward, ly);
    pts.push(add(add(rimMid, along), out));
  }
  return pts;
}

export function visorOuterPolyline(
  semiAxisX: number,
  semiAxisY: number,
  yawRad: number,
  spec: VisorSpec
): [number, number, number][] {
  const m = Math.max(8, spec.samples);
  return sampleVisorSuperellipsePolyline(semiAxisX, semiAxisY, yawRad, spec, {
    aScale: 1,
    bScale: 1,
    sMin: -1,
    sMax: 1,
    samples: m,
  });
}

export interface BuiltSkeleton {
  spec: HatSkeletonSpec;
  apex: Vec3;
  angles: Float64Array;
  rimPoints: [number, number, number][];
  seamControls: SeamCurve[];
  visorPolyline: [number, number, number][];
}

const SEAM_REUSE_VEC_EPS = 1e-7;
const SEAM_REUSE_LEN_EPS = 1e-6;

function vec3Close(a: Vec3, b: Vec3, eps: number): boolean {
  return (
    Math.abs(a[0] - b[0]) <= eps &&
    Math.abs(a[1] - b[1]) <= eps &&
    Math.abs(a[2] - b[2]) <= eps
  );
}

function seamEndpointStylesEqual(a: SeamEndpointStyle, b: SeamEndpointStyle): boolean {
  const e = SEAM_REUSE_LEN_EPS;
  return (
    Math.abs(a.bottomStrength - b.bottomStrength) <= e &&
    Math.abs(a.bottomAngleRad - b.bottomAngleRad) <= e &&
    Math.abs(a.topStrength - b.topStrength) <= e &&
    Math.abs(a.topAngleRad - b.topAngleRad) <= e &&
    a.lockAnglesToSeamPlane === b.lockAnglesToSeamPlane
  );
}

/** Top endpoint for panel `i`; must match `buildSkeleton` seam top logic. */
function seamTopEndForSpec(spec: HatSkeletonSpec, angles: Float64Array, i: number): Vec3 {
  const topFrac = spec.topRimFraction;
  if (topFrac <= 1e-12) {
    return [0, 0, spec.crownHeight];
  }
  return topRimPoint(
    angles[i]!,
    spec.semiAxisX,
    spec.semiAxisY,
    spec.yawRad,
    spec.crownHeight,
    topFrac
  ) as Vec3;
}

function canReuseCubicSeamFromPrev(
  prev: BuiltSkeleton,
  i: number,
  spec: HatSkeletonSpec,
  angles: Float64Array,
  rim: Vec3,
  topEnd: Vec3,
  useArcLength: boolean,
  useSuperellipse: boolean
): boolean {
  if (useArcLength || useSuperellipse) return false;
  if (spec.seamCurveMode !== "squareness" || prev.spec.seamCurveMode !== "squareness") return false;
  const pc = prev.seamControls[i];
  if (!pc || pc.kind !== "cubic") return false;
  if (!vec3Close(rim, prev.rimPoints[i]!, SEAM_REUSE_VEC_EPS)) return false;
  const prevTop = seamTopEndForSpec(prev.spec, prev.angles, i);
  if (!vec3Close(topEnd, prevTop, SEAM_REUSE_VEC_EPS)) return false;
  const st = resolveSeamEndpointStyleForIndex(spec, i);
  const pst = resolveSeamEndpointStyleForIndex(prev.spec, i);
  if (!seamEndpointStylesEqual(st, pst)) return false;
  const t1 = resolveSeamTargetArcLengthForIndex(spec, i, rim, topEnd);
  const t2 = resolveSeamTargetArcLengthForIndex(prev.spec, i, prev.rimPoints[i]!, prevTop);
  return Math.abs(t1 - t2) <= SEAM_REUSE_LEN_EPS;
}

export function sweatbandPolyline(
  spec: HatSkeletonSpec,
  samples: number
): [number, number, number][] {
  const out: [number, number, number][] = [];
  const step = (2 * Math.PI) / samples;
  for (let i = 0; i < samples; i++) {
    const t = i * step;
    out.push(sweatbandPoint(t, spec.semiAxisX, spec.semiAxisY, spec.yawRad));
  }
  return out;
}

export function sampleSeam(
  controls: [Vec3, Vec3, Vec3],
  segments: number
): [number, number, number][] {
  return sampleSeamCurve({ kind: "bezier", ctrl: controls }, segments);
}

export function buildSkeleton(
  spec: HatSkeletonSpec,
  prevBuilt?: BuiltSkeleton | null
): BuiltSkeleton {
  const prev =
    prevBuilt &&
    prevBuilt.spec.nSeams === spec.nSeams &&
    prevBuilt.spec.seamCurveMode === spec.seamCurveMode
      ? prevBuilt
      : null;

  const apex: Vec3 = [0, 0, spec.crownHeight];
  const angles =
    spec.seamAnglesRad !== null
      ? Float64Array.from(spec.seamAnglesRad)
      : panelSeamAngles(spec.nSeams);

  const rimPoints: [number, number, number][] = [];
  for (let i = 0; i < spec.nSeams; i++) {
    rimPoints.push(
      sweatbandPoint(angles[i]!, spec.semiAxisX, spec.semiAxisY, spec.yawRad)
    );
  }

  const topFrac = spec.topRimFraction;
  const seamTopEnd = (i: number): Vec3 => {
    if (topFrac <= 1e-12) {
      return apex;
    }
    const t = topRimPoint(
      angles[i]!,
      spec.semiAxisX,
      spec.semiAxisY,
      spec.yawRad,
      spec.crownHeight,
      topFrac
    );
    return t as Vec3;
  };

  const useArcLength = spec.seamCurveMode === "arcLength";
  const useSuperellipse = spec.seamCurveMode === "superellipse";
  const frontSeamIdx = spec.nSeams === 6 ? 1 : 0;
  const vs = spec.frontVSplit;
  const seamControls: SeamCurve[] = [];
  for (let i = 0; i < spec.nSeams; i++) {
    const rim = rimPoints[i]!;
    const topEnd = seamTopEnd(i);

    if (vs && i === frontSeamIdx) {
      const totalL = vs.baseLengthM + vs.topLengthM;
      const tSplit = totalL > 1e-12 ? vs.baseLengthM / totalL : 0.5;
      const lb = vs.legBottomStrength ?? 0;
      const lt = vs.legTopStrength ?? 0;
      const { lower, upper, tSplit: arcLenTSplit } = buildVSplitQuadraticLegs(
        rim,
        topEnd,
        vs.vPoint,
        lb,
        lt
      );
      seamControls.push({
        kind: "vSplit",
        rim,
        top: topEnd,
        vPoint: vs.vPoint,
        blend: vs.blend,
        baseCurve: [rim, vs.vPoint, topEnd],
        tSplit,
        legBottomStrength: lb,
        legTopStrength: lt,
        lowerQuad: lower,
        upperQuad: upper,
        arcLenTSplit,
      });
      continue;
    }

    if (useArcLength) {
      const s = solveSquarenessForArcLengthMultiplier(
        rim,
        topEnd,
        spec.seamArcLengthMultiplier
      );
      seamControls.push({ kind: "bezier", ctrl: seamQuadraticBezier(rim, topEnd, s) });
    } else if (useSuperellipse) {
      const bulge = effectiveSquarenessForSeam(spec, i);
      seamControls.push({
        kind: "superellipse",
        rim,
        top: topEnd,
        n: spec.seamSuperellipseN ?? 3,
        bulgeFraction: bulge,
      });
    } else {
      const style = resolveSeamEndpointStyleForIndex(spec, i);
      const targetLen = resolveSeamTargetArcLengthForIndex(spec, i, rim, topEnd);
      if (
        prev &&
        canReuseCubicSeamFromPrev(prev, i, spec, angles, rim, topEnd, useArcLength, useSuperellipse)
      ) {
        seamControls.push(prev.seamControls[i]!);
      } else {
        const ctrl = buildSeamCubicControlPoints(rim, topEnd, style, targetLen);
        seamControls.push({ kind: "cubic", ctrl });
      }
    }
  }

  const visorHalf = effectiveVisorHalfSpanRad(spec.visor, spec.nSeams, angles);
  const visorPolyline = visorOuterPolyline(
    spec.semiAxisX,
    spec.semiAxisY,
    spec.yawRad,
    { ...spec.visor, halfSpanRad: visorHalf }
  );

  return {
    spec,
    apex,
    angles,
    rimPoints,
    seamControls,
    visorPolyline,
  };
}
