import * as THREE from "three";
import type { HatSkeletonSpec } from "@/lib/skeleton/types";
import type { BuiltSkeleton } from "@/lib/skeleton/geometry";
import {
  evalQuadraticBezier,
  evalSeamCurve,
  evalSeamSuperellipse,
  evalVToArcGuideMeridianAt,
  frontCenterSeamIndex,
  frontGuideAlpha,
  frontGuideArcAndVIndices,
  frontRisePanelIndices,
  seamQuadraticBezier,
  effectiveSquarenessForSeam,
  solveSquarenessForArcLengthMultiplier,
  sweatbandPoint,
  topRimPoint,
} from "@/lib/skeleton/geometry";

/** Vertical rings from rim (u=0) to apex (u=1), following seam curves on panel edges. */
export const CROWN_VERTICAL_RINGS = 48;

/** Finer vertical rings when front V-split is on (smaller quads along the sharp fold). */
export const CROWN_VERTICAL_RINGS_VSPLIT = 64;

/** Default crown fabric thickness (m); inner surface is offset along outward normals. */
export const CROWN_SHELL_THICKNESS_M = 0.002;

/**
 * Maximum arc-segment width (m) at the widest panel rim. `buildCrownPanelGeometries` raises
 * M until every rim segment is ≤ this size so the single-vertex seam groove reads as a
 * consistent thin line from bottom to top.
 */
const CROWN_MAX_ARC_SEGMENT_M = 0.001;

/**
 * Logical arc segments between two seams (used by seam tape, sweatband, debug viz).
 * The crown render mesh may use a higher M via the adaptive cap above.
 */
export const ARC_SEGMENTS_DEFAULT = 32;
/**
 * When front V-split is active: more columns between center front and side seams so the mesh
 * follows the lerp meridians and the hard V without large stretched quads.
 */
export const ARC_SEGMENTS_VSPLIT = 40;

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
 * directly and get a radial indent (the seam groove). Interior vertices use unindented paths.
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
    const sc = frontSeamIndentScale(spec, panel, u);
    return seamIndent(evalSeamCurve(seamL, u), spec.seamGrooveDepthM * sc);
  }
  if (jArc === M) {
    const sc = frontSeamIndentScale(spec, (panel + 1) % n, u);
    return seamIndent(evalSeamCurve(seamR, u), spec.seamGrooveDepthM * sc);
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
    const s = solveSquarenessForArcLengthMultiplier(rim, topEnd, spec.seamArcLengthMultiplier);
    const [p0, p1, p2] = seamQuadraticBezier(rim, topEnd, s);
    return evalQuadraticBezier(p0, p1, p2, u);
  }

  if (spec.seamCurveMode === "superellipse") {
    const sL = effectiveSquarenessForSeam(spec, panel);
    const sR = effectiveSquarenessForSeam(spec, (panel + 1) % n);
    const bulge = sL * (1 - blend) + sR * blend;
    return evalSeamSuperellipse(rim, topEnd, spec.seamSuperellipseN ?? 3, bulge, u);
  }

  return ruledSurfaceWithEllipseCorrection(sk, panel, jArc, kRing, M, N);
}

/**
 * For 5-panel mode the front center seam indent fades in only above the cutoff,
 * giving a smooth transition from "no seam" (flat face) to "full seam."
 */
function frontSeamIndentScale(spec: HatSkeletonSpec, seamIdx: number, u: number): number {
  if (seamIdx !== frontCenterSeamIndex(spec.nSeams) || spec.fivePanelCenterSeamLength >= 1)
    return 1;
  const cutoff = 1 - spec.fivePanelCenterSeamLength;
  if (u <= cutoff) return 0;
  return Math.min(1, (u - cutoff) / 0.05);
}

/** Push a point radially inward (toward the Z axis) by `depthM` metres. */
function seamIndent(
  p: [number, number, number],
  depthM: number
): [number, number, number] {
  if (depthM <= 0) return p;
  const r = Math.hypot(p[0], p[1]);
  if (r < 1e-10) return p;
  const s = Math.max(0, 1 - depthM / r);
  return [p[0] * s, p[1] * s, p[2]];
}

/**
 * Sample a seam like {@link sampleSeamWireframeTo} in geometry, then apply the same radial
 * groove indent as {@link panelVertex} on seam edges so threading follows the visible seam.
 */
