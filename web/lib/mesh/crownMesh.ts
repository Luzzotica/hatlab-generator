import * as THREE from "three";
import type { HatSkeletonSpec } from "@/lib/skeleton/types";
import type { BuiltSkeleton } from "@/lib/skeleton/geometry";
import {
  closureLocalWH,
  distanceToStadiumBoundaryOutsideMm,
  getBackClosureOpeningFrame,
  getClosureCutterDimensions,
  getRearClosureAdjacentPanelIndices,
  pointInsideStadiumOpening2D,
} from "@/lib/mesh/backClosureSubtract";
import {
  LASER_MASK_INNER_SHELL_MM,
} from "@/lib/hat/laserEtchMask";
import { midpointUV } from "@/lib/hat/uvConventions";
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

/** Half a millimetre in metres — mesh-edge / radial clearance scale used across hat geometry. */
export const CROWN_MESH_HALF_MM_M = 0.0005;

/**
 * Extra weight on arc-length segments near seam columns (j≈0 and j≈M) when building panel u.
 * Pure arc-length u plus global normalization can leave isotropic textures looking vertically
 * smeared toward seams because u/v param lines are not orthogonal on the surface; this pulls
 * more u span near the seams to keep circular alpha patterns rounder.
 */
const CROWN_UV_SEAM_U_STRETCH = 0.22;

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

type UVPair = [number, number];

/** (left, right, rim, closureClearanceMm) per vertex for laser etch mask + plane. */
type LaserEdge4 = [number, number, number, number];
/** Panel plane mm: horizontal offset from panel mid (seam-to-seam), vertical from apex (meridian). */
type LaserPlane2 = [number, number];

function laserPlaneMmFromLrRim(
  lr: [number, number, number],
  meridianM: number,
): LaserPlane2 {
  const [left, right, rim] = lr;
  return [(left - right) * 0.5, meridianM * 1000 - rim];
}

const INNER_LASER_MASK4: LaserEdge4 = [
  LASER_MASK_INNER_SHELL_MM,
  LASER_MASK_INNER_SHELL_MM,
  LASER_MASK_INNER_SHELL_MM,
  LASER_MASK_INNER_SHELL_MM,
];

function edgeLen3(
  a: [number, number, number],
  b: [number, number, number],
): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

/**
 * UVs from physical arc length on the outer grid so texture scale is ~uniform on the fabric.
 * - v: cumulative length along a reference meridian jRef (panel mid), normalized by total height.
 * - u: cumulative arc length along each row k from seam j=0→M, with extra weight on segments near
 *   seam columns (see seam stretch constant above) so seam-adjacent columns get more u span, then
 *   divided by one **global**
 *   scale (max seam-to-seam length over all rows). Per-row normalization was removed: mapping each
 *   row to [0,1] u forced the same UV width for a short apex arc as for the wide rim, which
 *   horizontally compressed tiled textures toward the panel tip.
 */
function computeArcLengthUVTable(
  outer: [number, number, number][][],
  M: number,
  N: number,
): {
  u: number[][];
  v: number[];
  /** Max seam-to-seam arc length (m) before u normalization. */
  uMaxM: number;
  /** Reference meridian rim→apex arc length (m) before v normalization. */
  meridianM: number;
} {
  const jRef = Math.min(M, Math.max(0, Math.floor(M * 0.5)));
  const v: number[] = new Array(N + 1);
  v[0] = 0;
  let acc = 0;
  for (let k = 1; k <= N; k++) {
    acc += edgeLen3(outer[jRef]![k - 1]!, outer[jRef]![k]!);
    v[k] = acc;
  }
  const totalV = acc > 1e-20 ? acc : 1;
  for (let k = 0; k <= N; k++) v[k]! /= totalV;

  const u: number[][] = [];
  for (let j = 0; j <= M; j++) {
    u[j] = new Array(N + 1);
  }
  const mScale = Math.max(M, 1);
  const seamStretchSeg = (jSeg: number) =>
    1 +
    CROWN_UV_SEAM_U_STRETCH *
      Math.cos((Math.PI * (jSeg - 0.5)) / mScale) ** 2;
  for (let k = 0; k <= N; k++) {
    u[0]![k] = 0;
    acc = 0;
    for (let j = 1; j <= M; j++) {
      const baseLen = edgeLen3(outer[j - 1]![k]!, outer[j]![k]!);
      acc += baseLen * seamStretchSeg(j);
      u[j]![k] = acc;
    }
  }
  let uMax = 0;
  for (let k = 0; k <= N; k++) {
    uMax = Math.max(uMax, u[M]![k]!);
  }
  if (uMax < 1e-20) uMax = 1;
  for (let k = 0; k <= N; k++) {
    for (let j = 0; j <= M; j++) {
      u[j]![k]! /= uMax;
    }
  }
  return { u, v, uMaxM: uMax, meridianM: totalV };
}

/** Distances (mm) from left seam, right seam, and rim along the panel grid (outer shell). */
function laserEdgeDistMmAtJK(
  uTable: number[][],
  vArr: number[],
  j: number,
  k: number,
  M: number,
  uMaxM: number,
  meridianM: number,
): [number, number, number] {
  const left = uTable[j]![k]! * uMaxM * 1000;
  const right = (uTable[M]![k]! - uTable[j]![k]!) * uMaxM * 1000;
  const rim = vArr[k]! * meridianM * 1000;
  return [left, right, rim];
}

