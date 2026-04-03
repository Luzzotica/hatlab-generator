import * as THREE from "three";
import {
  frontCenterSeamIndex,
  rearCenterSeamIndex,
  sweatbandPoint,
  sweatbandPolyline,
  effectiveVisorHalfSpanRad,
  sampleVisorSuperellipsePolyline,
  type BuiltSkeleton,
} from "@/lib/skeleton/geometry";
import type { HatSkeletonSpec } from "@/lib/skeleton/types";
import {
  BACK_CLOSURE_STRAIGHT_EDGE_M,
  BACK_CLOSURE_TAPE_MARGIN_M,
  BACK_CLOSURE_WIDTH_M,
  getBackClosureOpeningFrame,
} from "@/lib/mesh/backClosureSubtract";
import {
  crownArcSegments,
  crownMeridianPointAtK,
  crownVerticalRings,
  findKRingForDeltaZ,
  sampleSeamWireframeToWithGroove,
} from "@/lib/mesh/crownMesh";
import {
  rimWorldXYToSweatbandTheta,
  sweatbandFrontArcStartAndSpan,
  SWEATBAND_HEIGHT_M,
  SWEATBAND_OUTER_INSET_M,
  SWEATBAND_THICKNESS_M,
} from "@/lib/mesh/sweatbandMesh";
import { VISOR_THICKNESS_M } from "@/lib/mesh/visorMesh";
import { SEAM_TAPE_WIDTH_M } from "@/lib/hat/seamTapeMesh";
import {
  type Vec3,
  norm3,
  cross3,
  dot3,
  lerp3,
  outwardCrownNormalApprox,
  sampleOpenArchPath,
  segmentPolylineExcludingStadium,
  dashedRibbonGeometry,
  cumulativeArcLengths,
  interpolatePolylineAtArcLength,
} from "@/lib/hat/curveUtils";

/** Thread ribbon half-width (visual thickness of one stitch line). */
const THREAD_HALF_WIDTH_M = 0.0002;

/** Stitch dash length. */
const THREAD_DASH_M = 0.002;

/** Gap between stitches. */
const THREAD_GAP_M = 0.0015;

/** Small outward push from the crown surface to prevent z-fighting. */
const THREAD_CROWN_OFFSET_M = 0.0003;

/** Lateral offset from seam centerline for left/right stitch rows. */
const THREAD_SEAM_LATERAL_M = 0.002;

/** How far up the seam to run threading (up to the button). */
const THREAD_SEAM_U_MAX = 0.97;

/** Number of segments when sampling seam curves for threading. */
const THREAD_SEAM_SEGMENTS = 60;

/** Z offset above/below visor surfaces. */
const VISOR_THREAD_Z_OFFSET_M = 0.00015;

/**
 * Visor threading uses the same superellipse math as {@link visorOuterPolyline}:
 * - **Width (lanes):** homothety — each row scales `a` and `b` by `scale_k`.
 *   Outermost row uses {@link VISOR_THREAD_SCALE_OUTER}; each inner row steps down by
 *   {@link VISOR_THREAD_LANE_STEP}.
 * - **Length:** every row uses the full chord parameter range `s in [-1, 1]` so all threads
 *   complete the same loop along the visor; only the scale differs between rows.
 * - Points inside the hat's rim ellipse (projected vertically) are dropped so threads
 *   stop at the hat base.
 */
/** Homothety scale for the outermost thread row (slightly inset from true visor edge). */
const VISOR_THREAD_SCALE_OUTER = 0.97;
/** Scale step between adjacent rows (smaller = tighter lane spacing). */
const VISOR_THREAD_LANE_STEP = 0.05;
/** Number of thread rows across the visor. */
const VISOR_NUM_ROWS = 6;

/** Height fractions for sweatband threading rows (bottom, middle, top). */
const SWEATBAND_ROW_FRACTIONS = [0.08, 0.50, 0.92];

const SWEATBAND_THREAD_SEGMENTS = 96;

/** Base threading: vertical offset above z=0. */
const BASE_THREAD_Z_OFFSET_M = 0.001;

function crownNormalFn(spec: HatSkeletonSpec) {
  return (p: Vec3) => outwardCrownNormalApprox(p, spec);
}