export function sampleSeamWireframeToWithGroove(
  sk: BuiltSkeleton,
  seamIdx: number,
  segments: number,
  uMax: number,
): [number, number, number][] {
  const curve = sk.seamControls[seamIdx]!;
  const spec = sk.spec;
  const tEnd = Math.max(0, Math.min(1, uMax));
  const pts: [number, number, number][] = [];
  for (let i = 0; i <= segments; i++) {
    const t = (i / segments) * tEnd;
    const raw =
      curve.kind === "vSplit"
        ? evalSeamCurve({ ...curve, blend: 1 }, t)
        : evalSeamCurve(curve, t);
    const sc = frontSeamIndentScale(spec, seamIdx, t);
    pts.push(seamIndent(raw, spec.seamGrooveDepthM * sc));
  }
  return pts;
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

function crownMeshResolution(sk: BuiltSkeleton): {
  M: number;
  N: number;
  collapseTop: boolean;
} {
  const N = crownVerticalRings(sk.spec);
  const M_logic = crownArcSegments(sk.spec);
  const n = sk.spec.nSeams;
  let maxPanelChord = 0;
  for (let i = 0; i < n; i++) {
    const a = sk.rimPoints[i]!;
    const b = sk.rimPoints[(i + 1) % n]!;
    maxPanelChord = Math.max(maxPanelChord, Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]));
  }
  const M = Math.max(M_logic, Math.ceil(maxPanelChord / CROWN_MAX_ARC_SEGMENT_M));
  const collapseTop = (sk.spec.topRimFraction ?? 0) <= 1e-12;
  return { M, N, collapseTop };
}

function computePanelOuterInnerGrids(
  sk: BuiltSkeleton,
  panel: number,
  M: number,
  N: number
): {
  outer: [number, number, number][][];
  inner: [number, number, number][][];
} {
  const t = CROWN_SHELL_THICKNESS_M;
  const outer: [number, number, number][][] = new Array(M + 1);
  for (let j = 0; j <= M; j++) {
    outer[j] = new Array(N + 1);
    for (let k = 0; k <= N; k++) {
      outer[j]![k] = panelVertex(sk, panel, j, k, M, N);
    }
  }

  const normals: [number, number, number][][] = new Array(M + 1);
  for (let j = 0; j <= M; j++) {
    normals[j] = new Array(N + 1);
    for (let k = 0; k <= N; k++) {
      const pjL = outer[j > 0 ? j - 1 : j]![k]!;
      const pjR = outer[j < M ? j + 1 : j]![k]!;
      const pkL = outer[j]![k > 0 ? k - 1 : k]!;
      const pkR = outer[j]![k < N ? k + 1 : k]!;
      const du = sub3(pjR, pjL);
      const dv = sub3(pkR, pkL);
      let nm = cross3(du, dv);
      let len = Math.hypot(nm[0], nm[1], nm[2]);
      if (len < 1e-12) {
        const p = outer[j]![k]!;
        const r = Math.hypot(p[0], p[1]);
        nm = r < 1e-12 ? [0, 0, 1] : [p[0] / r, p[1] / r, 0];
        len = 1;
      }
      normals[j]![k] = [nm[0] / len, nm[1] / len, nm[2] / len];
    }
  }

  const inner: [number, number, number][][] = new Array(M + 1);
  for (let j = 0; j <= M; j++) {
    inner[j] = new Array(N + 1);
    for (let k = 0; k <= N; k++) {
      const p = outer[j]![k]!;
      const nm = normals[j]![k]!;
      inner[j]![k] = [p[0] - t * nm[0], p[1] - t * nm[1], p[2] - t * nm[2]];
    }
  }

  return { outer, inner };
}

function pushInnerSurfaceQuads(
  positions: number[],
  inner: [number, number, number][][],
  M: number,
  N: number,
  collapseTop: boolean
): void {
  for (let k = 0; k < N; k++) {
    const lastStrip = k === N - 1;
    for (let j = 0; j < M; j++) {
      const i00 = inner[j]![k]!;
      const i10 = inner[j + 1]![k]!;
      const i01 = inner[j]![k + 1]!;
      const i11 = inner[j + 1]![k + 1]!;
      if (!lastStrip || !collapseTop) {
        pushTriangle(positions, i00, i01, i10);
        pushTriangle(positions, i10, i01, i11);
      } else {
        pushTriangle(positions, i00, i01, i10);
      }
    }
  }
}