function laserEdgeDistMmBilinear(
  uTable: number[][],
  vArr: number[],
  jf: number,
  kf: number,
  M: number,
  N: number,
  uMaxM: number,
  meridianM: number,
): [number, number, number] {
  const j0 = Math.max(0, Math.min(M, Math.floor(jf)));
  const j1 = Math.max(0, Math.min(M, Math.ceil(jf)));
  const k0 = Math.max(0, Math.min(N, Math.floor(kf)));
  const k1 = Math.max(0, Math.min(N, Math.ceil(kf)));
  const ja = jf - j0;
  const ka = kf - k0;
  const l00 = laserEdgeDistMmAtJK(uTable, vArr, j0, k0, M, uMaxM, meridianM);
  const l10 = laserEdgeDistMmAtJK(uTable, vArr, j1, k0, M, uMaxM, meridianM);
  const l01 = laserEdgeDistMmAtJK(uTable, vArr, j0, k1, M, uMaxM, meridianM);
  const l11 = laserEdgeDistMmAtJK(uTable, vArr, j1, k1, M, uMaxM, meridianM);
  const blend = (
    a: [number, number, number],
    b: [number, number, number],
    c: [number, number, number],
    d: [number, number, number],
  ): [number, number, number] => [
    (1 - ka) * ((1 - ja) * a[0] + ja * b[0]) + ka * ((1 - ja) * c[0] + ja * d[0]),
    (1 - ka) * ((1 - ja) * a[1] + ja * b[1]) + ka * ((1 - ja) * c[1] + ja * d[1]),
    (1 - ka) * ((1 - ja) * a[2] + ja * b[2]) + ka * ((1 - ja) * c[2] + ja * d[2]),
  ];
  return blend(l00, l10, l01, l11);
}

/** Bilinear u(j,k) and linear v(k) for fractional mesh coordinates (closure subdiv). */
function uvFromParametricJK(
  uTable: number[][],
  vArr: number[],
  jf: number,
  kf: number,
  M: number,
  N: number,
): UVPair {
  const j0 = Math.max(0, Math.min(M, Math.floor(jf)));
  const j1 = Math.max(0, Math.min(M, Math.ceil(jf)));
  const k0 = Math.max(0, Math.min(N, Math.floor(kf)));
  const k1 = Math.max(0, Math.min(N, Math.ceil(kf)));
  const ja = jf - j0;
  const ka = kf - k0;
  const u00 = uTable[j0]![k0]!;
  const u10 = uTable[j1]![k0]!;
  const u01 = uTable[j0]![k1]!;
  const u11 = uTable[j1]![k1]!;
  const uCoord =
    (1 - ka) * ((1 - ja) * u00 + ja * u10) + ka * ((1 - ja) * u01 + ja * u11);
  const vCoord = (1 - ka) * vArr[k0]! + ka * vArr[k1]!;
  return [uCoord, vCoord];
}

function pushTriangleWithUV(
  positions: number[],
  uvs: number[],
  laserMm: number[] | null,
  laserPlaneMm: number[] | null,
  a: [number, number, number],
  b: [number, number, number],
  c: [number, number, number],
  ua: UVPair,
  ub: UVPair,
  uc: UVPair,
  la?: LaserEdge4,
  lb?: LaserEdge4,
  lc?: LaserEdge4,
  pa?: LaserPlane2,
  pb?: LaserPlane2,
  pc?: LaserPlane2,
): void {
  positions.push(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2]);
  uvs.push(ua[0], ua[1], ub[0], ub[1], uc[0], uc[1]);
  if (laserMm !== null && la !== undefined && lb !== undefined && lc !== undefined) {
    laserMm.push(
      la[0],
      la[1],
      la[2],
      la[3],
      lb[0],
      lb[1],
      lb[2],
      lb[3],
      lc[0],
      lc[1],
      lc[2],
      lc[3],
    );
  }
  if (laserPlaneMm !== null && pa !== undefined && pb !== undefined && pc !== undefined) {
    laserPlaneMm.push(pa[0], pa[1], pb[0], pb[1], pc[0], pc[1]);
  }
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
  const curv = sk.spec.visor.visorCurvatureM ?? 0;
  if (curv <= 1e-15) return p;
  const theta = panelVertexThetaForLift(sk, panel, jArc, M);
  const bell = visorFrontBellAtTheta(sk, theta);
  if (bell <= 1e-15) return p;
  const u = kRing / N;
  /** Strongest at the rim (u→0) so the bottom follows the visor; fades to 0 at the apex (no top lift). */
  const fade = (1 - u) * (1 - u);
  const dz = curv * bell * fade;
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

/** Stadium opening in (lw,lh) projected onto the crown; same for tunnel mesh and chord hardware. */
export type BackClosureCutSpec = {
  rimAnchor: [number, number, number];
  tW: [number, number, number];
  tH: [number, number, number];
  widthM: number;
  straightM: number;
};

/** Same stadium cut as the crown closure tunnel. */
export function buildBackClosureCutSpec(sk: BuiltSkeleton): BackClosureCutSpec {
  const frame = getBackClosureOpeningFrame(sk);
  const { widthM, straightM } = getClosureCutterDimensions();
  return {
    rimAnchor: frame.rimAnchor,
    tW: frame.tW,
    tH: frame.tH,
    widthM,
    straightM,
  };
}

function laserClosureEdgeMmForVertex(
  p: readonly [number, number, number],
  cut: BackClosureCutSpec | undefined,
  isClosurePanel: boolean,
): number {
  if (!cut || !isClosurePanel) return LASER_MASK_INNER_SHELL_MM;
  const { lw, lh } = closureLocalWH(p, cut.rimAnchor, cut.tW, cut.tH);
  if (pointInsideStadiumOpening2D(lw, lh, cut.widthM, cut.straightM)) {
    return 0;
  }
  return distanceToStadiumBoundaryOutsideMm(lw, lh, cut.widthM, cut.straightM);
}

