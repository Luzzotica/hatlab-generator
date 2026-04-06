import * as THREE from "three";
import type { HatSkeletonSpec } from "@/lib/skeleton/types";
import type { BuiltSkeleton } from "@/lib/skeleton/geometry";
import {
  closureLocalWH,
  getBackClosureOpeningFrame,
  getClosureCutterDimensions,
  getRearClosureAdjacentPanelIndices,
  pointInsideStadiumOpening2D,
} from "@/lib/mesh/backClosureSubtract";
import { agentDebugLog } from "@/lib/debug/agentDebugLog";
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
  visorFrontBellAtTheta,
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
 * Closure tunnel lip uses a slightly larger stadium than the cut mask so it overlaps
 * stair-stepped hole edges; plus a normal outset to match curved outer shell vs meridian projection.
 */
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
  return spec.frontVSplit != null
    ? CROWN_VERTICAL_RINGS_VSPLIT
    : CROWN_VERTICAL_RINGS;
}

function pushTriangle(
  positions: number[],
  a: [number, number, number],
  b: [number, number, number],
  c: [number, number, number],
): void {
  positions.push(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2]);
}

function sub3(
  a: readonly [number, number, number],
  b: readonly [number, number, number],
): [number, number, number] {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

function cross3(
  a: readonly [number, number, number],
  b: readonly [number, number, number],
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
  N: number,
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
  thickness: number,
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
function panelInteriorTheta(
  angles: Float64Array,
  panel: number,
  j: number,
  M: number,
): number {
  const a0 = angles[panel]!;
  return a0 + (j / M) * panelArcSpan(angles, panel);
}

/** Rim θ for lift envelope: seam columns use seam angles; interior uses ellipse interpolation. */
function panelVertexThetaForLift(
  sk: BuiltSkeleton,
  panel: number,
  jArc: number,
  M: number,
): number {
  const n = sk.spec.nSeams;
  if (jArc === 0) return sk.angles[panel]!;
  if (jArc === M) return sk.angles[(panel + 1) % n]!;
  return panelInteriorTheta(sk.angles, panel, jArc, M);
}

function applyFrontRiseVisorLift(
  sk: BuiltSkeleton,
  p: [number, number, number],
  panel: number,
  jArc: number,
  kRing: number,
  M: number,
  N: number,
): [number, number, number] {
  if (!frontRisePanelIndices(sk.spec.nSeams).includes(panel)) return p;
  const r = sk.spec.visor.visorFrontLiftRatio ?? 1;
  const curv = sk.spec.visor.visorCurvatureM ?? 0;
  if (curv <= 1e-15 || r <= 1e-15) return p;
  const theta = panelVertexThetaForLift(sk, panel, jArc, M);
  const bell = visorFrontBellAtTheta(sk, theta);
  const u = kRing / N;
  /** Strongest at the rim (u→0) so the bottom follows the visor; fades to 0 at the apex (no top lift). */
  const fade = (1 - u) * (1 - u);
  const dz = r * curv * bell * fade;
  return [p[0], p[1], p[2] + dz];
}

/** Top endpoint for a meridian at θ: small button ring (flat top) or single point if fraction is 0. */
function topEndForTheta(
  sk: BuiltSkeleton,
  theta: number,
): [number, number, number] {
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
    f,
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
  N: number,
): [number, number, number] {
  const n = sk.spec.nSeams;
  const u = kRing / N;
  const spec = sk.spec;
  const seamL = sk.seamControls[panel]!;
  const seamR = sk.seamControls[(panel + 1) % n]!;

  let p: [number, number, number];

  if (jArc === 0) {
    const sc = frontSeamIndentScale(spec, panel, u);
    p = seamIndent(evalSeamCurve(seamL, u), spec.seamGrooveDepthM * sc);
  } else if (jArc === M) {
    const sc = frontSeamIndentScale(spec, (panel + 1) % n, u);
    p = seamIndent(evalSeamCurve(seamR, u), spec.seamGrooveDepthM * sc);
  } else if (seamL.kind === "vSplit" || seamR.kind === "vSplit") {
    const frontSeamIdx = frontCenterSeamIndex(n);
    const [seamArcIdx, seamVIdx] = frontGuideArcAndVIndices(
      panel,
      frontSeamIdx,
      n,
    );
    const alpha = frontGuideAlpha(panel, jArc, M, frontSeamIdx, n);
    p = evalVToArcGuideMeridianAt(sk, seamArcIdx, seamVIdx, alpha, u);
  } else {
    const theta = panelInteriorTheta(sk.angles, panel, jArc, M);
    const rim = sweatbandPoint(
      theta,
      spec.semiAxisX,
      spec.semiAxisY,
      spec.yawRad,
    );
    const blend = jArc / M;
    const topEnd = topEndForTheta(sk, theta);

    if (spec.seamCurveMode === "arcLength") {
      const s = solveSquarenessForArcLengthMultiplier(
        rim,
        topEnd,
        spec.seamArcLengthMultiplier,
      );
      const [p0, p1, p2] = seamQuadraticBezier(rim, topEnd, s);
      p = evalQuadraticBezier(p0, p1, p2, u);
    } else if (spec.seamCurveMode === "superellipse") {
      const sL = effectiveSquarenessForSeam(spec, panel);
      const sR = effectiveSquarenessForSeam(spec, (panel + 1) % n);
      const bulge = sL * (1 - blend) + sR * blend;
      p = evalSeamSuperellipse(
        rim,
        topEnd,
        spec.seamSuperellipseN ?? 3,
        bulge,
        u,
      );
    } else {
      p = ruledSurfaceWithEllipseCorrection(sk, panel, jArc, kRing, M, N);
    }
  }

  return applyFrontRiseVisorLift(sk, p, panel, jArc, kRing, M, N);
}

/**
 * For 5-panel mode the front center seam indent fades in only above the cutoff,
 * giving a smooth transition from "no seam" (flat face) to "full seam."
 */
function frontSeamIndentScale(
  spec: HatSkeletonSpec,
  seamIdx: number,
  u: number,
): number {
  if (
    seamIdx !== frontCenterSeamIndex(spec.nSeams) ||
    spec.fivePanelCenterSeamLength >= 1
  )
    return 1;
  const cutoff = 1 - spec.fivePanelCenterSeamLength;
  if (u <= cutoff) return 0;
  return Math.min(1, (u - cutoff) / 0.05);
}

/** Push a point radially inward (toward the Z axis) by `depthM` metres. */
function seamIndent(
  p: [number, number, number],
  depthM: number,
): [number, number, number] {
  if (depthM <= 0) return p;
  const r = Math.hypot(p[0], p[1]);
  if (r < 1e-10) return p;
  const s = Math.max(0, 1 - depthM / r);
  return [p[0] * s, p[1] * s, p[2]];
}

/**
 * Seam polyline on the crown exterior: same positions as {@link panelVertex} on the left
 * edge of panel `seamIdx` (groove indent and visor lift included) so threading matches the mesh.
 */
export function sampleSeamWireframeToWithGroove(
  sk: BuiltSkeleton,
  seamIdx: number,
  segments: number,
  uMax: number,
): [number, number, number][] {
  const tEnd = Math.max(0, Math.min(1, uMax));
  const M = crownArcSegments(sk.spec);
  const N = crownVerticalRings(sk.spec);
  const pts: [number, number, number][] = [];
  for (let i = 0; i <= segments; i++) {
    const t = (i / segments) * tEnd;
    const kFloat = t * N;
    pts.push(panelVertexLerpJK(sk, seamIdx, 0, kFloat, M, N));
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
  N: number,
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
  const rimOnEllipse = sweatbandPoint(
    theta,
    spec.semiAxisX,
    spec.semiAxisY,
    spec.yawRad,
  );
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
  N: number,
): [number, number, number] {
  return ruledSurfaceWithEllipseCorrection(sk, panel, jArc, kRing, M, N);
}

function lerp3(
  a: [number, number, number],
  b: [number, number, number],
  t: number,
): [number, number, number] {
  return [
    a[0] + (b[0] - a[0]) * t,
    a[1] + (b[1] - a[1]) * t,
    a[2] + (b[2] - a[2]) * t,
  ];
}

/**
 * Uniform Catmull-Rom on a **closed** ring of points.
 * `segment` = panel index, `t ∈ [0,1]` within that panel.
 * At t=0 → pts[segment], t=1 → pts[(segment+1)%n], with C1 continuity at every knot.
 */
function catmullRomClosed(
  pts: [number, number, number][],
  segment: number,
  t: number,
): [number, number, number] {
  const n = pts.length;
  const p0 = pts[(((segment - 1) % n) + n) % n]!;
  const p1 = pts[segment % n]!;
  const p2 = pts[(segment + 1) % n]!;
  const p3 = pts[(segment + 2) % n]!;
  const t2 = t * t;
  const t3 = t2 * t;
  return [
    0.5 *
      (2 * p1[0] +
        (-p0[0] + p2[0]) * t +
        (2 * p0[0] - 5 * p1[0] + 4 * p2[0] - p3[0]) * t2 +
        (-p0[0] + 3 * p1[0] - 3 * p2[0] + p3[0]) * t3),
    0.5 *
      (2 * p1[1] +
        (-p0[1] + p2[1]) * t +
        (2 * p0[1] - 5 * p1[1] + 4 * p2[1] - p3[1]) * t2 +
        (-p0[1] + 3 * p1[1] - 3 * p2[1] + p3[1]) * t3),
    0.5 *
      (2 * p1[2] +
        (-p0[2] + p2[2]) * t +
        (2 * p0[2] - 5 * p1[2] + 4 * p2[2] - p3[2]) * t2 +
        (-p0[2] + 3 * p1[2] - 3 * p2[2] + p3[2]) * t3),
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
  M: number,
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
  N: number,
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
  N: number,
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
  deltaZ: number,
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
  N: number,
): [number, number, number][] {
  const pts: [number, number, number][] = [];
  for (let k = 0; k <= N; k++) {
    pts.push(panelVertex(sk, panel, jArc, k, M, N));
  }
  return pts;
}

/** Same M, N, and top-collapse flag as {@link buildCrownPanelGeometries} (includes chord-based M bump). */
export function getCrownMeshResolution(sk: BuiltSkeleton): {
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
    maxPanelChord = Math.max(
      maxPanelChord,
      Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]),
    );
  }
  const M = Math.max(
    M_logic,
    Math.ceil(maxPanelChord / CROWN_MAX_ARC_SEGMENT_M),
  );
  const collapseTop = (sk.spec.topRimFraction ?? 0) <= 1e-12;
  return { M, N, collapseTop };
}

function computePanelOuterInnerGrids(
  sk: BuiltSkeleton,
  panel: number,
  M: number,
  N: number,
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

type ClosureCutSpec = {
  rimAnchor: [number, number, number];
  tW: [number, number, number];
  tH: [number, number, number];
  widthM: number;
  straightM: number;
};

const CLOSURE_SUBDIV_MAX_DEPTH = 4;

function vertexInsideClosureOpening(
  p: readonly [number, number, number],
  cut: ClosureCutSpec,
): boolean {
  const { lw, lh } = closureLocalWH(p, cut.rimAnchor, cut.tW, cut.tH);
  return pointInsideStadiumOpening2D(lw, lh, cut.widthM, cut.straightM);
}

function midpoint3(
  a: readonly [number, number, number],
  b: readonly [number, number, number],
): [number, number, number] {
  return [(a[0] + b[0]) * 0.5, (a[1] + b[1]) * 0.5, (a[2] + b[2]) * 0.5];
}

/** Bilinear sample on the precomputed inner offset grid (same topology as outer). */
function innerLerpJK(
  inner: [number, number, number][][],
  jFloat: number,
  kFloat: number,
  M: number,
  N: number,
): [number, number, number] {
  const j0 = Math.floor(jFloat);
  const j1 = Math.min(j0 + 1, M);
  const ja = jFloat - j0;
  const k0 = Math.floor(kFloat);
  const k1 = Math.min(k0 + 1, N);
  const k0c = Math.max(0, Math.min(k0, N));
  const k1c = Math.max(0, Math.min(k1, N));
  const ka = kFloat - k0;
  const p00 = inner[j0]![k0c]!;
  const p10 = inner[j1]![k0c]!;
  const p01 = inner[j0]![k1c]!;
  const p11 = inner[j1]![k1c]!;
  return lerp3(lerp3(p00, p10, ja), lerp3(p01, p11, ja), ka);
}

type ClosureParamMesh = {
  verts: [number, number, number][];
  jf: number[];
  kf: number[];
  indices: number[];
  keyMap: Map<string, number>;
};

function createClosureParamMesh(): ClosureParamMesh {
  return { verts: [], jf: [], kf: [], indices: [], keyMap: new Map() };
}

function addClosureParamVert(
  mesh: ClosureParamMesh,
  j: number,
  k: number,
  p: [number, number, number],
): number {
  const key = `${j.toFixed(8)},${k.toFixed(8)}`;
  const ex = mesh.keyMap.get(key);
  if (ex !== undefined) return ex;
  const idx = mesh.verts.length;
  mesh.verts.push(p);
  mesh.jf.push(j);
  mesh.kf.push(k);
  mesh.keyMap.set(key, idx);
  return idx;
}

function emitClosureQuadToMeshes(
  outerMesh: ClosureParamMesh,
  innerMesh: ClosureParamMesh,
  ja: number,
  jb: number,
  ka: number,
  kb: number,
  o00: [number, number, number],
  o10: [number, number, number],
  o11: [number, number, number],
  o01: [number, number, number],
  i00: [number, number, number],
  i10: [number, number, number],
  i11: [number, number, number],
  i01: [number, number, number],
): void {
  const oa = addClosureParamVert(outerMesh, ja, ka, o00);
  const ob = addClosureParamVert(outerMesh, jb, ka, o10);
  const oc = addClosureParamVert(outerMesh, jb, kb, o11);
  const od = addClosureParamVert(outerMesh, ja, kb, o01);
  outerMesh.indices.push(oa, ob, od, ob, oc, od);

  const ia = addClosureParamVert(innerMesh, ja, ka, i00);
  const ib = addClosureParamVert(innerMesh, jb, ka, i10);
  const ic = addClosureParamVert(innerMesh, jb, kb, i11);
  const id = addClosureParamVert(innerMesh, ja, kb, i01);
  innerMesh.indices.push(ia, id, ib, ib, id, ic);
}

function appendClosureQuadParametric(
  sk: BuiltSkeleton,
  panel: number,
  inner: [number, number, number][][],
  M: number,
  N: number,
  ja: number,
  jb: number,
  ka: number,
  kb: number,
  depth: number,
  cut: ClosureCutSpec,
  outerMesh: ClosureParamMesh,
  innerMesh: ClosureParamMesh,
): void {
  const o00 = panelVertexLerpJK(sk, panel, ja, ka, M, N);
  const o10 = panelVertexLerpJK(sk, panel, jb, ka, M, N);
  const o11 = panelVertexLerpJK(sk, panel, jb, kb, M, N);
  const o01 = panelVertexLerpJK(sk, panel, ja, kb, M, N);
  const i00 = innerLerpJK(inner, ja, ka, M, N);
  const i10 = innerLerpJK(inner, jb, ka, M, N);
  const i11 = innerLerpJK(inner, jb, kb, M, N);
  const i01 = innerLerpJK(inner, ja, kb, M, N);

  const in00 = vertexInsideClosureOpening(o00, cut);
  const in10 = vertexInsideClosureOpening(o10, cut);
  const in11 = vertexInsideClosureOpening(o11, cut);
  const in01 = vertexInsideClosureOpening(o01, cut);
  if (in00 && in10 && in11 && in01) return;
  if (!in00 && !in10 && !in11 && !in01) {
    emitClosureQuadToMeshes(
      outerMesh,
      innerMesh,
      ja,
      jb,
      ka,
      kb,
      o00,
      o10,
      o11,
      o01,
      i00,
      i10,
      i11,
      i01,
    );
    return;
  }
  if (depth >= CLOSURE_SUBDIV_MAX_DEPTH) {
    const center = midpoint3(midpoint3(o00, o11), midpoint3(o10, o01));
    if (!vertexInsideClosureOpening(center, cut)) {
      emitClosureQuadToMeshes(
        outerMesh,
        innerMesh,
        ja,
        jb,
        ka,
        kb,
        o00,
        o10,
        o11,
        o01,
        i00,
        i10,
        i11,
        i01,
      );
    }
    return;
  }
  const jm = (ja + jb) * 0.5;
  const km = (ka + kb) * 0.5;
  appendClosureQuadParametric(
    sk,
    panel,
    inner,
    M,
    N,
    ja,
    jm,
    ka,
    km,
    depth + 1,
    cut,
    outerMesh,
    innerMesh,
  );
  appendClosureQuadParametric(
    sk,
    panel,
    inner,
    M,
    N,
    jm,
    jb,
    ka,
    km,
    depth + 1,
    cut,
    outerMesh,
    innerMesh,
  );
  appendClosureQuadParametric(
    sk,
    panel,
    inner,
    M,
    N,
    ja,
    jm,
    km,
    kb,
    depth + 1,
    cut,
    outerMesh,
    innerMesh,
  );
  appendClosureQuadParametric(
    sk,
    panel,
    inner,
    M,
    N,
    jm,
    jb,
    km,
    kb,
    depth + 1,
    cut,
    outerMesh,
    innerMesh,
  );
}

function emitClosureTriToMeshes(
  outerMesh: ClosureParamMesh,
  innerMesh: ClosureParamMesh,
  ja: number,
  ka: number,
  jb: number,
  kb: number,
  jc: number,
  kc: number,
  oA: [number, number, number],
  oB: [number, number, number],
  oC: [number, number, number],
  iA: [number, number, number],
  iB: [number, number, number],
  iC: [number, number, number],
): void {
  const ia = addClosureParamVert(outerMesh, ja, ka, oA);
  const ib = addClosureParamVert(outerMesh, jb, kb, oB);
  const ic = addClosureParamVert(outerMesh, jc, kc, oC);
  outerMesh.indices.push(ia, ib, ic);

  const iia = addClosureParamVert(innerMesh, ja, ka, iA);
  const iib = addClosureParamVert(innerMesh, jb, kb, iB);
  const iic = addClosureParamVert(innerMesh, jc, kc, iC);
  innerMesh.indices.push(iia, iic, iib);
}

function appendClosureTriParametric(
  sk: BuiltSkeleton,
  panel: number,
  inner: [number, number, number][][],
  M: number,
  N: number,
  ja: number,
  ka: number,
  jb: number,
  kb: number,
  jc: number,
  kc: number,
  depth: number,
  cut: ClosureCutSpec,
  outerMesh: ClosureParamMesh,
  innerMesh: ClosureParamMesh,
): void {
  const oA = panelVertexLerpJK(sk, panel, ja, ka, M, N);
  const oB = panelVertexLerpJK(sk, panel, jb, kb, M, N);
  const oC = panelVertexLerpJK(sk, panel, jc, kc, M, N);
  const iA = innerLerpJK(inner, ja, ka, M, N);
  const iB = innerLerpJK(inner, jb, kb, M, N);
  const iC = innerLerpJK(inner, jc, kc, M, N);

  const inA = vertexInsideClosureOpening(oA, cut);
  const inB = vertexInsideClosureOpening(oB, cut);
  const inC = vertexInsideClosureOpening(oC, cut);
  if (inA && inB && inC) return;
  if (!inA && !inB && !inC) {
    emitClosureTriToMeshes(
      outerMesh,
      innerMesh,
      ja,
      ka,
      jb,
      kb,
      jc,
      kc,
      oA,
      oB,
      oC,
      iA,
      iB,
      iC,
    );
    return;
  }
  if (depth >= CLOSURE_SUBDIV_MAX_DEPTH) {
    const center: [number, number, number] = [
      (oA[0] + oB[0] + oC[0]) / 3,
      (oA[1] + oB[1] + oC[1]) / 3,
      (oA[2] + oB[2] + oC[2]) / 3,
    ];
    if (!vertexInsideClosureOpening(center, cut)) {
      emitClosureTriToMeshes(
        outerMesh,
        innerMesh,
        ja,
        ka,
        jb,
        kb,
        jc,
        kc,
        oA,
        oB,
        oC,
        iA,
        iB,
        iC,
      );
    }
    return;
  }
  const jab = (ja + jb) * 0.5;
  const kab = (ka + kb) * 0.5;
  const jac = (ja + jc) * 0.5;
  const kac = (ka + kc) * 0.5;
  const jbc = (jb + jc) * 0.5;
  const kbc = (kb + kc) * 0.5;

  appendClosureTriParametric(
    sk,
    panel,
    inner,
    M,
    N,
    ja,
    ka,
    jab,
    kab,
    jac,
    kac,
    depth + 1,
    cut,
    outerMesh,
    innerMesh,
  );
  appendClosureTriParametric(
    sk,
    panel,
    inner,
    M,
    N,
    jab,
    kab,
    jb,
    kb,
    jbc,
    kbc,
    depth + 1,
    cut,
    outerMesh,
    innerMesh,
  );
  appendClosureTriParametric(
    sk,
    panel,
    inner,
    M,
    N,
    jac,
    kac,
    jbc,
    kbc,
    jc,
    kc,
    depth + 1,
    cut,
    outerMesh,
    innerMesh,
  );
  appendClosureTriParametric(
    sk,
    panel,
    inner,
    M,
    N,
    jab,
    kab,
    jbc,
    kbc,
    jac,
    kac,
    depth + 1,
    cut,
    outerMesh,
    innerMesh,
  );
}

function buildClosureShellIndexedMeshes(
  sk: BuiltSkeleton,
  panel: number,
  inner: [number, number, number][][],
  M: number,
  N: number,
  collapseTop: boolean,
  cut: ClosureCutSpec,
): { outer: ClosureParamMesh; inner: ClosureParamMesh } {
  const outerMesh = createClosureParamMesh();
  const innerMesh = createClosureParamMesh();
  for (let k = 0; k < N; k++) {
    const lastStrip = k === N - 1;
    for (let j = 0; j < M; j++) {
      if (lastStrip && collapseTop) {
        appendClosureTriParametric(
          sk,
          panel,
          inner,
          M,
          N,
          j,
          N - 1,
          j + 1,
          N - 1,
          j,
          N,
          0,
          cut,
          outerMesh,
          innerMesh,
        );
      } else {
        appendClosureQuadParametric(
          sk,
          panel,
          inner,
          M,
          N,
          j,
          j + 1,
          k,
          k + 1,
          0,
          cut,
          outerMesh,
          innerMesh,
        );
      }
    }
  }
  return { outer: outerMesh, inner: innerMesh };
}

function flushClosureParamMeshToPositions(
  positions: number[],
  mesh: ClosureParamMesh,
): void {
  for (let t = 0; t < mesh.indices.length; t += 3) {
    const a = mesh.verts[mesh.indices[t]!]!;
    const b = mesh.verts[mesh.indices[t + 1]!]!;
    const c = mesh.verts[mesh.indices[t + 2]!]!;
    pushTriangle(positions, a, b, c);
  }
}

/**
 * Build closure tunnel wall by sampling the stadium boundary parametrically
 * and projecting onto the crown grid surface. Emitted once for the left panel;
 * covers the full loop (both panels' theta range).
 */
/**
 * Iteratively find the crown outer-surface point whose frame projection
 * matches (targetLw, targetLh). Converges in 4-6 iterations because the
 * crown surface is smooth and close to the frame plane locally.
 */
function closureBoundaryCrownPoint(
  sk: BuiltSkeleton,
  cut: ClosureCutSpec,
  targetLw: number,
  targetLh: number,
  M: number,
  N: number,
  cosY: number,
  sinY: number,
): [number, number, number] {
  const { rimAnchor, tW, tH } = cut;
  let wx = rimAnchor[0] + targetLw * tW[0] + targetLh * tH[0];
  let wy = rimAnchor[1] + targetLw * tW[1] + targetLh * tH[1];
  let wz = rimAnchor[2] + targetLw * tW[2] + targetLh * tH[2];

  let p: [number, number, number] = [wx, wy, wz];
  for (let iter = 0; iter < 8; iter++) {
    const lx = cosY * wx - sinY * wy;
    const ly = sinY * wx + cosY * wy;
    const theta = Math.atan2(ly / sk.spec.semiAxisY, lx / sk.spec.semiAxisX);
    const deltaZ = Math.max(wz, 0);
    const { panel, j } = thetaToPanelAndJFloat(theta, sk.angles, M);
    const k = findKRingForDeltaZ(sk, theta, M, N, deltaZ);
    p = panelVertexLerpJK(sk, panel, j, k, M, N);

    const actual = closureLocalWH(p, rimAnchor, tW, tH);
    const errLw = targetLw - actual.lw;
    const errLh = targetLh - actual.lh;
    if (Math.abs(errLw) < 1e-5 && Math.abs(errLh) < 1e-5) break;

    wx += errLw * tW[0] + errLh * tH[0];
    wy += errLw * tW[1] + errLh * tH[1];
    wz += errLw * tW[2] + errLh * tH[2];
  }
  return p;
}

function appendClosureTunnelWallParametric(
  positions: number[],
  sk: BuiltSkeleton,
  cut: ClosureCutSpec,
  M: number,
  N: number,
): void {
  const { rimAnchor, tW, tH, widthM, straightM } = cut;
  const halfW = widthM * 0.5;
  const R = halfW;
  const h = straightM;

  const nSide = 12;
  const nArch = 40;
  const arcPath: [number, number][] = [];

  for (let i = 7; i <= nSide; i++) {
    arcPath.push([-halfW, (i / nSide) * h]);
  }
  for (let i = 1; i <= nArch; i++) {
    const angle = Math.PI - (i / nArch) * Math.PI;
    arcPath.push([R * Math.cos(angle), h + R * Math.sin(angle)]);
  }
  for (let i = 0; i < nSide - 5; i++) {
    arcPath.push([halfW, h * (1 - i / nSide)]);
  }

  if (arcPath.length < 3) return;

  const t = CROWN_SHELL_THICKNESS_M;
  const cosY = Math.cos(-sk.spec.yawRad);
  const sinY = Math.sin(-sk.spec.yawRad);

  const outerRing: [number, number, number][] = [];
  const innerRing: [number, number, number][] = [];

  // #region agent log
  let maxErrLw = 0;
  let maxErrLh = 0;
  // #endregion

  for (const [lw, lh] of arcPath) {
    const o = closureBoundaryCrownPoint(sk, cut, lw, lh, M, N, cosY, sinY);

    // #region agent log
    const actual = closureLocalWH(o, rimAnchor, tW, tH);
    maxErrLw = Math.max(maxErrLw, Math.abs(lw - actual.lw));
    maxErrLh = Math.max(maxErrLh, Math.abs(lh - actual.lh));
    // #endregion

    const eps = 0.5;
    const lx2 = cosY * o[0] - sinY * o[1];
    const ly2 = sinY * o[0] + cosY * o[1];
    const thetaO = Math.atan2(ly2 / sk.spec.semiAxisY, lx2 / sk.spec.semiAxisX);
    const { panel: pnl, j: jO } = thetaToPanelAndJFloat(thetaO, sk.angles, M);
    const deltaZO = Math.max(o[2], 0);
    const kO = findKRingForDeltaZ(sk, thetaO, M, N, deltaZO);

    const kUp = Math.min(N, kO + eps);
    const pk = panelVertexLerpJK(sk, pnl, jO, kUp, M, N);
    const jR = Math.min(M, jO + eps);
    const pj = panelVertexLerpJK(sk, pnl, jR, kO, M, N);
    const du = sub3(pj, o);
    const dv = sub3(pk, o);
    let nm = cross3(du, dv);
    let len = Math.hypot(nm[0], nm[1], nm[2]);
    if (len < 1e-12) {
      const r = Math.hypot(o[0], o[1]);
      nm = r < 1e-12 ? [0, 0, 1] : [o[0] / r, o[1] / r, 0];
      len = 1;
    } else {
      nm = [nm[0] / len, nm[1] / len, nm[2] / len];
    }
    const radialDot = o[0] * nm[0] + o[1] * nm[1];
    if (radialDot < 0) nm = [-nm[0], -nm[1], -nm[2]];

    outerRing.push(o);
    innerRing.push([o[0] - t * nm[0], o[1] - t * nm[1], o[2] - t * nm[2]]);
  }

  // #region agent log
  agentDebugLog({
    hypothesisId: "H4_projection",
    location: "crownMesh:appendClosureTunnelWallParametric",
    message: "tunnel wall with iterative projection",
    data: {
      arcPathLen: arcPath.length,
      outerRingLen: outerRing.length,
      maxErrLw,
      maxErrLh,
    },
    runId: "gap-fix-v2",
  });
  // #endregion

  const nSeg = outerRing.length - 1;
  for (let i = 0; i < nSeg; i++) {
    const o0 = outerRing[i]!;
    const o1 = outerRing[i + 1]!;
    const i0 = innerRing[i]!;
    const i1 = innerRing[i + 1]!;
    pushTriangle(positions, o0, o1, i1);
    pushTriangle(positions, o0, i1, i0);
  }
}

/** Rim / top wall quad: a=O0, b=O1, c=I1, d=I0 — same tris as outer rim. */
function appendRimOrTopQuadRecursive(
  positions: number[],
  a: [number, number, number],
  b: [number, number, number],
  c: [number, number, number],
  d: [number, number, number],
  depth: number,
  cut: ClosureCutSpec,
): void {
  const iA = vertexInsideClosureOpening(a, cut);
  const iB = vertexInsideClosureOpening(b, cut);
  const iC = vertexInsideClosureOpening(c, cut);
  const iD = vertexInsideClosureOpening(d, cut);
  if (iA && iB && iC && iD) return;
  if (!iA && !iB && !iC && !iD) {
    pushTriangle(positions, a, d, b);
    pushTriangle(positions, b, d, c);
    return;
  }
  if (depth >= CLOSURE_SUBDIV_MAX_DEPTH) {
    const mx = midpoint3(a, c);
    const my = midpoint3(b, d);
    const center = midpoint3(mx, my);
    if (!vertexInsideClosureOpening(center, cut)) {
      pushTriangle(positions, a, d, b);
      pushTriangle(positions, b, d, c);
    }
    return;
  }
  const m0 = midpoint3(a, b);
  const m1 = midpoint3(d, c);
  const m2 = midpoint3(a, d);
  const m3 = midpoint3(b, c);
  const mc = midpoint3(m0, m1);
  appendRimOrTopQuadRecursive(positions, a, m0, mc, m2, depth + 1, cut);
  appendRimOrTopQuadRecursive(positions, m0, b, m3, mc, depth + 1, cut);
  appendRimOrTopQuadRecursive(positions, m2, mc, m1, d, depth + 1, cut);
  appendRimOrTopQuadRecursive(positions, mc, m3, c, m1, depth + 1, cut);
}

/** Top wall quad: tris (a,b,c) and (a,c,d) for a=O0, b=O1, c=I1, d=I0. */
function appendTopWallQuadRecursive(
  positions: number[],
  a: [number, number, number],
  b: [number, number, number],
  c: [number, number, number],
  d: [number, number, number],
  depth: number,
  cut: ClosureCutSpec,
): void {
  const iA = vertexInsideClosureOpening(a, cut);
  const iB = vertexInsideClosureOpening(b, cut);
  const iC = vertexInsideClosureOpening(c, cut);
  const iD = vertexInsideClosureOpening(d, cut);
  if (iA && iB && iC && iD) return;
  if (!iA && !iB && !iC && !iD) {
    pushTriangle(positions, a, b, c);
    pushTriangle(positions, a, c, d);
    return;
  }
  if (depth >= CLOSURE_SUBDIV_MAX_DEPTH) {
    const mx = midpoint3(a, c);
    const my = midpoint3(b, d);
    const center = midpoint3(mx, my);
    if (!vertexInsideClosureOpening(center, cut)) {
      pushTriangle(positions, a, b, c);
      pushTriangle(positions, a, c, d);
    }
    return;
  }
  const m0 = midpoint3(a, b);
  const m1 = midpoint3(d, c);
  const m2 = midpoint3(a, d);
  const m3 = midpoint3(b, c);
  const mc = midpoint3(m0, m1);
  appendTopWallQuadRecursive(positions, a, m0, mc, m2, depth + 1, cut);
  appendTopWallQuadRecursive(positions, m0, b, m3, mc, depth + 1, cut);
  appendTopWallQuadRecursive(positions, m2, mc, m1, d, depth + 1, cut);
  appendTopWallQuadRecursive(positions, mc, m3, c, m1, depth + 1, cut);
}

function pushInnerSurfaceQuads(
  positions: number[],
  inner: [number, number, number][][],
  M: number,
  N: number,
  collapseTop: boolean,
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
  merged.setAttribute(
    "position",
    new THREE.Float32BufferAttribute(allPositions, 3),
  );
  merged.computeVertexNormals();
  return merged;
}

/**
 * Inner fabric surface only for front rise panels (split from main crown shells for separate materials).
 */
export function buildInnerFrontRiseGeometries(
  sk: BuiltSkeleton,
): THREE.BufferGeometry[] {
  const { M, N, collapseTop } = getCrownMeshResolution(sk);
  const geos: THREE.BufferGeometry[] = [];
  for (const panel of frontRisePanelIndices(sk.spec.nSeams)) {
    const { inner } = computePanelOuterInnerGrids(sk, panel, M, N);
    const positions: number[] = [];
    pushInnerSurfaceQuads(positions, inner, M, N, collapseTop);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute(
      "position",
      new THREE.Float32BufferAttribute(positions, 3),
    );
    geo.computeVertexNormals();
    geos.push(geo);
  }
  return geos;
}

/**
 * One BufferGeometry per crown panel (outer + inner shell, rim wall, top wall).
 * Front rise panels omit the inner shell from this mesh; use {@link buildInnerFrontRiseGeometries}.
 */
export function buildCrownPanelGeometries(
  sk: BuiltSkeleton,
): THREE.BufferGeometry[] {
  const n = sk.spec.nSeams;
  const { M, N, collapseTop } = getCrownMeshResolution(sk);
  // #region agent log
  agentDebugLog({
    hypothesisId: "H_crown",
    location: "crownMesh:buildCrownPanelGeometries:entry",
    message: "crown panel build start",
    data: {
      M,
      N,
      collapseTop,
      nSeams: n,
      backClosure: sk.spec.backClosureOpening === true,
    },
    runId: "closure-crash",
  });
  // #endregion
  const frontRise = new Set(frontRisePanelIndices(sk.spec.nSeams));
  const geos: THREE.BufferGeometry[] = [];

  const useClosure = sk.spec.backClosureOpening === true;
  let closureCut: ClosureCutSpec | undefined;
  let leftPanel = -1;
  let rightPanel = -1;
  if (useClosure) {
    const frame = getBackClosureOpeningFrame(sk);
    const { widthM, straightM } = getClosureCutterDimensions();
    closureCut = {
      rimAnchor: frame.rimAnchor,
      tW: frame.tW,
      tH: frame.tH,
      widthM,
      straightM,
    };
    const adj = getRearClosureAdjacentPanelIndices(n);
    leftPanel = adj.leftPanel;
    rightPanel = adj.rightPanel;
  }

  for (let panel = 0; panel < n; panel++) {
    try {
      // #region agent log
      agentDebugLog({
        hypothesisId: "H_crown",
        location: "crownMesh:buildCrownPanelGeometries:panelStart",
        message: "panel start",
        data: { panel },
        runId: "closure-crash",
      });
      // #endregion
      const positions: number[] = [];
      const { outer, inner } = computePanelOuterInnerGrids(sk, panel, M, N);
      const cut =
        useClosure &&
        closureCut &&
        (panel === leftPanel || panel === rightPanel)
          ? closureCut
          : undefined;

      let closureShell:
        | { outer: ClosureParamMesh; inner: ClosureParamMesh }
        | undefined;
      if (cut) {
        closureShell = buildClosureShellIndexedMeshes(
          sk,
          panel,
          inner,
          M,
          N,
          collapseTop,
          cut,
        );
        // #region agent log
        agentDebugLog({
          hypothesisId: "H_crown",
          location: "crownMesh:buildCrownPanelGeometries:afterShell",
          message: "closure shell built",
          data: {
            panel,
            oIdx: closureShell.outer.indices.length,
          },
          runId: "closure-crash",
        });
        // #endregion
        flushClosureParamMeshToPositions(positions, closureShell.outer);
        if (!frontRise.has(panel)) {
          flushClosureParamMeshToPositions(positions, closureShell.inner);
        }
        // #region agent log
        agentDebugLog({
          hypothesisId: "H_crown",
          location: "crownMesh:buildCrownPanelGeometries:afterShellFlush",
          message: "after outer+inner flush",
          data: { panel, posLen: positions.length },
          runId: "closure-crash",
        });
        // #endregion
      } else {
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
      }

      if (!frontRise.has(panel) && !cut) {
        pushInnerSurfaceQuads(positions, inner, M, N, collapseTop);
      }

      if (cut) {
        for (let j = 0; j < M; j++) {
          appendRimOrTopQuadRecursive(
            positions,
            outer[j]![0]!,
            outer[j + 1]![0]!,
            inner[j + 1]![0]!,
            inner[j]![0]!,
            0,
            cut,
          );
        }
      } else {
        for (let j = 0; j < M; j++) {
          pushTriangle(
            positions,
            outer[j]![0]!,
            inner[j]![0]!,
            outer[j + 1]![0]!,
          );
          pushTriangle(
            positions,
            outer[j + 1]![0]!,
            inner[j]![0]!,
            inner[j + 1]![0]!,
          );
        }
      }

      {
        const k = collapseTop ? N - 1 : N;
        if (cut) {
          for (let j = 0; j < M; j++) {
            appendTopWallQuadRecursive(
              positions,
              outer[j]![k]!,
              outer[j + 1]![k]!,
              inner[j + 1]![k]!,
              inner[j]![k]!,
              0,
              cut,
            );
          }
        } else {
          for (let j = 0; j < M; j++) {
            pushTriangle(
              positions,
              outer[j]![k]!,
              outer[j + 1]![k]!,
              inner[j + 1]![k]!,
            );
            pushTriangle(
              positions,
              outer[j]![k]!,
              inner[j + 1]![k]!,
              inner[j]![k]!,
            );
          }
        }
      }

      if (cut && panel === leftPanel) {
        // #region agent log
        agentDebugLog({
          hypothesisId: "H_crown",
          location: "crownMesh:buildCrownPanelGeometries:beforeTunnel",
          message: "before tunnel wall",
          data: { panel, posLen: positions.length },
          runId: "closure-crash",
        });
        // #endregion
        appendClosureTunnelWallParametric(positions, sk, cut, M, N);
        // #region agent log
        agentDebugLog({
          hypothesisId: "H_crown",
          location: "crownMesh:buildCrownPanelGeometries:afterTunnel",
          message: "after tunnel wall",
          data: { panel, posLen: positions.length },
          runId: "closure-crash",
        });
        // #endregion
      }

      const geo = new THREE.BufferGeometry();
      geo.setAttribute(
        "position",
        new THREE.Float32BufferAttribute(positions, 3),
      );
      geo.computeVertexNormals();
      geos.push(geo);
      // #region agent log
      agentDebugLog({
        hypothesisId: "H_crown",
        location: "crownMesh:buildCrownPanelGeometries:panelDone",
        message: "panel done",
        data: { panel, posAttrCount: geo.getAttribute("position").count },
        runId: "closure-crash",
      });
      // #endregion
    } catch (e) {
      const err = e instanceof Error ? e : new Error(String(e));
      // #region agent log
      agentDebugLog({
        hypothesisId: "H_crown",
        location: "crownMesh:buildCrownPanelGeometries:panelCatch",
        message: "panel threw",
        data: {
          panel,
          name: err.name,
          message: err.message,
          stack: err.stack?.slice(0, 4000) ?? "",
        },
        runId: "closure-crash",
      });
      // #endregion
      throw e;
    }
  }

  return geos;
}
