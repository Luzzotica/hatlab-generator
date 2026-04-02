import * as THREE from "three";
import type { HatSkeletonSpec } from "@/lib/skeleton/types";
import type { BuiltSkeleton } from "@/lib/skeleton/geometry";
import {
  evalCubicBezier,
  evalQuadraticBezier,
  evalSeamCurve,
  evalSeamSuperellipse,
  evalVToArcGuideMeridianAt,
  frontCenterSeamIndex,
  frontGuideAlpha,
  frontGuideArcAndVIndices,
  seamQuadraticBezier,
  effectiveSquarenessForSeam,
  solveSquarenessForArcLengthMultiplier,
  sweatbandPoint,
  topRimPoint,
} from "@/lib/skeleton/geometry";

/** Vertical rings from rim (u=0) to apex (u=1), following seam curves on panel edges. */
export const CROWN_VERTICAL_RINGS = 24;

/** Finer vertical rings when front V-split is on (smaller quads along the sharp fold). */
export const CROWN_VERTICAL_RINGS_VSPLIT = 48;

/** Default crown fabric thickness (m); inner surface is offset along outward normals. */
export const CROWN_SHELL_THICKNESS_M = 0.001;

/** Segments along the sweatband arc between two seams (bottom follows ellipse, not a chord). */
export const ARC_SEGMENTS_DEFAULT = 10;
/**
 * When front V-split is active: more columns between center front and side seams so the mesh
 * follows the lerp meridians and the hard V without large stretched quads.
 */
export const ARC_SEGMENTS_VSPLIT = 28;

export function crownArcSegments(spec: HatSkeletonSpec): number {
  return spec.frontVSplit != null ? ARC_SEGMENTS_VSPLIT : ARC_SEGMENTS_DEFAULT;
}

export function crownVerticalRings(spec: HatSkeletonSpec): number {
  return spec.frontVSplit != null ? CROWN_VERTICAL_RINGS_VSPLIT : CROWN_VERTICAL_RINGS;
}

function pushTriangle(
  positions: number[],
  a: [number, number, number],
  b: [number, number, number],
  c: [number, number, number]
): void {
  positions.push(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2]);
}