function laserEdgeWithClosureW(
  base: [number, number, number],
  p: [number, number, number],
  cut: BackClosureCutSpec | undefined,
  isClosurePanel: boolean,
): LaserEdge4 {
  const w = laserClosureEdgeMmForVertex(p, cut, isClosurePanel);
  return [base[0], base[1], base[2], w];
}

const CLOSURE_SUBDIV_MAX_DEPTH = 4;

function vertexInsideClosureOpening(
  p: readonly [number, number, number],
  cut: BackClosureCutSpec,
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
  cut: BackClosureCutSpec,
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
  cut: BackClosureCutSpec,
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
  cut: BackClosureCutSpec,
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
  uvs: number[],
  laserMm: number[] | null,
  laserPlaneMm: number[] | null,
  mesh: ClosureParamMesh,
  M: number,
  N: number,
  uTable: number[][],
  vArr: number[],
  uMaxM: number,
  meridianM: number,
  cut: BackClosureCutSpec | undefined,
  isClosurePanel: boolean,
): void {
  for (let t = 0; t < mesh.indices.length; t += 3) {
    const ia = mesh.indices[t]!;
    const ib = mesh.indices[t + 1]!;
    const ic = mesh.indices[t + 2]!;
    const a = mesh.verts[ia]!;
    const b = mesh.verts[ib]!;
    const c = mesh.verts[ic]!;
    const ua = uvFromParametricJK(uTable, vArr, mesh.jf[ia]!, mesh.kf[ia]!, M, N);
    const ub = uvFromParametricJK(uTable, vArr, mesh.jf[ib]!, mesh.kf[ib]!, M, N);
    const uc = uvFromParametricJK(uTable, vArr, mesh.jf[ic]!, mesh.kf[ic]!, M, N);
    if (laserMm !== null && laserPlaneMm !== null) {
      const la3 = laserEdgeDistMmBilinear(
        uTable,
        vArr,
        mesh.jf[ia]!,
        mesh.kf[ia]!,
        M,
        N,
        uMaxM,
        meridianM,
      );
      const lb3 = laserEdgeDistMmBilinear(
        uTable,
        vArr,
        mesh.jf[ib]!,
        mesh.kf[ib]!,
        M,
        N,
        uMaxM,
        meridianM,
      );
      const lc3 = laserEdgeDistMmBilinear(
        uTable,
        vArr,
        mesh.jf[ic]!,
        mesh.kf[ic]!,
        M,
        N,
        uMaxM,
        meridianM,
      );
      const ea = laserEdgeWithClosureW(la3, a, cut, isClosurePanel);
      const eb = laserEdgeWithClosureW(lb3, b, cut, isClosurePanel);
      const ec = laserEdgeWithClosureW(lc3, c, cut, isClosurePanel);
      const pa = laserPlaneMmFromLrRim(la3, meridianM);
      const pb = laserPlaneMmFromLrRim(lb3, meridianM);
      const pc = laserPlaneMmFromLrRim(lc3, meridianM);
      pushTriangleWithUV(
        positions,
        uvs,
        laserMm,
        laserPlaneMm,
        a,
        b,
        c,
        ua,
        ub,
        uc,
        ea,
        eb,
        ec,
        pa,
        pb,
        pc,
      );
    } else {
      pushTriangleWithUV(positions, uvs, null, null, a, b, c, ua, ub, uc);
    }
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
  cut: BackClosureCutSpec,
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

/**
 * Point on the crown outer surface whose opening-plane projection matches (lw, lh).
 * Same projection as the closure tunnel wall; use for chord endpoints on the actual hat.
 */
export function closureProjectToCrownOpening(
  sk: BuiltSkeleton,
  cut: BackClosureCutSpec,
  lw: number,
  lh: number,
): [number, number, number] {
  const M = crownArcSegments(sk.spec);
  const N = crownVerticalRings(sk.spec);
  const cosY = Math.cos(-sk.spec.yawRad);
  const sinY = Math.sin(-sk.spec.yawRad);
  return closureBoundaryCrownPoint(sk, cut, lw, lh, M, N, cosY, sinY);
}

function appendClosureTunnelWallParametric(
  positions: number[],
  uvs: number[],
  laserMm: number[] | null,
  laserPlaneMm: number[] | null,
  sk: BuiltSkeleton,
  cut: BackClosureCutSpec,
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

  for (const [lw, lh] of arcPath) {
    const o = closureBoundaryCrownPoint(sk, cut, lw, lh, M, N, cosY, sinY);

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

  const nSeg = outerRing.length - 1;
  for (let i = 0; i < nSeg; i++) {
    const o0 = outerRing[i]!;
    const o1 = outerRing[i + 1]!;
    const i0 = innerRing[i]!;
    const i1 = innerRing[i + 1]!;
    const u0 = i / nSeg;
    const u1 = (i + 1) / nSeg;
    const vO: UVPair = [u0, 0];
    const vO1: UVPair = [u1, 0];
    const vI: UVPair = [u0, 1];
    const vI1: UVPair = [u1, 1];
    const zPlane: LaserPlane2 = [0, 0];
    if (laserMm !== null && laserPlaneMm !== null) {
      pushTriangleWithUV(
        positions,
        uvs,
        laserMm,
        laserPlaneMm,
        o0,
        o1,
        i1,
        vO,
        vO1,
        vI1,
        INNER_LASER_MASK4,
        INNER_LASER_MASK4,
        INNER_LASER_MASK4,
        zPlane,
        zPlane,
        zPlane,
      );
      pushTriangleWithUV(
        positions,
        uvs,
        laserMm,
        laserPlaneMm,
        o0,
        i1,
        i0,
        vO,
        vI1,
        vI,
        INNER_LASER_MASK4,
        INNER_LASER_MASK4,
        INNER_LASER_MASK4,
        zPlane,
        zPlane,
        zPlane,
      );
    } else {
      pushTriangleWithUV(positions, uvs, null, null, o0, o1, i1, vO, vO1, vI1);
      pushTriangleWithUV(positions, uvs, null, null, o0, i1, i0, vO, vI1, vI);
    }
  }
}

/** Rim / top wall quad: a=O0, b=O1, c=I1, d=I0 — same tris as outer rim. */
function appendRimOrTopQuadRecursive(
  positions: number[],
  uvs: number[],
  a: [number, number, number],
  b: [number, number, number],
  c: [number, number, number],
  d: [number, number, number],
  ua: UVPair,
  ub: UVPair,
  uc: UVPair,
  ud: UVPair,
  depth: number,
  cut: BackClosureCutSpec,
): void {
  const iA = vertexInsideClosureOpening(a, cut);
  const iB = vertexInsideClosureOpening(b, cut);
  const iC = vertexInsideClosureOpening(c, cut);
  const iD = vertexInsideClosureOpening(d, cut);
  if (iA && iB && iC && iD) return;
  if (!iA && !iB && !iC && !iD) {
    pushTriangleWithUV(positions, uvs, null, null, a, d, b, ua, ud, ub);
    pushTriangleWithUV(positions, uvs, null, null, b, d, c, ub, ud, uc);
    return;
  }
  if (depth >= CLOSURE_SUBDIV_MAX_DEPTH) {
    const mx = midpoint3(a, c);
    const my = midpoint3(b, d);
    const center = midpoint3(mx, my);
    if (!vertexInsideClosureOpening(center, cut)) {
      pushTriangleWithUV(positions, uvs, null, null, a, d, b, ua, ud, ub);
      pushTriangleWithUV(positions, uvs, null, null, b, d, c, ub, ud, uc);
    }
    return;
  }
  const m0 = midpoint3(a, b);
  const m1 = midpoint3(d, c);
  const m2 = midpoint3(a, d);
  const m3 = midpoint3(b, c);
  const mc = midpoint3(m0, m1);
  const um0 = midpointUV(ua, ub);
  const um1 = midpointUV(ud, uc);
  const um2 = midpointUV(ua, ud);
  const um3 = midpointUV(ub, uc);
  const umc = midpointUV(um0, um1);
  appendRimOrTopQuadRecursive(
    positions,
    uvs,
    a,
    m0,
    mc,
    m2,
    ua,
    um0,
    umc,
    um2,
    depth + 1,
    cut,
  );
  appendRimOrTopQuadRecursive(
    positions,
    uvs,
    m0,
    b,
    m3,
    mc,
    um0,
    ub,
    um3,
    umc,
    depth + 1,
    cut,
  );
  appendRimOrTopQuadRecursive(
    positions,
    uvs,
    m2,
    mc,
    m1,
    d,
    um2,
    umc,
    um1,
    ud,
    depth + 1,
    cut,
  );
  appendRimOrTopQuadRecursive(
    positions,
    uvs,
    mc,
    m3,
    c,
    m1,
    umc,
    um3,
    uc,
    um1,
    depth + 1,
    cut,
  );
}

/** Top wall quad: tris (a,b,c) and (a,c,d) for a=O0, b=O1, c=I1, d=I0. */
function appendTopWallQuadRecursive(
  positions: number[],
  uvs: number[],
  a: [number, number, number],
  b: [number, number, number],
  c: [number, number, number],
  d: [number, number, number],
  ua: UVPair,
  ub: UVPair,
  uc: UVPair,
  ud: UVPair,
  depth: number,
  cut: BackClosureCutSpec,
): void {
  const iA = vertexInsideClosureOpening(a, cut);
  const iB = vertexInsideClosureOpening(b, cut);
  const iC = vertexInsideClosureOpening(c, cut);
  const iD = vertexInsideClosureOpening(d, cut);
  if (iA && iB && iC && iD) return;
  if (!iA && !iB && !iC && !iD) {
    pushTriangleWithUV(positions, uvs, null, null, a, b, c, ua, ub, uc);
    pushTriangleWithUV(positions, uvs, null, null, a, c, d, ua, uc, ud);
    return;
  }
  if (depth >= CLOSURE_SUBDIV_MAX_DEPTH) {
    const mx = midpoint3(a, c);
    const my = midpoint3(b, d);
    const center = midpoint3(mx, my);
    if (!vertexInsideClosureOpening(center, cut)) {
      pushTriangleWithUV(positions, uvs, null, null, a, b, c, ua, ub, uc);
      pushTriangleWithUV(positions, uvs, null, null, a, c, d, ua, uc, ud);
    }
    return;
  }
  const m0 = midpoint3(a, b);
  const m1 = midpoint3(d, c);
  const m2 = midpoint3(a, d);
  const m3 = midpoint3(b, c);
  const mc = midpoint3(m0, m1);
  const um0 = midpointUV(ua, ub);
  const um1 = midpointUV(ud, uc);
  const um2 = midpointUV(ua, ud);
  const um3 = midpointUV(ub, uc);
  const umc = midpointUV(um0, um1);
  appendTopWallQuadRecursive(
    positions,
    uvs,
    a,
    m0,
    mc,
    m2,
    ua,
    um0,
    umc,
    um2,
    depth + 1,
    cut,
  );
  appendTopWallQuadRecursive(
    positions,
    uvs,
    m0,
    b,
    m3,
    mc,
    um0,
    ub,
    um3,
    umc,
    depth + 1,
    cut,
  );
  appendTopWallQuadRecursive(
    positions,
    uvs,
    m2,
    mc,
    m1,
    d,
    um2,
    umc,
    um1,
    ud,
    depth + 1,
    cut,
  );
  appendTopWallQuadRecursive(
    positions,
    uvs,
    mc,
    m3,
    c,
    m1,
    umc,
    um3,
    uc,
    um1,
    depth + 1,
    cut,
  );
}

/** Rim strip (k=0) and top strip connecting outer and inner shells; omitted for split `"outer"` / `"inner"` panels unless added via {@link buildCrownPanelBridgeGeometries}. */
function pushCrownPanelRimAndTopWalls(
  positions: number[],
  uvs: number[],
  outer: [number, number, number][][],
  inner: [number, number, number][][],
  M: number,
  N: number,
  collapseTop: boolean,
  uTable: number[][],
  vArr: number[],
  cut: BackClosureCutSpec | undefined,
): void {
  if (cut) {
    for (let j = 0; j < M; j++) {
      appendRimOrTopQuadRecursive(
        positions,
        uvs,
        outer[j]![0]!,
        outer[j + 1]![0]!,
        inner[j + 1]![0]!,
        inner[j]![0]!,
        [uTable[j]![0]!, 0],
        [uTable[j + 1]![0]!, 0],
        [uTable[j + 1]![0]!, 1],
        [uTable[j]![0]!, 1],
        0,
        cut,
      );
    }
  } else {
    for (let j = 0; j < M; j++) {
      const ua: UVPair = [uTable[j]![0]!, 0];
      const ub: UVPair = [uTable[j]![0]!, 1];
      const uc: UVPair = [uTable[j + 1]![0]!, 0];
      const ud: UVPair = [uTable[j + 1]![0]!, 1];
      pushTriangleWithUV(
        positions,
        uvs,
        null,
        null,
        outer[j]![0]!,
        inner[j]![0]!,
        outer[j + 1]![0]!,
        ua,
        ub,
        uc,
      );
      pushTriangleWithUV(
        positions,
        uvs,
        null,
        null,
        outer[j + 1]![0]!,
        inner[j]![0]!,
        inner[j + 1]![0]!,
        uc,
        ub,
        ud,
      );
    }
  }

  {
    const kTop = collapseTop ? N - 1 : N;
    if (cut) {
      for (let j = 0; j < M; j++) {
        appendTopWallQuadRecursive(
          positions,
          uvs,
          outer[j]![kTop]!,
          outer[j + 1]![kTop]!,
          inner[j + 1]![kTop]!,
          inner[j]![kTop]!,
          [uTable[j]![kTop]!, 0],
          [uTable[j + 1]![kTop]!, 0],
          [uTable[j + 1]![kTop]!, 1],
          [uTable[j]![kTop]!, 1],
          0,
          cut,
        );
      }
    } else {
      for (let j = 0; j < M; j++) {
        const ua: UVPair = [uTable[j]![kTop]!, 0];
        const ub: UVPair = [uTable[j + 1]![kTop]!, 0];
        const uc: UVPair = [uTable[j + 1]![kTop]!, 1];
        const ud: UVPair = [uTable[j]![kTop]!, 1];
        pushTriangleWithUV(
          positions,
          uvs,
          null,
          null,
          outer[j]![kTop]!,
          outer[j + 1]![kTop]!,
          inner[j + 1]![kTop]!,
          ua,
          ub,
          uc,
        );
        pushTriangleWithUV(
          positions,
          uvs,
          null,
          null,
          outer[j]![kTop]!,
          inner[j + 1]![kTop]!,
          inner[j]![kTop]!,
          ua,
          uc,
          ud,
        );
      }
    }
  }
}

function pushInnerSurfaceQuads(
  positions: number[],
  uvs: number[],
  laserMm: number[] | null,
  laserPlaneMm: number[] | null,
  inner: [number, number, number][][],
  M: number,
  N: number,
  collapseTop: boolean,
  uTable: number[][],
  vArr: number[],
  uMaxM: number,
  meridianM: number,
): void {
  for (let k = 0; k < N; k++) {
    const lastStrip = k === N - 1;
    for (let j = 0; j < M; j++) {
      const i00 = inner[j]![k]!;
      const i10 = inner[j + 1]![k]!;
      const i01 = inner[j]![k + 1]!;
      const i11 = inner[j + 1]![k + 1]!;
      const u00: UVPair = [uTable[j]![k]!, vArr[k]!];
      const u10: UVPair = [uTable[j + 1]![k]!, vArr[k]!];
      const u01: UVPair = [uTable[j]![k + 1]!, vArr[k + 1]!];
      const u11: UVPair = [uTable[j + 1]![k + 1]!, vArr[k + 1]!];
      const l00 = laserEdgeDistMmAtJK(uTable, vArr, j, k, M, uMaxM, meridianM);
      const l10 = laserEdgeDistMmAtJK(uTable, vArr, j + 1, k, M, uMaxM, meridianM);
      const l01 = laserEdgeDistMmAtJK(uTable, vArr, j, k + 1, M, uMaxM, meridianM);
      const l11 = laserEdgeDistMmAtJK(
        uTable,
        vArr,
        j + 1,
        k + 1,
        M,
        uMaxM,
        meridianM,
      );
      const p00 = laserPlaneMmFromLrRim(l00, meridianM);
      const p10 = laserPlaneMmFromLrRim(l10, meridianM);
      const p01 = laserPlaneMmFromLrRim(l01, meridianM);
      const p11 = laserPlaneMmFromLrRim(l11, meridianM);
      if (!lastStrip || !collapseTop) {
        if (laserMm !== null && laserPlaneMm !== null) {
          pushTriangleWithUV(
            positions,
            uvs,
            laserMm,
            laserPlaneMm,
            i00,
            i01,
            i10,
            u00,
            u01,
            u10,
            INNER_LASER_MASK4,
            INNER_LASER_MASK4,
            INNER_LASER_MASK4,
            p00,
            p01,
            p10,
          );
          pushTriangleWithUV(
            positions,
            uvs,
            laserMm,
            laserPlaneMm,
            i10,
            i01,
            i11,
            u10,
            u01,
            u11,
            INNER_LASER_MASK4,
            INNER_LASER_MASK4,
            INNER_LASER_MASK4,
            p10,
            p01,
            p11,
          );
        } else {
          pushTriangleWithUV(positions, uvs, null, null, i00, i01, i10, u00, u01, u10);
          pushTriangleWithUV(positions, uvs, null, null, i10, i01, i11, u10, u01, u11);
        }
      } else if (laserMm !== null && laserPlaneMm !== null) {
        pushTriangleWithUV(
          positions,
          uvs,
          laserMm,
          laserPlaneMm,
          i00,
          i01,
          i10,
          u00,
          u01,
          u10,
          INNER_LASER_MASK4,
          INNER_LASER_MASK4,
          INNER_LASER_MASK4,
          p00,
          p01,
          p10,
        );
      } else {
        pushTriangleWithUV(positions, uvs, null, null, i00, i01, i10, u00, u01, u10);
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
  const allUvs: number[] = [];
  for (const g of geos) {
    const attr = g.getAttribute("position") as THREE.BufferAttribute;
    for (let i = 0; i < attr.count * 3; i++) allPositions.push(attr.array[i]!);
    const uvAttr = g.getAttribute("uv") as THREE.BufferAttribute | null;
    if (uvAttr) {
      for (let i = 0; i < uvAttr.count * 2; i++) allUvs.push(uvAttr.array[i]!);
    }
    g.dispose();
  }
  for (const g of innerFront) {
    const attr = g.getAttribute("position") as THREE.BufferAttribute;
    for (let i = 0; i < attr.count * 3; i++) allPositions.push(attr.array[i]!);
    const uvAttr = g.getAttribute("uv") as THREE.BufferAttribute | null;
    if (uvAttr) {
      for (let i = 0; i < uvAttr.count * 2; i++) allUvs.push(uvAttr.array[i]!);
    }
    g.dispose();
  }
  merged.setAttribute(
    "position",
    new THREE.Float32BufferAttribute(allPositions, 3),
  );
  if (allUvs.length === (allPositions.length / 3) * 2) {
    merged.setAttribute("uv", new THREE.Float32BufferAttribute(allUvs, 2));
  }
  merged.computeVertexNormals();
  return merged;
}

/**
 * Combine adjacent front-rise panel grids (6-panel: panels 0 and 1) so the shared seam is one
 * meridian column — one connected inner surface for export.
 */
function combineFrontRisePanelGrids(
  outer0: [number, number, number][][],
  inner0: [number, number, number][][],
  outer1: [number, number, number][][],
  inner1: [number, number, number][][],
  M: number,
): {
  outer: [number, number, number][][];
  inner: [number, number, number][][];
  MCombined: number;
} {
  const MCombined = 2 * M;
  const outer: [number, number, number][][] = new Array(MCombined + 1);
  const inner: [number, number, number][][] = new Array(MCombined + 1);
  for (let j = 0; j <= M; j++) {
    outer[j] = outer0[j]!;
    inner[j] = inner0[j]!;
  }
  for (let j = 1; j <= M; j++) {
    outer[M + j] = outer1[j]!;
    inner[M + j] = inner1[j]!;
  }
  return { outer, inner, MCombined };
}

/**
 * Isotropic TEXCOORD_0 for inner front rise: same meters per UV unit in u and v so a square
 * texture maps without anisotropic stretch (domain may be a sub-rectangle of [0,1]²).
 */
function applyIsotropicUvToInnerFrontRise(
  uvs: number[],
  uMaxM: number,
  meridianM: number,
): void {
  const L = Math.max(uMaxM, meridianM);
  if (L < 1e-20) return;
  const su = uMaxM / L;
  const sv = meridianM / L;
  for (let i = 0; i < uvs.length; i += 2) {
    uvs[i]! *= su;
    uvs[i + 1]! *= sv;
  }
}

/**
 * Inner fabric surface only for front rise panels (split from main crown shells for separate materials).
 * Six-panel hats use one combined grid across both front-rise panels (single mesh, one UV island);
 * five-panel uses a single panel as before.
 */
export function buildInnerFrontRiseGeometries(
  sk: BuiltSkeleton,
): THREE.BufferGeometry[] {
  const { M, N, collapseTop } = getCrownMeshResolution(sk);
  const geos: THREE.BufferGeometry[] = [];

  if (sk.spec.nSeams === 6) {
    const { outer: o0, inner: i0 } = computePanelOuterInnerGrids(sk, 0, M, N);
    const { outer: o1, inner: i1 } = computePanelOuterInnerGrids(sk, 1, M, N);
    const { outer, inner, MCombined } = combineFrontRisePanelGrids(
      o0,
      i0,
      o1,
      i1,
      M,
    );
    const { u: uTable, v: vArr, uMaxM, meridianM } = computeArcLengthUVTable(
      outer,
      MCombined,
      N,
    );
    const positions: number[] = [];
    const uvs: number[] = [];
    const laserMm: number[] = [];
    const laserPlaneMm: number[] = [];
    pushInnerSurfaceQuads(
      positions,
      uvs,
      laserMm,
      laserPlaneMm,
      inner,
      MCombined,
      N,
      collapseTop,
      uTable,
      vArr,
      uMaxM,
      meridianM,
    );
    applyIsotropicUvToInnerFrontRise(uvs, uMaxM, meridianM);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute(
      "position",
      new THREE.Float32BufferAttribute(positions, 3),
    );
    geo.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
    if (laserPlaneMm.length > 0) {
      geo.setAttribute(
        "laserPlaneMm",
        new THREE.Float32BufferAttribute(laserPlaneMm, 2),
      );
    }
    geo.computeVertexNormals();
    geos.push(geo);
    return geos;
  }

  for (const panel of frontRisePanelIndices(sk.spec.nSeams)) {
    const { outer, inner } = computePanelOuterInnerGrids(sk, panel, M, N);
    const { u: uTable, v: vArr, uMaxM, meridianM } = computeArcLengthUVTable(
      outer,
      M,
      N,
    );
    const positions: number[] = [];
    const uvs: number[] = [];
    const laserMm: number[] = [];
    const laserPlaneMm: number[] = [];
    pushInnerSurfaceQuads(
      positions,
      uvs,
      laserMm,
      laserPlaneMm,
      inner,
      M,
      N,
      collapseTop,
      uTable,
      vArr,
      uMaxM,
      meridianM,
    );
    applyIsotropicUvToInnerFrontRise(uvs, uMaxM, meridianM);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute(
      "position",
      new THREE.Float32BufferAttribute(positions, 3),
    );
    geo.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
    if (laserPlaneMm.length > 0) {
      geo.setAttribute(
        "laserPlaneMm",
        new THREE.Float32BufferAttribute(laserPlaneMm, 2),
      );
    }
    geo.computeVertexNormals();
    geos.push(geo);
  }
  return geos;
}

/**
 * Which part of the crown shell to emit. `full` = legacy single mesh (outer + inner + rim + top).
 * `outer` / `inner` split the fabric into separate meshes for export (decals on outside only).
 */
export type CrownPanelGeometryShell = "full" | "outer" | "inner";

/**
 * One BufferGeometry per crown panel (outer + inner shell, rim wall, top wall).
 * Front rise panels omit the inner shell from this mesh; use {@link buildInnerFrontRiseGeometries}.
 *
 * For {@link CrownPanelGeometryShell} `"outer"` / `"inner"`, rim and top bridging strips are
 * omitted so each mesh uses only exterior or interior shell triangles (no shared bridging verts).
 * Use {@link buildCrownPanelBridgeGeometries} alongside split shells to close the rim and apex edge.
 */
export function buildCrownPanelGeometries(
  sk: BuiltSkeleton,
  shell: CrownPanelGeometryShell = "full",
): THREE.BufferGeometry[] {
  const n = sk.spec.nSeams;
  const { M, N, collapseTop } = getCrownMeshResolution(sk);
  const frontRise = new Set(frontRisePanelIndices(sk.spec.nSeams));
  const geos: THREE.BufferGeometry[] = [];

  const isFull = shell === "full";
  const wantOuter = shell === "outer" || isFull;
  const wantInner = shell === "inner" || isFull;
  /** Laser edge-distance attribute only for split outer/inner shells (not legacy `full` mesh). */
  const useLaserAttr = !isFull;

  const useClosure = sk.spec.backClosureOpening === true;
  let closureCut: BackClosureCutSpec | undefined;
  let leftPanel = -1;
  let rightPanel = -1;
  if (useClosure) {
    closureCut = buildBackClosureCutSpec(sk);
    const adj = getRearClosureAdjacentPanelIndices(n);
    leftPanel = adj.leftPanel;
    rightPanel = adj.rightPanel;
  }

  for (let panel = 0; panel < n; panel++) {
    const positions: number[] = [];
    const uvs: number[] = [];
    const laserMm: number[] = [];
    const laserPlaneMm: number[] = [];
    const { outer, inner } = computePanelOuterInnerGrids(sk, panel, M, N);
    const { u: uTable, v: vArr, uMaxM, meridianM } = computeArcLengthUVTable(
      outer,
      M,
      N,
    );
    const cut =
      useClosure && closureCut && (panel === leftPanel || panel === rightPanel)
        ? closureCut
        : undefined;
    const isClosurePanel =
      useClosure && !!closureCut && (panel === leftPanel || panel === rightPanel);

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
      if (wantOuter) {
        flushClosureParamMeshToPositions(
          positions,
          uvs,
          useLaserAttr ? laserMm : null,
          useLaserAttr ? laserPlaneMm : null,
          closureShell.outer,
          M,
          N,
          uTable,
          vArr,
          uMaxM,
          meridianM,
          cut,
          isClosurePanel,
        );
      }
      if (wantInner && !frontRise.has(panel)) {
        flushClosureParamMeshToPositions(
          positions,
          uvs,
          useLaserAttr ? laserMm : null,
          useLaserAttr ? laserPlaneMm : null,
          closureShell.inner,
          M,
          N,
          uTable,
          vArr,
          uMaxM,
          meridianM,
          cut,
          isClosurePanel,
        );
      }
    } else if (wantOuter) {
      for (let k = 0; k < N; k++) {
        const lastStrip = k === N - 1;
        for (let j = 0; j < M; j++) {
          const v00 = outer[j]![k]!;
          const v10 = outer[j + 1]![k]!;
          const v01 = outer[j]![k + 1]!;
          const v11 = outer[j + 1]![k + 1]!;
          const u00: UVPair = [uTable[j]![k]!, vArr[k]!];
          const u10: UVPair = [uTable[j + 1]![k]!, vArr[k]!];
          const u01: UVPair = [uTable[j]![k + 1]!, vArr[k + 1]!];
          const u11: UVPair = [uTable[j + 1]![k + 1]!, vArr[k + 1]!];
          const l00 = laserEdgeDistMmAtJK(uTable, vArr, j, k, M, uMaxM, meridianM);
          const l10 = laserEdgeDistMmAtJK(
            uTable,
            vArr,
            j + 1,
            k,
            M,
            uMaxM,
            meridianM,
          );
          const l01 = laserEdgeDistMmAtJK(
            uTable,
            vArr,
            j,
            k + 1,
            M,
            uMaxM,
            meridianM,
          );
          const l11 = laserEdgeDistMmAtJK(
            uTable,
            vArr,
            j + 1,
            k + 1,
            M,
            uMaxM,
            meridianM,
          );
          const e00 = laserEdgeWithClosureW(l00, v00, cut, isClosurePanel);
          const e10 = laserEdgeWithClosureW(l10, v10, cut, isClosurePanel);
          const e01 = laserEdgeWithClosureW(l01, v01, cut, isClosurePanel);
          const e11 = laserEdgeWithClosureW(l11, v11, cut, isClosurePanel);
          const p00 = laserPlaneMmFromLrRim(l00, meridianM);
          const p10 = laserPlaneMmFromLrRim(l10, meridianM);
          const p01 = laserPlaneMmFromLrRim(l01, meridianM);
          const p11 = laserPlaneMmFromLrRim(l11, meridianM);
          const lm = useLaserAttr ? laserMm : null;
          const lp = useLaserAttr ? laserPlaneMm : null;
          if (!lastStrip || !collapseTop) {
            pushTriangleWithUV(
              positions,
              uvs,
              lm,
              lp,
              v00,
              v10,
              v01,
              u00,
              u10,
              u01,
              e00,
              e10,
              e01,
              p00,
              p10,
              p01,
            );
            pushTriangleWithUV(
              positions,
              uvs,
              lm,
              lp,
              v10,
              v11,
              v01,
              u10,
              u11,
              u01,
              e10,
              e11,
              e01,
              p10,
              p11,
              p01,
            );
          } else {
            pushTriangleWithUV(
              positions,
              uvs,
              lm,
              lp,
              v00,
              v10,
              v01,
              u00,
              u10,
              u01,
              e00,
              e10,
              e01,
              p00,
              p10,
              p01,
            );
          }
        }
      }
    }

    if (wantInner && !frontRise.has(panel) && !cut) {
      pushInnerSurfaceQuads(
        positions,
        uvs,
        useLaserAttr ? laserMm : null,
        useLaserAttr ? laserPlaneMm : null,
        inner,
        M,
        N,
        collapseTop,
        uTable,
        vArr,
        uMaxM,
        meridianM,
      );
    }

    if (isFull) {
      pushCrownPanelRimAndTopWalls(
        positions,
        uvs,
        outer,
        inner,
        M,
        N,
        collapseTop,
        uTable,
        vArr,
        cut,
      );
    }

    if (wantOuter && cut && panel === leftPanel) {
      appendClosureTunnelWallParametric(
        positions,
        uvs,
        useLaserAttr ? laserMm : null,
        useLaserAttr ? laserPlaneMm : null,
        sk,
        cut,
        M,
        N,
      );
    }

    if (isFull && positions.length > 0) {
      const nv = positions.length / 3;
      for (let i = 0; i < nv; i++) {
        laserMm.push(
          LASER_MASK_INNER_SHELL_MM,
          LASER_MASK_INNER_SHELL_MM,
          LASER_MASK_INNER_SHELL_MM,
          LASER_MASK_INNER_SHELL_MM,
        );
        laserPlaneMm.push(0, 0);
      }
    }

    const geo = new THREE.BufferGeometry();
    if (positions.length === 0) {
      geo.setAttribute("position", new THREE.Float32BufferAttribute([], 3));
    } else {
      geo.setAttribute(
        "position",
        new THREE.Float32BufferAttribute(positions, 3),
      );
      geo.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
      if (laserMm.length > 0) {
        geo.setAttribute(
          "laserEdgeDistMm",
          new THREE.Float32BufferAttribute(laserMm, 4),
        );
      }
      if (laserPlaneMm.length > 0) {
        geo.setAttribute(
          "laserPlaneMm",
          new THREE.Float32BufferAttribute(laserPlaneMm, 2),
        );
      }
      geo.computeVertexNormals();
    }
    geos.push(geo);
  }

  return geos;
}

/**
 * Rim strip (bottom) and top strip that connect outer and inner crown shells. Intended for use with
 * {@link buildCrownPanelGeometries} `"outer"` / `"inner"`, which omit these faces for decal export.
 */
export function buildCrownPanelBridgeGeometries(
  sk: BuiltSkeleton,
): THREE.BufferGeometry[] {
  const n = sk.spec.nSeams;
  const { M, N, collapseTop } = getCrownMeshResolution(sk);
  const geos: THREE.BufferGeometry[] = [];

  const useClosure = sk.spec.backClosureOpening === true;
  let closureCut: BackClosureCutSpec | undefined;
  let leftPanel = -1;
  let rightPanel = -1;
  if (useClosure) {
    closureCut = buildBackClosureCutSpec(sk);
    const adj = getRearClosureAdjacentPanelIndices(n);
    leftPanel = adj.leftPanel;
    rightPanel = adj.rightPanel;
  }

  for (let panel = 0; panel < n; panel++) {
    const positions: number[] = [];
    const uvs: number[] = [];
    const { outer, inner } = computePanelOuterInnerGrids(sk, panel, M, N);
    const { u: uTable, v: vArr } = computeArcLengthUVTable(outer, M, N);
    const cut =
      useClosure && closureCut && (panel === leftPanel || panel === rightPanel)
        ? closureCut
        : undefined;

    pushCrownPanelRimAndTopWalls(
      positions,
      uvs,
      outer,
      inner,
      M,
      N,
      collapseTop,
      uTable,
      vArr,
      cut,
    );

    const geo = new THREE.BufferGeometry();
    if (positions.length === 0) {
      geo.setAttribute("position", new THREE.Float32BufferAttribute([], 3));
    } else {
      geo.setAttribute(
        "position",
        new THREE.Float32BufferAttribute(positions, 3),
      );
      geo.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
      geo.computeVertexNormals();
    }
    geos.push(geo);
  }

  return geos;
}