const UP: Vec3 = [0, 0, 1];
const DOWN: Vec3 = [0, 0, -1];
function flatUpNormal(): Vec3 {
  return UP;
}
function flatDownNormal(): Vec3 {
  return DOWN;
}

/**
 * Offset a crown surface point outward along the ellipsoidal normal.
 */
function offsetCrownOutward(
  p: Vec3,
  spec: HatSkeletonSpec,
  dist: number,
): Vec3 {
  const n = outwardCrownNormalApprox(p, spec);
  return [
    p[0] + n[0] * dist,
    p[1] + n[1] * dist,
    p[2] + n[2] * dist,
  ];
}

/**
 * Sample a seam curve on the crown exterior (outward offset instead of inward).
 */
function seamPointsOutward(
  sk: BuiltSkeleton,
  seamIdx: number,
  segments: number,
  uMax: number,
): Vec3[] {
  return sampleSeamWireframeToWithGroove(sk, seamIdx, segments, uMax).map((p) =>
    offsetCrownOutward(p as Vec3, sk.spec, THREAD_CROWN_OFFSET_M),
  );
}

/**
 * Offset a polyline laterally on the crown surface.
 * First computes a consistent unit lateral direction at every point
 * (tangent x surface normal, with sign continuity), then shifts each
 * point by lateralDist along that direction.
 */