function sub3(
  a: readonly [number, number, number],
  b: readonly [number, number, number]
): [number, number, number] {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

function cross3(
  a: readonly [number, number, number],
  b: readonly [number, number, number]
): [number, number, number] {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}

/** Outward-pointing normal on the crown grid (matches quad winding v00→v10→v01). */
function crownOuterNormalAt(
  sk: BuiltSkeleton,
  panel: number,
  j: number,
  k: number,
  M: number,
  N: number
): [number, number, number] {
  const pjL = panelVertex(sk, panel, j > 0 ? j - 1 : j, k, M, N);
  const pjR = panelVertex(sk, panel, j < M ? j + 1 : j, k, M, N);
  const pkL = panelVertex(sk, panel, j, k > 0 ? k - 1 : k, M, N);
  const pkR = panelVertex(sk, panel, j, k < N ? k + 1 : k, M, N);
  const du = sub3(pjR, pjL);
  const dv = sub3(pkR, pkL);
  let n = cross3(du, dv);
  let len = Math.hypot(n[0], n[1], n[2]);
  if (len < 1e-12) {
    const p = panelVertex(sk, panel, j, k, M, N);
    const r = Math.hypot(p[0], p[1]);
    if (r < 1e-12) return [0, 0, 1];
    n = [p[0] / r, p[1] / r, 0];
    len = 1;
  } else {
    n = [n[0] / len, n[1] / len, n[2] / len];
  }
  return n;
}

function offsetCrownVertexInward(
  sk: BuiltSkeleton,
  panel: number,
  j: number,
  k: number,
  M: number,
  N: number,
  thickness: number
): [number, number, number] {
  const p = panelVertex(sk, panel, j, k, M, N);
  const n = crownOuterNormalAt(sk, panel, j, k, M, N);
  return [
    p[0] - thickness * n[0],
    p[1] - thickness * n[1],
    p[2] - thickness * n[2],
  ];
}

/** CCW arc length from angles[i] to angles[i+1] (wraps across 2π on last panel). */
export function panelArcSpan(angles: Float64Array, i: number): number {
  const n = angles.length;
  const a0 = angles[i]!;
  const a1 = angles[(i + 1) % n]!;
  let d = a1 - a0;
  if (d < 0) d += 2 * Math.PI;
  return d;
}

/** θ for interior sample j ∈ (0, M) on the ellipse between the two panel seams. */
function panelInteriorTheta(angles: Float64Array, panel: number, j: number, M: number): number {
  const a0 = angles[panel]!;
  return a0 + (j / M) * panelArcSpan(angles, panel);
}

/** Top endpoint for a meridian at θ: small button ring (flat top) or single point if fraction is 0. */
function topEndForTheta(sk: BuiltSkeleton, theta: number): [number, number, number] {
  const f = sk.spec.topRimFraction ?? 0;
  if (f <= 1e-12) {
    const a = sk.apex;
    return [a[0], a[1], a[2]];
  }
  return topRimPoint(
    theta,
    sk.spec.semiAxisX,
    sk.spec.semiAxisY,
    sk.spec.yawRad,
    sk.spec.crownHeight,
    f
  );
}

/**
 * Crown vertex at grid position (panel, jArc, kRing). Edges (j=0, j=M) evaluate the seam curves
 * directly. Interior vertices in squareness/cubic mode use the ruled surface between the two seam
 * curves with an additive ellipse correction so the rim follows the sweatband.
 */
export function panelVertex(
  sk: BuiltSkeleton,
  panel: number,
  jArc: number,
  kRing: number,
  M: number,
  N: number
): [number, number, number] {
  const n = sk.spec.nSeams;
  const u = kRing / N;
  const spec = sk.spec;
  const seamL = sk.seamControls[panel]!;
  const seamR = sk.seamControls[(panel + 1) % n]!;

  if (jArc === 0) {
    return evalSeamCurve(seamL, u);
  }
  if (jArc === M) {
    return evalSeamCurve(seamR, u);
  }

  if (seamL.kind === "vSplit" || seamR.kind === "vSplit") {
    const frontSeamIdx = frontCenterSeamIndex(n);
    const [seamArcIdx, seamVIdx] = frontGuideArcAndVIndices(panel, frontSeamIdx, n);
    const alpha = frontGuideAlpha(panel, jArc, M, frontSeamIdx, n);
    return evalVToArcGuideMeridianAt(sk, seamArcIdx, seamVIdx, alpha, u);
  }

  const theta = panelInteriorTheta(sk.angles, panel, jArc, M);
  const rim = sweatbandPoint(theta, spec.semiAxisX, spec.semiAxisY, spec.yawRad);
  const blend = jArc / M;

  const topEnd = topEndForTheta(sk, theta);

  if (spec.seamCurveMode === "arcLength") {
    const s = solveSquarenessForArcLengthMultiplier(
      rim,
      topEnd,
      spec.seamArcLengthMultiplier
    );
    const [p0, p1, p2] = seamQuadraticBezier(rim, topEnd, s);
    return evalQuadraticBezier(p0, p1, p2, u);
  }

  if (spec.seamCurveMode === "superellipse") {
    if (spec.nSeams === 5 && spec.fivePanelFrontSeams !== null && panel === 0) {
      const { visor, crown } = spec.fivePanelFrontSeams;
      const bulge = (1 - u) * visor + u * crown;
      return evalSeamSuperellipse(rim, topEnd, spec.seamSuperellipseN ?? 3, bulge, u);
    }
    const sL = effectiveSquarenessForSeam(spec, panel);
    const sR = effectiveSquarenessForSeam(spec, (panel + 1) % n);
    const bulge = sL * (1 - blend) + sR * blend;
    return evalSeamSuperellipse(rim, topEnd, spec.seamSuperellipseN ?? 3, bulge, u);
  }

  if (spec.nSeams === 5 && spec.fivePanelFrontSeams !== null && panel === 0) {
    const { visor, crown } = spec.fivePanelFrontSeams;
    const squareness = (1 - u) * visor + u * crown;
    const [p0, p1, p2] = seamQuadraticBezier(rim, topEnd, squareness);
    return evalQuadraticBezier(p0, p1, p2, u);
  }

  return ruledSurfaceWithEllipseCorrection(sk, panel, jArc, kRing, M, N);
}

/**
 * Catmull-Rom through **all** seam positions at a given height, with an additive ellipse
 * correction so the bottom row matches the sweatband exactly. The CR spline gives C1
 * tangent continuity at every seam boundary, eliminating the visible creases that the
 * old linear (ruled-surface) blend produced.
 */
function ruledSurfaceWithEllipseCorrection(
  sk: BuiltSkeleton,
  panel: number,
  jArc: number,
  kRing: number,
  M: number,
  N: number
): [number, number, number] {
  const n = sk.spec.nSeams;
  const u = kRing / N;
  const blend = jArc / M;
  const spec = sk.spec;

  const ring: [number, number, number][] = [];
  for (let i = 0; i < n; i++) {
    ring.push(evalSeamCurve(sk.seamControls[i]!, u));
  }
  const crPt = catmullRomClosed(ring, panel, blend);

  const theta = panelInteriorTheta(sk.angles, panel, jArc, M);
  const rimOnEllipse = sweatbandPoint(theta, spec.semiAxisX, spec.semiAxisY, spec.yawRad);
  const rimCR = catmullRomClosed(sk.rimPoints, panel, blend);

  const fade = (1 - u) * (1 - u);
  return [
    crPt[0] + (rimOnEllipse[0] - rimCR[0]) * fade,
    crPt[1] + (rimOnEllipse[1] - rimCR[1]) * fade,
    crPt[2] + (rimOnEllipse[2] - rimCR[2]) * fade,
  ];
}

/**
 * Same construction as the crown mesh interior: ruled surface + ellipse correction.
 * Exported for debug overlay in {@link buildHatGroup}.
 */
export function ruledSurfaceVertexBetweenSeams(
  sk: BuiltSkeleton,
  panel: number,
  jArc: number,
  kRing: number,
  M: number,
  N: number
): [number, number, number] {
  return ruledSurfaceWithEllipseCorrection(sk, panel, jArc, kRing, M, N);
}

function lerp3(
  a: [number, number, number],
  b: [number, number, number],
  t: number
): [number, number, number] {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

/**
 * Uniform Catmull-Rom on a **closed** ring of points.
 * `segment` = panel index, `t ∈ [0,1]` within that panel.
 * At t=0 → pts[segment], t=1 → pts[(segment+1)%n], with C1 continuity at every knot.
 */
function catmullRomClosed(
  pts: [number, number, number][],
  segment: number,
  t: number
): [number, number, number] {
  const n = pts.length;
  const p0 = pts[((segment - 1) % n + n) % n]!;
  const p1 = pts[segment % n]!;
  const p2 = pts[(segment + 1) % n]!;
  const p3 = pts[(segment + 2) % n]!;
  const t2 = t * t;
  const t3 = t2 * t;
  return [
    0.5 * (2 * p1[0] + (-p0[0] + p2[0]) * t + (2 * p0[0] - 5 * p1[0] + 4 * p2[0] - p3[0]) * t2 + (-p0[0] + 3 * p1[0] - 3 * p2[0] + p3[0]) * t3),
    0.5 * (2 * p1[1] + (-p0[1] + p2[1]) * t + (2 * p0[1] - 5 * p1[1] + 4 * p2[1] - p3[1]) * t2 + (-p0[1] + 3 * p1[1] - 3 * p2[1] + p3[1]) * t3),
    0.5 * (2 * p1[2] + (-p0[2] + p2[2]) * t + (2 * p0[2] - 5 * p1[2] + 4 * p2[2] - p3[2]) * t2 + (-p0[2] + 3 * p1[2] - 3 * p2[2] + p3[2]) * t3),
  ];
}

function normalizeAngle(theta: number): number {
  let t = theta % (2 * Math.PI);
  if (t < 0) t += 2 * Math.PI;
  return t;
}

/** Map rim angle θ to panel index and fractional seam arc position j ∈ [0, M]. */
export function thetaToPanelAndJFloat(
  theta: number,
  angles: Float64Array,
  M: number
): { panel: number; j: number } {
  const n = angles.length;
  const t = normalizeAngle(theta);
  for (let p = 0; p < n; p++) {
    const a0 = angles[p]!;
    const span = panelArcSpan(angles, p);
    if (span <= 1e-12) continue;
    let dt = t - a0;
    if (dt < 0) dt += 2 * Math.PI;
    if (dt <= span + 1e-6) {
      const j = (dt / span) * M;
      return { panel: p, j: Math.min(Math.max(j, 0), M) };
    }
  }
  return { panel: 0, j: 0 };
}

/** Bilinear interpolation on the crown grid (fractional j and k ring). */
export function panelVertexLerpJK(
  sk: BuiltSkeleton,
  panel: number,
  jFloat: number,
  kFloat: number,
  M: number,
  N: number
): [number, number, number] {
  const j0 = Math.floor(jFloat);
  const j1 = Math.min(j0 + 1, M);
  const ja = jFloat - j0;
  const k0 = Math.floor(kFloat);
  const k1 = Math.min(k0 + 1, N);
  const k0c = Math.max(0, Math.min(k0, N));
  const k1c = Math.max(0, Math.min(k1, N));
  const ka = kFloat - k0;
  const p00 = panelVertex(sk, panel, j0, k0c, M, N);
  const p10 = panelVertex(sk, panel, j1, k0c, M, N);
  const p01 = panelVertex(sk, panel, j0, k1c, M, N);
  const p11 = panelVertex(sk, panel, j1, k1c, M, N);
  return lerp3(lerp3(p00, p10, ja), lerp3(p01, p11, ja), ka);
}

/** Point on the crown interior surface at rim angle θ and vertical ring k (0 = rim, N = apex region). */
export function crownMeridianPointAtK(
  sk: BuiltSkeleton,
  theta: number,
  kFloat: number,
  M: number,
  N: number
): [number, number, number] {
  const { panel, j } = thetaToPanelAndJFloat(theta, sk.angles, M);
  return panelVertexLerpJK(sk, panel, j, kFloat, M, N);
}

/**
 * k-ring index such that skeleton Z rises by `deltaZ` from the rim along the meridian at θ.
 */
export function findKRingForDeltaZ(
  sk: BuiltSkeleton,
  theta: number,
  M: number,
  N: number,
  deltaZ: number
): number {
  const { panel, j } = thetaToPanelAndJFloat(theta, sk.angles, M);
  const z0 = panelVertexLerpJK(sk, panel, j, 0, M, N)[2];
  let lo = 0;
  let hi = N;
  for (let iter = 0; iter < 28; iter++) {
    const mid = (lo + hi) / 2;
    const z = panelVertexLerpJK(sk, panel, j, mid, M, N)[2];
    if (z - z0 >= deltaZ) hi = mid;
    else lo = mid;
  }
  return (lo + hi) / 2;
}

/**
 * One vertical column of the crown mesh (same positions as triangle strips): rim → top.
 * Use for wireframe overlays so guides sit on the surface (not chord-lerp inside the ellipse).
 */
export function samplePanelMeridian(
  sk: BuiltSkeleton,
  panel: number,
  jArc: number,
  M: number,
  N: number
): [number, number, number][] {
  const pts: [number, number, number][] = [];
  for (let k = 0; k <= N; k++) {
    pts.push(panelVertex(sk, panel, jArc, k, M, N));
  }
  return pts;
}

/**
 * Crown: bottom follows the sweatband ellipse per panel; edges use seam curves (Bézier or split);
 * interior uses matching quadratic bulges. Outer + inner surfaces plus rim/top edge walls
 * (see {@link CROWN_SHELL_THICKNESS_M}).
 */
export function buildCrownGeometry(sk: BuiltSkeleton): THREE.BufferGeometry {
  const n = sk.spec.nSeams;
  const M = crownArcSegments(sk.spec);
  const N = crownVerticalRings(sk.spec);
  const positions: number[] = [];
  const collapseTop = (sk.spec.topRimFraction ?? 0) <= 1e-12;
  const t = CROWN_SHELL_THICKNESS_M;

  function pushOuterStrip(
    k: number,
    v00: [number, number, number],
    v10: [number, number, number],
    v01: [number, number, number],
    v11: [number, number, number]
  ): void {
    const lastStrip = k === N - 1;
    if (!lastStrip || !collapseTop) {
      pushTriangle(positions, v00, v10, v01);
      pushTriangle(positions, v10, v11, v01);
    } else {
      pushTriangle(positions, v00, v10, v01);
    }
  }

  function pushInnerStrip(
    k: number,
    i00: [number, number, number],
    i10: [number, number, number],
    i01: [number, number, number],
    i11: [number, number, number]
  ): void {
    const lastStrip = k === N - 1;
    if (!lastStrip || !collapseTop) {
      pushTriangle(positions, i00, i01, i10);
      pushTriangle(positions, i10, i01, i11);
    } else {
      pushTriangle(positions, i00, i01, i10);
    }
  }

  for (let panel = 0; panel < n; panel++) {
    for (let k = 0; k < N; k++) {
      for (let j = 0; j < M; j++) {
        const v00 = panelVertex(sk, panel, j, k, M, N);
        const v10 = panelVertex(sk, panel, j + 1, k, M, N);
        const v01 = panelVertex(sk, panel, j, k + 1, M, N);
        const v11 = panelVertex(sk, panel, j + 1, k + 1, M, N);
        pushOuterStrip(k, v00, v10, v01, v11);
      }
    }
  }

  for (let panel = 0; panel < n; panel++) {
    for (let k = 0; k < N; k++) {
      for (let j = 0; j < M; j++) {
        const i00 = offsetCrownVertexInward(sk, panel, j, k, M, N, t);
        const i10 = offsetCrownVertexInward(sk, panel, j + 1, k, M, N, t);
        const i01 = offsetCrownVertexInward(sk, panel, j, k + 1, M, N, t);
        const i11 = offsetCrownVertexInward(sk, panel, j + 1, k + 1, M, N, t);
        pushInnerStrip(k, i00, i10, i01, i11);
      }
    }
  }

  for (let panel = 0; panel < n; panel++) {
    for (let j = 0; j < M; j++) {
      const o0 = panelVertex(sk, panel, j, 0, M, N);
      const o1 = panelVertex(sk, panel, j + 1, 0, M, N);
      const i0 = offsetCrownVertexInward(sk, panel, j, 0, M, N, t);
      const i1 = offsetCrownVertexInward(sk, panel, j + 1, 0, M, N, t);
      pushTriangle(positions, o0, i0, o1);
      pushTriangle(positions, o1, i0, i1);
    }
  }

  if (collapseTop) {
    for (let panel = 0; panel < n; panel++) {
      const k = N - 1;
      for (let j = 0; j < M; j++) {
        const o0 = panelVertex(sk, panel, j, k, M, N);
        const o1 = panelVertex(sk, panel, j + 1, k, M, N);
        const i0 = offsetCrownVertexInward(sk, panel, j, k, M, N, t);
        const i1 = offsetCrownVertexInward(sk, panel, j + 1, k, M, N, t);
        pushTriangle(positions, o0, o1, i1);
        pushTriangle(positions, o0, i1, i0);
      }
    }
  } else {
    for (let panel = 0; panel < n; panel++) {
      const k = N;
      for (let j = 0; j < M; j++) {
        const o0 = panelVertex(sk, panel, j, k, M, N);
        const o1 = panelVertex(sk, panel, j + 1, k, M, N);
        const i0 = offsetCrownVertexInward(sk, panel, j, k, M, N, t);
        const i1 = offsetCrownVertexInward(sk, panel, j + 1, k, M, N, t);
        pushTriangle(positions, o0, o1, i1);
        pushTriangle(positions, o0, i1, i0);
      }
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geo.computeVertexNormals();
  return geo;
}
