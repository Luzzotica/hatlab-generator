import type { HatSkeletonSpec, PanelCount, VisorSpec } from "./types";

/** 3D point [x, y, z]; +Z up, +Y forward. */
export type Vec3 = readonly [number, number, number];

export type SeamCurve =
  | { kind: "bezier"; ctrl: [Vec3, Vec3, Vec3] }
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
      tSplit: number;
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
  if (nSeams === 5) {
    // Midpoint of arc between first two seams at π/2 → α₀ = π/2 − π/5 = 3π/10.
    const α0 = 0.5 * Math.PI - twoPi / 10;
    const step = twoPi / 5;
    const out = new Float64Array(5);
    for (let i = 0; i < 5; i++) out[i] = α0 + i * step;
    return out;
  }
  // 6-panel: seam at π/2 → offset π/6.
  const offset = 0.5 * Math.PI - twoPi / 6;
  const step = twoPi / 6;
  const out = new Float64Array(6);
  for (let i = 0; i < 6; i++) out[i] = offset + i * step;
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

const ARC_LEN_SEGMENTS = 48;

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
  if (curve.kind === "superellipse") {
    const { rim, top, n, bulgeFraction } = curve;
    return evalSeamSuperellipse(rim, top, n, bulgeFraction, t);
  }
  if (curve.kind === "vSplit") {
    const { rim, top, vPoint, blend, baseCurve, tSplit } = curve;
    const vPos = evalVPath(rim, top, vPoint, tSplit, t);
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

export function visorOuterPolyline(
  semiAxisX: number,
  semiAxisY: number,
  yawRad: number,
  spec: VisorSpec
): [number, number, number][] {
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
  const a = Math.max(halfWidth, 1e-6);
  const b = spec.projection;
  const m = Math.max(8, spec.samples);
  const pts: [number, number, number][] = [];
  for (let i = 0; i < m; i++) {
    const s = -1 + (2 * i) / (m - 1);
    const nExp = spec.mode === "circular" ? 2 : spec.superellipseN;
    const [lx, ly] = superellipseOffset(s, a, b, nExp);
    const along = scale(uVec, lx);
    const out = scale(outward, ly);
    pts.push(add(add(rimMid, along), out));
  }
  return pts;
}

export interface BuiltSkeleton {
  spec: HatSkeletonSpec;
  apex: Vec3;
  angles: Float64Array;
  rimPoints: [number, number, number][];
  seamControls: SeamCurve[];
  visorPolyline: [number, number, number][];
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

export function buildSkeleton(spec: HatSkeletonSpec): BuiltSkeleton {
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
      seamControls.push({
        kind: "vSplit",
        rim,
        top: topEnd,
        vPoint: vs.vPoint,
        blend: vs.blend,
        baseCurve: [rim, vs.vPoint, topEnd],
        tSplit,
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
      const s = effectiveSquarenessForSeam(spec, i);
      if (
        spec.nSeams === 5 &&
        spec.fivePanelFrontSeams !== null &&
        (i === 0 || i === 1)
      ) {
        const { visor, crown, splitT } = spec.fivePanelFrontSeams;
        seamControls.push(buildSplitSeamCurve(rim, topEnd, visor, crown, splitT));
      } else {
        seamControls.push({ kind: "bezier", ctrl: seamQuadraticBezier(rim, topEnd, s) });
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