/**
 * Crown: bottom follows the sweatband ellipse per panel; edges use seam curves (Bézier or split);
 * interior uses matching quadratic bulges. Outer + inner surfaces plus rim/top edge walls
 * (see {@link CROWN_SHELL_THICKNESS_M}).
 */
export function buildCrownGeometry(sk: BuiltSkeleton): THREE.BufferGeometry {
  const geos = buildCrownPanelGeometries(sk);
  const innerFront = buildInnerFrontRiseGeometries(sk);
  const merged = new THREE.BufferGeometry();
  const allPositions: number[] = [];
  for (const g of geos) {
    const attr = g.getAttribute("position") as THREE.BufferAttribute;
    for (let i = 0; i < attr.count * 3; i++) allPositions.push(attr.array[i]!);
    g.dispose();
  }
  for (const g of innerFront) {
    const attr = g.getAttribute("position") as THREE.BufferAttribute;
    for (let i = 0; i < attr.count * 3; i++) allPositions.push(attr.array[i]!);
    g.dispose();
  }
  merged.setAttribute("position", new THREE.Float32BufferAttribute(allPositions, 3));
  merged.computeVertexNormals();
  return merged;
}

/**
 * Inner fabric surface only for front rise panels (split from main crown shells for separate materials).
 */
export function buildInnerFrontRiseGeometries(sk: BuiltSkeleton): THREE.BufferGeometry[] {
  const { M, N, collapseTop } = crownMeshResolution(sk);
  const geos: THREE.BufferGeometry[] = [];
  for (const panel of frontRisePanelIndices(sk.spec.nSeams)) {
    const { inner } = computePanelOuterInnerGrids(sk, panel, M, N);
    const positions: number[] = [];
    pushInnerSurfaceQuads(positions, inner, M, N, collapseTop);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
    geo.computeVertexNormals();
    geos.push(geo);
  }
  return geos;
}

/**
 * One BufferGeometry per crown panel (outer + inner shell, rim wall, top wall).
 * Front rise panels omit the inner shell from this mesh; use {@link buildInnerFrontRiseGeometries}.
 */
export function buildCrownPanelGeometries(sk: BuiltSkeleton): THREE.BufferGeometry[] {
  const n = sk.spec.nSeams;
  const { M, N, collapseTop } = crownMeshResolution(sk);
  const frontRise = new Set(frontRisePanelIndices(sk.spec.nSeams));
  const geos: THREE.BufferGeometry[] = [];

  for (let panel = 0; panel < n; panel++) {
    const positions: number[] = [];
    const { outer, inner } = computePanelOuterInnerGrids(sk, panel, M, N);

    for (let k = 0; k < N; k++) {
      const lastStrip = k === N - 1;
      for (let j = 0; j < M; j++) {
        const v00 = outer[j]![k]!;
        const v10 = outer[j + 1]![k]!;
        const v01 = outer[j]![k + 1]!;
        const v11 = outer[j + 1]![k + 1]!;
        if (!lastStrip || !collapseTop) {
          pushTriangle(positions, v00, v10, v01);
          pushTriangle(positions, v10, v11, v01);
        } else {
          pushTriangle(positions, v00, v10, v01);
        }
      }
    }

    if (!frontRise.has(panel)) {
      pushInnerSurfaceQuads(positions, inner, M, N, collapseTop);
    }

    for (let j = 0; j < M; j++) {
      pushTriangle(positions, outer[j]![0]!, inner[j]![0]!, outer[j + 1]![0]!);
      pushTriangle(positions, outer[j + 1]![0]!, inner[j]![0]!, inner[j + 1]![0]!);
    }

    {
      const k = collapseTop ? N - 1 : N;
      for (let j = 0; j < M; j++) {
        pushTriangle(positions, outer[j]![k]!, outer[j + 1]![k]!, inner[j + 1]![k]!);
        pushTriangle(positions, outer[j]![k]!, inner[j + 1]![k]!, inner[j]![k]!);
      }
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
    geo.computeVertexNormals();
    geos.push(geo);
  }

  return geos;
}