function offsetPolylineLateral(
  points: Vec3[],
  spec: HatSkeletonSpec,
  lateralDist: number,
): Vec3[] {
  const n = points.length;
  if (n < 2) return points;

  const laterals: Vec3[] = [];
  for (let i = 0; i < n; i++) {
    const p = points[i]!;
    let tangent: Vec3;
    if (i === 0) {
      tangent = norm3([
        points[1]![0] - p[0],
        points[1]![1] - p[1],
        points[1]![2] - p[2],
      ]);
    } else if (i === n - 1) {
      tangent = norm3([
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
      tangent = norm3([t0[0] + t1[0], t0[1] + t1[1], t0[2] + t1[2]]);
    }

    const normal = outwardCrownNormalApprox(p, spec);
    let lateral = cross3(tangent, normal);
    let len = Math.hypot(lateral[0], lateral[1], lateral[2]);
    if (len < 1e-10) {
      lateral = cross3(tangent, UP);
      len = Math.hypot(lateral[0], lateral[1], lateral[2]);
    }
    if (len < 1e-10) {
      lateral = [1, 0, 0];
    } else {
      lateral = [lateral[0] / len, lateral[1] / len, lateral[2] / len];
    }

    if (i > 0 && dot3(lateral, laterals[i - 1]!) < 0) {
      lateral = [-lateral[0], -lateral[1], -lateral[2]];
    }

    laterals.push(lateral);
  }

  return points.map((p, i) => {
    const l = laterals[i]!;
    return [
      p[0] + l[0] * lateralDist,
      p[1] + l[1] * lateralDist,
      p[2] + l[2] * lateralDist,
    ];
  });
}

// ---------------------------------------------------------------------------
// 1. Seam threading
// ---------------------------------------------------------------------------

function buildSeamThreading(
  sk: BuiltSkeleton,
  mat: THREE.Material,
  group: THREE.Group,
): void {
  const nSeams = sk.spec.nSeams;
  const nFn = crownNormalFn(sk.spec);
  const frontIdx = frontCenterSeamIndex(nSeams);
  const fivePanelPartial = sk.spec.fivePanelCenterSeamLength < 1;

  for (let i = 0; i < nSeams; i++) {
    let centerline = seamPointsOutward(sk, i, THREAD_SEAM_SEGMENTS, THREAD_SEAM_U_MAX);
    if (centerline.length < 2) continue;

    if (fivePanelPartial && i === frontIdx) {
      const cutoff = 1 - sk.spec.fivePanelCenterSeamLength;
      const firstIdx = Math.ceil(
        (cutoff / THREAD_SEAM_U_MAX) * THREAD_SEAM_SEGMENTS,
      );
      centerline = centerline.slice(firstIdx);
      if (centerline.length < 2) continue;
    }

    let segments: Vec3[][] = [centerline];

    if (sk.spec.backClosureOpening) {
      const rearIdx = rearCenterSeamIndex(nSeams);
      if (i === rearIdx) {
        const frame = getBackClosureOpeningFrame(sk);
        const clipW =
          BACK_CLOSURE_WIDTH_M + BACK_CLOSURE_TAPE_MARGIN_M + SEAM_TAPE_WIDTH_M;
        const clipS = BACK_CLOSURE_STRAIGHT_EDGE_M + BACK_CLOSURE_TAPE_MARGIN_M;
        segments = segmentPolylineExcludingStadium(
          centerline,
          frame.rimAnchor,
          frame.tW,
          frame.tH,
          clipW,
          clipS,
        );
      }
    }

    const skipRight = fivePanelPartial && i === frontIdx;

    for (const seg of segments) {
      const left = offsetPolylineLateral(seg, sk.spec, THREAD_SEAM_LATERAL_M);

      const geoL = dashedRibbonGeometry(left, THREAD_HALF_WIDTH_M, nFn, THREAD_DASH_M, THREAD_GAP_M);
      if (geoL.getAttribute("position")) {
        const meshL = new THREE.Mesh(geoL, mat);
        meshL.name = `Thread_Seam${i}_L`;
        group.add(meshL);
      }

      if (!skipRight) {
        const right = offsetPolylineLateral(seg, sk.spec, -THREAD_SEAM_LATERAL_M);
        const geoR = dashedRibbonGeometry(right, THREAD_HALF_WIDTH_M, nFn, THREAD_DASH_M, THREAD_GAP_M);
        if (geoR.getAttribute("position")) {
          const meshR = new THREE.Mesh(geoR, mat);
          meshR.name = `Thread_Seam${i}_R`;
          group.add(meshR);
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// 2. Base threading
// ---------------------------------------------------------------------------

function buildBaseThreading(
  sk: BuiltSkeleton,
  mat: THREE.Material,
  group: THREE.Group,
): void {
  const spec = sk.spec;
  const nFn = crownNormalFn(spec);

  let points: Vec3[];
  if (spec.backClosureOpening) {
    const frame = getBackClosureOpeningFrame(sk);
    const halfW = (BACK_CLOSURE_WIDTH_M + BACK_CLOSURE_TAPE_MARGIN_M) * 0.5 + 0.01;
    const tW = frame.tW;
    const rimAnchor = frame.rimAnchor;
    const left: Vec3 = [
      rimAnchor[0] - halfW * tW[0],
      rimAnchor[1] - halfW * tW[1],
      rimAnchor[2] - halfW * tW[2],
    ];
    const right: Vec3 = [
      rimAnchor[0] + halfW * tW[0],
      rimAnchor[1] + halfW * tW[1],
      rimAnchor[2] + halfW * tW[2],
    ];
    const thetaL = rimWorldXYToSweatbandTheta(spec, left[0], left[1]);
    const thetaR = rimWorldXYToSweatbandTheta(spec, right[0], right[1]);
    const { start, span } = sweatbandFrontArcStartAndSpan(thetaL, thetaR);

    const nSeg = 96;
    points = [];
    for (let i = 0; i <= nSeg; i++) {
      const theta = start + (i / nSeg) * span;
      const p = sweatbandPoint(theta, spec.semiAxisX, spec.semiAxisY, spec.yawRad);
      points.push([p[0], p[1], p[2] + BASE_THREAD_Z_OFFSET_M]);
    }
  } else {
    const rimPts = sweatbandPolyline(spec, 96);
    points = rimPts.map((p) => [p[0], p[1], p[2] + BASE_THREAD_Z_OFFSET_M] as Vec3);
    points.push(points[0]!);
  }

  const geo = dashedRibbonGeometry(points, THREAD_HALF_WIDTH_M, nFn, THREAD_DASH_M, THREAD_GAP_M);
  if (geo.getAttribute("position")) {
    const mesh = new THREE.Mesh(geo, mat);
    mesh.name = "Thread_Base";
    group.add(mesh);
  }
}

// ---------------------------------------------------------------------------
// 3. Visor threading
// ---------------------------------------------------------------------------

/**
 * Trim the beginning of a polyline by `trimLen` arc-length.
 * Returns a new polyline that starts `trimLen` along the original curve.
 */
function trimPolylineStart(points: Vec3[], trimLen: number): Vec3[] {
  if (points.length < 2 || trimLen <= 0) return points;
  const arcLens = cumulativeArcLengths(points);
  const totalLen = arcLens[arcLens.length - 1]!;
  if (trimLen >= totalLen) return [];

  const startPt = interpolatePolylineAtArcLength(points, arcLens, trimLen);
  const result: Vec3[] = [startPt];

  for (let i = 1; i < points.length; i++) {
    if (arcLens[i]! > trimLen) {
      result.push(points[i]!);
    }
  }
  return result;
}

/**
 * Test whether an XY point is outside (or on) the hat's rim ellipse.
 * After un-rotating by yawRad, checks `(x'/semiAxisX)^2 + (y'/semiAxisY)^2 >= 1`.
 */
function isOutsideRimEllipse(
  px: number,
  py: number,
  semiAxisX: number,
  semiAxisY: number,
  yawRad: number,
): boolean {
  const cosY = Math.cos(-yawRad);
  const sinY = Math.sin(-yawRad);
  const xr = px * cosY - py * sinY;
  const yr = px * sinY + py * cosY;
  return (xr / semiAxisX) ** 2 + (yr / semiAxisY) ** 2 >= 1.0;
}

/**
 * Clip a visor thread polyline to only the points that are outside the rim
 * ellipse (on the bill side). Interpolates a point exactly on the rim boundary
 * at each transition so threads end cleanly at the hat base.
 */
function clipPolylineToOutsideRim(
  pts: [number, number, number][],
  semiAxisX: number,
  semiAxisY: number,
  yawRad: number,
): [number, number, number][] {
  if (pts.length < 2) return pts;

  const cosY = Math.cos(-yawRad);
  const sinY = Math.sin(-yawRad);

  function ellipseVal(px: number, py: number): number {
    const xr = px * cosY - py * sinY;
    const yr = px * sinY + py * cosY;
    return (xr / semiAxisX) ** 2 + (yr / semiAxisY) ** 2;
  }

  const vals = pts.map((p) => ellipseVal(p[0], p[1]));

  function rimCrossing(
    a: [number, number, number],
    b: [number, number, number],
    va: number,
    vb: number,
  ): [number, number, number] {
    const t = (1 - va) / (vb - va);
    return [
      a[0] + (b[0] - a[0]) * t,
      a[1] + (b[1] - a[1]) * t,
      a[2] + (b[2] - a[2]) * t,
    ];
  }

  const out: [number, number, number][] = [];

  for (let i = 0; i < pts.length; i++) {
    const outside = vals[i]! >= 1.0;
    if (i > 0) {
      const prevOutside = vals[i - 1]! >= 1.0;
      if (outside !== prevOutside) {
        out.push(rimCrossing(pts[i - 1]!, pts[i]!, vals[i - 1]!, vals[i]!));
      }
    }
    if (outside) {
      out.push(pts[i]!);
    }
  }

  return out;
}

function buildVisorThreading(
  sk: BuiltSkeleton,
  mat: THREE.Material,
  group: THREE.Group,
): void {
  if (sk.visorPolyline.length < 2) return;

  const spec = sk.spec;
  const v = spec.visor;
  const halfSpan = effectiveVisorHalfSpanRad(v, spec.nSeams, sk.angles);
  const visorSpec = { ...v, halfSpanRad: halfSpan };
  const m = sk.visorPolyline.length;

  const topZ = VISOR_THICKNESS_M + VISOR_THREAD_Z_OFFSET_M;
  const botZ = -VISOR_THREAD_Z_OFFSET_M;

  const threadPeriod = THREAD_DASH_M + THREAD_GAP_M;
  const staggerTrim = threadPeriod * 0.5;

  const nRows = VISOR_NUM_ROWS;

  for (let row = 0; row < nRows; row++) {
    const scaleK = Math.max(
      0.08,
      VISOR_THREAD_SCALE_OUTER - (nRows - 1 - row) * VISOR_THREAD_LANE_STEP,
    );

    const rawPts = sampleVisorSuperellipsePolyline(
      spec.semiAxisX,
      spec.semiAxisY,
      spec.yawRad,
      visorSpec,
      {
        aScale: scaleK,
        bScale: scaleK,
        sMin: -1,
        sMax: 1,
        samples: m,
      },
    );

    const clipped = clipPolylineToOutsideRim(
      rawPts,
      spec.semiAxisX,
      spec.semiAxisY,
      spec.yawRad,
    );

    if (clipped.length < 2) continue;

    const isOddRow = row % 2 === 1;

    let topRow = clipped.map((p) => [p[0], p[1], topZ] as Vec3);
    let botRow = clipped.map((p) => [p[0], p[1], botZ] as Vec3);

    if (isOddRow) {
      topRow = trimPolylineStart(topRow, staggerTrim);
      botRow = trimPolylineStart(botRow, staggerTrim);
    }

    const geoTop = dashedRibbonGeometry(topRow, THREAD_HALF_WIDTH_M, flatUpNormal, THREAD_DASH_M, THREAD_GAP_M);
    if (geoTop.getAttribute("position")) {
      const meshTop = new THREE.Mesh(geoTop, mat);
      meshTop.name = `Thread_Visor_Top_${row}`;
      group.add(meshTop);
    }

    const geoBot = dashedRibbonGeometry(botRow, THREAD_HALF_WIDTH_M, flatDownNormal, THREAD_DASH_M, THREAD_GAP_M);
    if (geoBot.getAttribute("position")) {
      const meshBot = new THREE.Mesh(geoBot, mat);
      meshBot.name = `Thread_Visor_Bot_${row}`;
      group.add(meshBot);
    }
  }
}

// ---------------------------------------------------------------------------
// 4. Arch closure threading
// ---------------------------------------------------------------------------

function buildArchThreading(
  sk: BuiltSkeleton,
  mat: THREE.Material,
  group: THREE.Group,
): void {
  if (!sk.spec.backClosureOpening) return;

  const { tW, tH, rimAnchor } = getBackClosureOpeningFrame(sk);
  const outerW = BACK_CLOSURE_WIDTH_M + BACK_CLOSURE_TAPE_MARGIN_M;
  const outerS = BACK_CLOSURE_STRAIGHT_EDGE_M + BACK_CLOSURE_TAPE_MARGIN_M;

  const d = SEAM_TAPE_WIDTH_M * 1.2;
  const archHalfW = outerW * 0.5 + d;
  const archRise = outerW * 0.5 + SEAM_TAPE_WIDTH_M * 0.5;
  const archStraight = outerS;

  const archPts2D = sampleOpenArchPath(archHalfW, archStraight, 56, archRise);

  const M = crownArcSegments(sk.spec);
  const N = crownVerticalRings(sk.spec);

  function projectToCrownOutside(lx: number, ly: number): Vec3 {
    const wx = rimAnchor[0] + lx * tW[0] + ly * tH[0];
    const wy = rimAnchor[1] + lx * tW[1] + ly * tH[1];
    const wz = rimAnchor[2] + lx * tW[2] + ly * tH[2];
    const theta = rimWorldXYToSweatbandTheta(sk.spec, wx, wy);
    const deltaZ = Math.max(wz, 0);
    const k = findKRingForDeltaZ(sk, theta, M, N, deltaZ);
    const cp = crownMeridianPointAtK(sk, theta, k, M, N);
    return offsetCrownOutward(cp as Vec3, sk.spec, THREAD_CROWN_OFFSET_M);
  }

  const centerline = archPts2D.map(([lx, ly]) => projectToCrownOutside(lx, ly));

  const clampedCenterline = centerline.map(
    (p) => (p[2] < 0 ? [p[0], p[1], 0] as Vec3 : p),
  );

  const nFn = crownNormalFn(sk.spec);
  const geo = dashedRibbonGeometry(clampedCenterline, THREAD_HALF_WIDTH_M, nFn, THREAD_DASH_M, THREAD_GAP_M);
  if (geo.getAttribute("position")) {
    const mesh = new THREE.Mesh(geo, mat);
    mesh.name = "Thread_Arch";
    group.add(mesh);
  }
}

// ---------------------------------------------------------------------------
// 5. Sweatband threading
// ---------------------------------------------------------------------------

function buildSweatbandThreading(
  sk: BuiltSkeleton,
  mat: THREE.Material,
  group: THREE.Group,
): void {
  const spec = sk.spec;
  const M = crownArcSegments(spec);
  const N = crownVerticalRings(spec);
  const inset = SWEATBAND_OUTER_INSET_M;
  const thickness = SWEATBAND_THICKNESS_M;
  const closure = spec.backClosureOpening === true;

  let thetas: number[];
  let openArc = false;
  const nSeg = SWEATBAND_THREAD_SEGMENTS;

  if (closure) {
    const { tW, rimAnchor } = getBackClosureOpeningFrame(sk);
    const halfW = (BACK_CLOSURE_WIDTH_M + BACK_CLOSURE_TAPE_MARGIN_M) * 0.5 + 0.01;
    const left: Vec3 = [
      rimAnchor[0] - halfW * tW[0],
      rimAnchor[1] - halfW * tW[1],
      rimAnchor[2] - halfW * tW[2],
    ];
    const right: Vec3 = [
      rimAnchor[0] + halfW * tW[0],
      rimAnchor[1] + halfW * tW[1],
      rimAnchor[2] + halfW * tW[2],
    ];
    const thetaL = rimWorldXYToSweatbandTheta(spec, left[0], left[1]);
    const thetaR = rimWorldXYToSweatbandTheta(spec, right[0], right[1]);
    const { start, span } = sweatbandFrontArcStartAndSpan(thetaL, thetaR);
    if (span < 0.15) {
      thetas = Array.from({ length: nSeg }, (_, i) => (i / nSeg) * 2 * Math.PI);
    } else {
      thetas = Array.from({ length: nSeg }, (_, i) =>
        start + (i / (nSeg - 1)) * span,
      );
      openArc = true;
    }
  } else {
    thetas = Array.from({ length: nSeg }, (_, i) => (i / nSeg) * 2 * Math.PI);
  }

  for (let row = 0; row < SWEATBAND_ROW_FRACTIONS.length; row++) {
    const hFrac = SWEATBAND_ROW_FRACTIONS[row]!;
    const dz = SWEATBAND_HEIGHT_M * hFrac;

    const rowPoints: Vec3[] = [];
    for (const theta of thetas) {
      const kFloat = findKRingForDeltaZ(sk, theta, M, N, Math.max(dz, 1e-10));
      const cp = crownMeridianPointAtK(sk, theta, kFloat, M, N);
      const rho = Math.hypot(cp[0], cp[1]);
      if (rho < 1e-12) {
        rowPoints.push(cp as Vec3);
        continue;
      }
      const s = (inset - thickness * 0.5) / rho;
      rowPoints.push([cp[0] - cp[0] * s, cp[1] - cp[1] * s, cp[2]]);
    }

    if (!openArc && rowPoints.length > 1) {
      rowPoints.push(rowPoints[0]!);
    }

    const nFn = crownNormalFn(spec);
    const geo = dashedRibbonGeometry(rowPoints, THREAD_HALF_WIDTH_M, nFn, THREAD_DASH_M, THREAD_GAP_M);
    if (geo.getAttribute("position")) {
      const mesh = new THREE.Mesh(geo, mat);
      mesh.name = `Thread_Sweatband_${row}`;
      group.add(mesh);
    }
  }
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

export function buildThreadingGroup(sk: BuiltSkeleton): THREE.Group {
  const group = new THREE.Group();
  group.name = "Threading";
  group.renderOrder = 4;

  const mat = new THREE.MeshStandardMaterial({
    color: 0xeeeeee,
    flatShading: true,
    side: THREE.DoubleSide,
    metalness: 0.02,
    roughness: 0.95,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
    depthWrite: true,
  });

  buildSeamThreading(sk, mat, group);
  buildBaseThreading(sk, mat, group);
  buildVisorThreading(sk, mat, group);
  buildArchThreading(sk, mat, group);
  buildSweatbandThreading(sk, mat, group);

  return group;
}
