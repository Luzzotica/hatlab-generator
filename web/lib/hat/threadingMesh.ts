import * as THREE from "three";
import {
  effectiveVisorHalfSpanRad,
  frontCenterSeamIndex,
  frontRisePanelIndices,
  rearCenterSeamIndex,
  sampleVisorSuperellipsePolyline,
  sweatbandPoint,
  visorFrontBellAtTheta,
  type BuiltSkeleton,
} from "@/lib/skeleton/geometry";
import type { HatSkeletonSpec, PanelCount } from "@/lib/skeleton/types";
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
  outerSurfacePoint,
  offsetInwardXY,
  rimWorldXYToSweatbandTheta,
  sweatbandFrontArcStartAndSpan,
  SWEATBAND_HEIGHT_M,
  SWEATBAND_OUTER_INSET_M,
} from "@/lib/mesh/sweatbandMesh";
import {
  evalVisorRuledNormalWorld,
  evalVisorRuledPointWorld,
  evalVisorRuledTopWorld,
  getVisorRuledBasis,
} from "@/lib/mesh/visorMesh";
import {
  type VisorThreadingGeometries,
  VisorMeshRayHelper,
} from "@/lib/hat/visorThreadProjection";

export type { VisorThreadingGeometries } from "@/lib/hat/visorThreadProjection";
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

/** Outward push from the crown surface to clear the depth buffer at close zoom.
 * 0.3 mm was too tight — crown shell is 2 mm thick and the depth buffer can't
 * distinguish 0.3 mm at small camera distances. 1.2 mm gives a comfortable margin
 * without making stitches visibly float off the surface. */
const THREAD_CROWN_OFFSET_M = 0.0006;

/**
 * Extra outward offset (m) only on the two front-panel **edge** seam rows (left seam → L row,
 * right seam → R row) when the visor lifts the rim — reduces z-fight with the visor shell.
 * Scaled by {@link visorFrontBellAtTheta} and strongest near the rim.
 */
/** Extra clearance on front edge seam L/R rows when visor lifts the rim (see applyFrontEdgeVisorThreadClearance). */
const THREAD_FRONT_EDGE_VISOR_CLEAR_M = 0.005;

/** Lateral offset from seam centerline for left/right stitch rows. */
const THREAD_SEAM_LATERAL_M = 0.002;

/** How far up the seam to run threading (up to the button). */
const THREAD_SEAM_U_MAX = 0.97;

/** Number of segments when sampling seam curves for threading. */
const THREAD_SEAM_SEGMENTS = 60;

/**
 * Rear snapback opening: stadium used to split seam threading so it does not stitch through the hole.
 * Midway between seam-tape size and the tighter size (half the previous extension toward the opening).
 */
const REAR_CLOSURE_THREAD_STADIUM_W_M =
  BACK_CLOSURE_WIDTH_M +
  BACK_CLOSURE_TAPE_MARGIN_M +
  0.5 * SEAM_TAPE_WIDTH_M;
const REAR_CLOSURE_THREAD_STADIUM_S_M =
  BACK_CLOSURE_STRAIGHT_EDGE_M + BACK_CLOSURE_TAPE_MARGIN_M * 0.5;

/**
 * Offset visor stitch centerlines from the slab along the ruled surface normal (m).
 * 0.3 mm clears depth fighting at close zoom without visible float.
 */
const VISOR_THREAD_SURFACE_OFFSET_M = 0.0003;

/**
 * Visor threading: homothetic superellipse planform in XY, then Z from the real visor mesh.
 * When {@link VisorThreadingGeometries} are passed (viewer/export), each planform (px, py) is
 * projected onto the bottom/top slab with vertical rays bounded by each mesh AABB (see
 * {@link VisorMeshRayHelper}). Otherwise falls back to ruled-surface Z + normals.
 * Forward bulge: `bScale = k × {@link VISOR_THREAD_FORWARD_B_SCALE} × chordWidthNorm × planformDepthScale`
 * where `chordWidthNorm = halfWidthRow / halfWidthFull` (metres on the rim, see
 * {@link visorChordHalfWidthMeters}) so depth scales with **chord width**, not only `projection`.
 * Rim arc spacing between rows is **fixed** in metres
 * ({@link VISOR_THREAD_OUTER_EDGE_INSET_M}, {@link VISOR_THREAD_ROW_SPACING_RIM_M}) — independent of
 * visor projection or overall brim size. Forward depth is scaled by {@link visorThreadPlanformDepthScale}
 * so `b` tracks the **built** visor rim→outer span vs `spec.projection` (not just the spec value).
 * {@link VisorSpec.visorThreadingScale} multiplies forward depth for viewer tuning.
 */
/** Homothety scale for the outermost thread row (slightly &lt; 1 to stay inside the bill edge). */
const VISOR_THREAD_HOMOTHETY_MAX = 0.97;
/** Homothety scale for the innermost thread row (`aScale` and part of `bScale` via `k`). */
const VISOR_THREAD_HOMOTHETY_MIN = 0.8;
/** Number of homothetic thread rows across the visor (outer → inner). */
const VISOR_THREAD_NUM_ROWS = 4;

/**
 * Multiplier on `spec.projection` for the superellipse **outward** (bill) axis in
 * {@link sampleVisorSuperellipsePolyline} (after `k` and chord-width ratio). The full visor uses `1`;
 * Kept conservative so default threads fit inside typical visor length; use {@link VisorSpec.visorThreadingScale} to extend.
 */
const VISOR_THREAD_FORWARD_B_SCALE = 0.66;
/** Samples along the planform superellipse per row (before rim clip). */
const VISOR_THREAD_PLANFORM_SAMPLES = 128;

/**
 * Chord parameter span for {@link sampleVisorSuperellipsePolyline}: full `|s| = 1` on every row.
 * Lateral row spacing is {@link visorThreadHalfSpanRadForRow} + homothety `k`.
 */
const VISOR_THREAD_CHORD_S_ABS_MAX = 1;

/**
 * Sweatband rim inset from the full visor tip to the **outer** thread row (m), along the rim arc
 * on each side — fixed world distance regardless of `projection` or visor span (≈2.8 cm default).
 */
const VISOR_THREAD_OUTER_EDGE_INSET_M = 0.02;
/**
 * Rim arc spacing between consecutive thread rows (m) at the advancing left tip — fixed in world
 * units so row spacing does not grow when the bill gets deeper or wider (≈1.6 cm default).
 */
const VISOR_THREAD_ROW_SPACING_RIM_M = 0.01;

/** Height fractions for sweatband threading rows (bottom, middle, top). */
const SWEATBAND_ROW_FRACTIONS = [0.08, 0.5, 0.92];

const SWEATBAND_THREAD_SEGMENTS = 96;

/** Base threading: vertical offset above z=0 (bill rope uses the same rim stack). */
export const BASE_THREAD_Z_OFFSET_M = 0.003;

/** Crown sweatband rim ring, same as {@link buildBaseThreading} (includes visor front lift in Z). */
export function crownRimPointForBaseThreading(
  sk: BuiltSkeleton,
  thetaRad: number,
): Vec3 {
  const M = crownArcSegments(sk.spec);
  const N = crownVerticalRings(sk.spec);
  const p = crownMeridianPointAtK(sk, thetaRad, 0, M, N);
  return [p[0], p[1], p[2] + BASE_THREAD_Z_OFFSET_M];
}

/**
 * Small radial inward from the sweatband outer surface (toward the hat axis) so stitches
 * sit in front of the band in the depth buffer when viewed from inside the cavity.
 */
const THREAD_SWEATBAND_DEPTH_BIAS_INWARD_M = 0.00045;

/** Half-width for sweatband thread ribbons. Larger than other threads so stitches read on the band. */
const SWEATBAND_THREAD_HALF_WIDTH_M = 0.00135;

/** Slightly longer dashes / gaps than global thread so the band pattern is easier to see. */
const SWEATBAND_THREAD_DASH_M = 0.0028;
const SWEATBAND_THREAD_GAP_M = 0.0018;

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
  return [p[0] + n[0] * dist, p[1] + n[1] * dist, p[2] + n[2] * dist];
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
 * Left/right seam indices bounding the visor-facing front panels (6-panel: 0 and 2; 5-panel: 0 and 1).
 */
function frontPanelEdgeSeamIndices(nSeams: number): { left: number; right: number } {
  const fp = frontRisePanelIndices(nSeams as PanelCount);
  const leftSeam = fp[0]!;
  const lastFrontPanel = fp[fp.length - 1]!;
  const rightSeam = (lastFrontPanel + 1) % nSeams;
  return { left: leftSeam, right: rightSeam };
}

/**
 * Push a seam ribbon polyline slightly further outward when the front rim is lifted toward the visor.
 * Only intended for {@link frontPanelEdgeSeamIndices} L/R rows.
 */
function applyFrontEdgeVisorThreadClearance(
  sk: BuiltSkeleton,
  points: Vec3[],
  seamIdx: number,
): Vec3[] {
  const curv = sk.spec.visor.visorCurvatureM ?? 0;
  if (curv <= 1e-15 || points.length < 2) return points;
  const bell = visorFrontBellAtTheta(sk, sk.angles[seamIdx]!);
  if (bell <= 1e-15) return points;
  const n = points.length;
  const denom = Math.max(1, n - 1);
  const gain = Math.min(curv / 0.03, 1.5);
  return points.map((p, i) => {
    const s = i / denom;
    const u = s * THREAD_SEAM_U_MAX;
    const rimFade = (1 - u / THREAD_SEAM_U_MAX) ** 2;
    const extra =
      THREAD_FRONT_EDGE_VISOR_CLEAR_M * bell * rimFade * gain;
    const nrm = outwardCrownNormalApprox(p, sk.spec);
    return [
      p[0] + nrm[0] * extra,
      p[1] + nrm[1] * extra,
      p[2] + nrm[2] * extra,
    ];
  });
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
  const edgeSeams = frontPanelEdgeSeamIndices(nSeams);

  for (let i = 0; i < nSeams; i++) {
    let centerline = seamPointsOutward(
      sk,
      i,
      THREAD_SEAM_SEGMENTS,
      THREAD_SEAM_U_MAX,
    );
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
        segments = segmentPolylineExcludingStadium(
          centerline,
          frame.rimAnchor,
          frame.tW,
          frame.tH,
          REAR_CLOSURE_THREAD_STADIUM_W_M,
          REAR_CLOSURE_THREAD_STADIUM_S_M,
        );
      }
    }

    const skipRight = fivePanelPartial && i === frontIdx;

    for (const seg of segments) {
      let left = offsetPolylineLateral(seg, sk.spec, THREAD_SEAM_LATERAL_M);
      if (i === edgeSeams.left) {
        left = applyFrontEdgeVisorThreadClearance(sk, left, i);
      }

      const geoL = dashedRibbonGeometry(
        left,
        THREAD_HALF_WIDTH_M,
        nFn,
        THREAD_DASH_M,
        THREAD_GAP_M,
      );
      if (geoL.getAttribute("position")) {
        const meshL = new THREE.Mesh(geoL, mat);
        meshL.name = `Thread_Seam${i}_L`;
        group.add(meshL);
      }

      if (!skipRight) {
        let right = offsetPolylineLateral(
          seg,
          sk.spec,
          -THREAD_SEAM_LATERAL_M,
        );
        if (i === edgeSeams.right) {
          right = applyFrontEdgeVisorThreadClearance(sk, right, i);
        }
        const geoR = dashedRibbonGeometry(
          right,
          THREAD_HALF_WIDTH_M,
          nFn,
          THREAD_DASH_M,
          THREAD_GAP_M,
        );
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

  function rimPointForTheta(theta: number): Vec3 {
    return crownRimPointForBaseThreading(sk, theta);
  }

  let points: Vec3[];
  if (spec.backClosureOpening) {
    const frame = getBackClosureOpeningFrame(sk);
    const halfW =
      (BACK_CLOSURE_WIDTH_M + BACK_CLOSURE_TAPE_MARGIN_M) * 0.5 + 0.01;
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
      points.push(rimPointForTheta(theta));
    }
  } else {
    const nSeg = 96;
    const step = (2 * Math.PI) / nSeg;
    points = [];
    for (let i = 0; i < nSeg; i++) {
      points.push(rimPointForTheta(i * step));
    }
    points.push(points[0]!);
  }

  const geo = dashedRibbonGeometry(
    points,
    THREAD_HALF_WIDTH_M,
    nFn,
    THREAD_DASH_M,
    THREAD_GAP_M,
  );
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
  return clipPolylineToOutsideRimWithS(pts, semiAxisX, semiAxisY, yawRad).map(
    (e) => e.p,
  );
}

/**
 * Same as {@link clipPolylineToOutsideRim} but preserves span parameter `s ∈ [0,1]` along
 * the original polyline (before clip). Rim crossing vertices get `s` interpolated along
 * the segment so tip-adjacent points do not all collapse to `s ≈ 0` or `1` (which caused
 * thread bunches when reprojecting in XY).
 */
function clipPolylineToOutsideRimWithS(
  pts: [number, number, number][],
  semiAxisX: number,
  semiAxisY: number,
  yawRad: number,
  explicitS?: number[],
): { p: [number, number, number]; s: number }[] {
  const m = pts.length;
  if (m < 2) return m === 0 ? [] : [{ p: pts[0]!, s: explicitS?.[0] ?? 0 }];

  const cosY = Math.cos(-yawRad);
  const sinY = Math.sin(-yawRad);

  function ellipseVal(px: number, py: number): number {
    const xr = px * cosY - py * sinY;
    const yr = px * sinY + py * cosY;
    return (xr / semiAxisX) ** 2 + (yr / semiAxisY) ** 2;
  }

  const vals = pts.map((p) => ellipseVal(p[0], p[1]));

  function spanAtIndex(i: number): number {
    if (explicitS) return explicitS[i]!;
    return m <= 1 ? 0 : i / (m - 1);
  }

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

  const out: { p: [number, number, number]; s: number }[] = [];

  for (let i = 0; i < pts.length; i++) {
    const outside = vals[i]! >= 1.0;
    if (i > 0) {
      const prevOutside = vals[i - 1]! >= 1.0;
      if (outside !== prevOutside) {
        const va = vals[i - 1]!;
        const vb = vals[i]!;
        const t = (1 - va) / (vb - va);
        const p = rimCrossing(pts[i - 1]!, pts[i]!, va, vb);
        const s0 = spanAtIndex(i - 1);
        const s1 = spanAtIndex(i);
        const s = s0 * (1 - t) + s1 * t;
        out.push({ p, s });
      }
    }
    if (outside) {
      out.push({ p: pts[i]!, s: spanAtIndex(i) });
    }
  }

  return out;
}

function visorThreadOffsetPoint(p: Vec3, n: Vec3, dist: number): Vec3 {
  return [p[0] + n[0] * dist, p[1] + n[1] * dist, p[2] + n[2] * dist];
}

/**
 * Span parameter s in [0, 1] along the visor outer polyline by closest XY projection.
 */
function closestSpanSOnPlanformPolyline(
  rawPts: [number, number, number][],
  px: number,
  py: number,
): number {
  const n = rawPts.length;
  if (n === 0) return 0;
  if (n === 1) return 0;
  let bestS = 0;
  let bestDist = Infinity;
  for (let i = 0; i < n - 1; i++) {
    const ax = rawPts[i]![0];
    const ay = rawPts[i]![1];
    const bx = rawPts[i + 1]![0];
    const by = rawPts[i + 1]![1];
    const dx = bx - ax;
    const dy = by - ay;
    const len2 = dx * dx + dy * dy;
    let t = len2 < 1e-24 ? 0 : ((px - ax) * dx + (py - ay) * dy) / len2;
    t = Math.max(0, Math.min(1, t));
    const qx = ax + t * dx;
    const qy = ay + t * dy;
    const dist = (px - qx) ** 2 + (py - qy) ** 2;
    if (dist < bestDist) {
      bestDist = dist;
      const s0 = i / (n - 1);
      const s1 = (i + 1) / (n - 1);
      bestS = s0 * (1 - t) + s1 * t;
    }
  }
  return bestS;
}

/** Project planform XY onto the ruling at closest span: depth d along rim→outer in XY. */
function projectPlanformXYToRuledSd(
  sk: BuiltSkeleton,
  qx: number,
  qy: number,
): { s: number; d: number } {
  const vis = sk.visorPolyline as [number, number, number][];
  const s = closestSpanSOnPlanformPolyline(vis, qx, qy);
  const r = evalVisorRuledPointWorld(sk, s, 0);
  const o = evalVisorRuledPointWorld(sk, s, 1);
  const rx = r[0];
  const ry = r[1];
  const dx = o[0] - rx;
  const dy = o[1] - ry;
  const len2 = dx * dx + dy * dy;
  if (len2 < 1e-12) return { s, d: 0.5 };
  const d = Math.max(0, Math.min(1, ((qx - rx) * dx + (qy - ry) * dy) / len2));
  return { s, d };
}

/** Sweatband rim arc length per radian at θ (finite difference, m/rad). */
function sweatbandRimSpeed(spec: HatSkeletonSpec, theta: number): number {
  const eps = 1e-6;
  const p0 = sweatbandPoint(theta, spec.semiAxisX, spec.semiAxisY, spec.yawRad);
  const p1 = sweatbandPoint(
    theta + eps,
    spec.semiAxisX,
    spec.semiAxisY,
    spec.yawRad,
  );
  return Math.hypot(p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2]) / eps;
}

/**
 * Half the sweatband **chord length** (m) for a visor angular half-span `halfSpanRad` at attach `c`.
 * Used to normalize forward `b` by width so thread depth tracks the ellipse like the outer visor.
 */
function visorChordHalfWidthMeters(
  spec: HatSkeletonSpec,
  c: number,
  halfSpanRad: number,
): number {
  const left = sweatbandPoint(
    c - halfSpanRad,
    spec.semiAxisX,
    spec.semiAxisY,
    spec.yawRad,
  );
  const right = sweatbandPoint(
    c + halfSpanRad,
    spec.semiAxisX,
    spec.semiAxisY,
    spec.yawRad,
  );
  return (
    0.5 * Math.hypot(right[0] - left[0], right[1] - left[1], right[2] - left[2])
  );
}

/**
 * Ratio of **actual** built visor XY depth (rim → outer at span center) to `spec.projection`.
 * Multiplying `bScale` by this keeps thread curves aligned with {@link sk.visorPolyline} as
 * projection changes (mesh depth is not always exactly `projection` in practice).
 */
function visorThreadPlanformDepthScale(sk: BuiltSkeleton): number {
  const basis = getVisorRuledBasis(sk);
  const proj = sk.spec.visor.projection;
  if (!basis || proj < 1e-12) return 1;
  const { m, rim, outer } = basis;
  const iMid = Math.floor((m - 1) / 2);
  const r = rim[iMid]!;
  const o = outer[iMid]!;
  const depthXY = Math.hypot(o[0] - r[0], o[1] - r[1]);
  const ratio = depthXY / proj;
  return Math.max(0.2, Math.min(8, ratio));
}

/**
 * Half-angle span (rad) for visor threading row `row` (0 = outer): advance the left rim tip from the
 * full-visor edge by `edgeInsetM`, then by `row` steps of `rowGapM` along the rim (rim speed at each tip).
 */
function visorThreadHalfSpanRadForRow(
  spec: HatSkeletonSpec,
  halfSpan: number,
  c: number,
  row: number,
  edgeInsetM: number,
  rowGapM: number,
): number {
  let thetaLeft = c - halfSpan;
  let v = Math.max(sweatbandRimSpeed(spec, thetaLeft), 1e-9);
  thetaLeft += edgeInsetM / v;
  for (let i = 0; i < row; i++) {
    v = Math.max(sweatbandRimSpeed(spec, thetaLeft), 1e-9);
    thetaLeft += rowGapM / v;
  }
  const threadHalfSpan = c - thetaLeft;
  return Math.max(1e-6, Math.min(halfSpan - 1e-6, threadHalfSpan));
}

function buildVisorThreading(
  sk: BuiltSkeleton,
  mat: THREE.Material,
  group: THREE.Group,
  visorGeometries?: VisorThreadingGeometries,
): void {
  if (sk.visorPolyline.length < 2) return;

  const spec = sk.spec;

  const threadPeriod = THREAD_DASH_M + THREAD_GAP_M;
  const staggerTrim = threadPeriod * 0.5;

  const nRows = VISOR_THREAD_NUM_ROWS;

  const v = spec.visor;
  const c = v.attachAngleRad;
  const halfSpan = effectiveVisorHalfSpanRad(v, spec.nSeams, sk.angles);
  const edgeInsetM = VISOR_THREAD_OUTER_EDGE_INSET_M;
  const rowGapM = VISOR_THREAD_ROW_SPACING_RIM_M;
  const planformDepthScale = visorThreadPlanformDepthScale(sk);
  const threadingUserScale = v.visorThreadingScale ?? 1;

  const projBot = visorGeometries
    ? new VisorMeshRayHelper(visorGeometries.bottom, false)
    : null;
  const projTop = visorGeometries
    ? new VisorMeshRayHelper(visorGeometries.top, true)
    : null;

  const kMax = VISOR_THREAD_HOMOTHETY_MAX;
  const kMin = VISOR_THREAD_HOMOTHETY_MIN;

  const halfWidthFull = visorChordHalfWidthMeters(spec, c, halfSpan);

  for (let row = 0; row < nRows; row++) {
    const frac = nRows <= 1 ? 0 : row / (nRows - 1);
    const k = kMax + (kMin - kMax) * frac;
    const spanS = VISOR_THREAD_CHORD_S_ABS_MAX;

    const threadHalfSpanRow = visorThreadHalfSpanRadForRow(
      spec,
      halfSpan,
      c,
      row,
      edgeInsetM,
      rowGapM,
    );
    const visorSpecForThread = { ...v, halfSpanRad: threadHalfSpanRow };

    const halfWidthRow = visorChordHalfWidthMeters(spec, c, threadHalfSpanRow);
    const chordWidthNorm = halfWidthRow / Math.max(halfWidthFull, 1e-9);
    const bScale =
      k *
      VISOR_THREAD_FORWARD_B_SCALE *
      chordWidthNorm *
      planformDepthScale *
      threadingUserScale;
    const rowPlan = sampleVisorSuperellipsePolyline(
      spec.semiAxisX,
      spec.semiAxisY,
      spec.yawRad,
      visorSpecForThread,
      {
        aScale: k,
        bScale,
        sMin: -spanS,
        sMax: spanS,
        samples: VISOR_THREAD_PLANFORM_SAMPLES,
      },
    );

    const rawBot: [number, number, number][] = [];
    const rawBotS: number[] = [];
    const nP = rowPlan.length;
    for (let i = 0; i < nP; i++) {
      const p = rowPlan[i]!;
      const { s, d } = projectPlanformXYToRuledSd(sk, p[0], p[1]);
      const dClamped = Math.max(0.01, Math.min(1, d));
      if (projBot) {
        const hit = projBot.project(p[0], p[1]);
        if (hit) {
          rawBot.push([hit.x, hit.y, hit.z]);
        } else {
          const surfBot = evalVisorRuledPointWorld(sk, s, dClamped);
          rawBot.push([p[0], p[1], surfBot[2]]);
        }
      } else {
        const surfBot = evalVisorRuledPointWorld(sk, s, dClamped);
        rawBot.push([p[0], p[1], surfBot[2]]);
      }
      rawBotS.push(nP <= 1 ? 0 : i / (nP - 1));
    }

    if (rawBot.length < 2) continue;

    const clipped = clipPolylineToOutsideRimWithS(
      rawBot,
      spec.semiAxisX,
      spec.semiAxisY,
      spec.yawRad,
      rawBotS,
    );

    if (clipped.length < 2) continue;

    const isOddRow = row % 2 === 1;

    let topRow = clipped.map(({ p }) => {
      const { s, d } = projectPlanformXYToRuledSd(sk, p[0], p[1]);
      const dClamped = Math.max(0.01, Math.min(1, d));
      const n = evalVisorRuledNormalWorld(sk, s, dClamped, true);
      let base: Vec3;
      if (projTop) {
        const hit = projTop.project(p[0], p[1]);
        base = hit
          ? [hit.x, hit.y, hit.z]
          : ([p[0], p[1], evalVisorRuledTopWorld(sk, s, dClamped)[2]] as Vec3);
      } else {
        base = [p[0], p[1], evalVisorRuledTopWorld(sk, s, dClamped)[2]] as Vec3;
      }
      return visorThreadOffsetPoint(
        base,
        n as Vec3,
        VISOR_THREAD_SURFACE_OFFSET_M,
      );
    });
    let botRow = clipped.map(({ p }) => {
      const { s, d } = projectPlanformXYToRuledSd(sk, p[0], p[1]);
      const dClamped = Math.max(0.01, Math.min(1, d));
      const n = evalVisorRuledNormalWorld(sk, s, dClamped, false);
      let base: Vec3;
      if (projBot) {
        const hit = projBot.project(p[0], p[1]);
        base = hit
          ? [hit.x, hit.y, hit.z]
          : ([
              p[0],
              p[1],
              evalVisorRuledPointWorld(sk, s, dClamped)[2],
            ] as Vec3);
      } else {
        base = [
          p[0],
          p[1],
          evalVisorRuledPointWorld(sk, s, dClamped)[2],
        ] as Vec3;
      }
      return visorThreadOffsetPoint(
        base,
        n as Vec3,
        VISOR_THREAD_SURFACE_OFFSET_M,
      );
    });

    if (isOddRow) {
      topRow = trimPolylineStart(topRow, staggerTrim);
      botRow = trimPolylineStart(botRow, staggerTrim);
    }

    const geoTop = dashedRibbonGeometry(
      topRow,
      THREAD_HALF_WIDTH_M,
      flatUpNormal,
      THREAD_DASH_M,
      THREAD_GAP_M,
    );
    if (geoTop.getAttribute("position")) {
      const meshTop = new THREE.Mesh(geoTop, mat);
      meshTop.name = `Thread_Visor_Top_${row}`;
      group.add(meshTop);
    }

    const geoBot = dashedRibbonGeometry(
      botRow,
      THREAD_HALF_WIDTH_M,
      flatDownNormal,
      THREAD_DASH_M,
      THREAD_GAP_M,
    );
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

  const dOuter = SEAM_TAPE_WIDTH_M * 1.2;
  const riseExtra = SEAM_TAPE_WIDTH_M * 0.5;

  const archRows = [
    { frac: 0.4, name: "Thread_Arch_Inner" },
    { frac: 1.0, name: "Thread_Arch_Outer" },
  ];

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

  const nFn = crownNormalFn(sk.spec);

  for (const { frac, name } of archRows) {
    const di = dOuter * frac;
    const archHalfW = outerW * 0.5 + di;
    const archRise = outerW * 0.5 + riseExtra * frac;
    const archStraight = outerS;

    const archPts2D = sampleOpenArchPath(archHalfW, archStraight, 56, archRise);

    const centerline = archPts2D.map(([lx, ly]) =>
      projectToCrownOutside(lx, ly),
    );

    const clampedCenterline = centerline.map((p) =>
      p[2] < 0 ? ([p[0], p[1], 0] as Vec3) : p,
    );

    const geo = dashedRibbonGeometry(
      clampedCenterline,
      THREAD_HALF_WIDTH_M,
      nFn,
      THREAD_DASH_M,
      THREAD_GAP_M,
    );
    if (geo.getAttribute("position")) {
      const mesh = new THREE.Mesh(geo, mat);
      mesh.name = name;
      group.add(mesh);
    }
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
  const closure = spec.backClosureOpening === true;

  let thetas: number[];
  let openArc = false;
  const nSeg = SWEATBAND_THREAD_SEGMENTS;

  if (closure) {
    const { tW, rimAnchor } = getBackClosureOpeningFrame(sk);
    const halfW =
      (BACK_CLOSURE_WIDTH_M + BACK_CLOSURE_TAPE_MARGIN_M) * 0.5 + 0.01;
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
      thetas = Array.from(
        { length: nSeg },
        (_, i) => start + (i / (nSeg - 1)) * span,
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
      const onOuter = outerSurfacePoint(sk, theta, kFloat, M, N, inset);
      const p = offsetInwardXY(
        onOuter,
        THREAD_SWEATBAND_DEPTH_BIAS_INWARD_M,
      ) as Vec3;
      rowPoints.push(p);
    }

    if (!openArc && rowPoints.length > 1) {
      rowPoints.push(rowPoints[0]!);
    }

    // Radial inward normal → cross(tangent, radialInward) = vertical direction.
    // Ribbon width extends vertically → lies flat on the cylindrical band surface →
    // face points radially → visible from inside the hat.
    const radialInwardNormal = (p: Vec3): Vec3 => {
      const L = Math.hypot(p[0], p[1]);
      if (L < 1e-12) return [0, 0, 1];
      return [-p[0] / L, -p[1] / L, 0];
    };

    const period = SWEATBAND_THREAD_DASH_M + SWEATBAND_THREAD_GAP_M;
    const geo = dashedRibbonGeometry(
      rowPoints,
      SWEATBAND_THREAD_HALF_WIDTH_M,
      radialInwardNormal,
      SWEATBAND_THREAD_DASH_M,
      SWEATBAND_THREAD_GAP_M,
      row * (period * 0.35),
    );
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

export function buildThreadingGroup(
  sk: BuiltSkeleton,
  visorGeometries?: VisorThreadingGeometries,
): THREE.Group {
  const group = new THREE.Group();
  group.name = "Threading";
  // Default 0: rely on depth buffer with crown/sweatband. Higher order drew ribbons after
  // opaque passes and interacted badly with polygonOffset at grazing angles (flashing).
  group.renderOrder = 0;

  const mat = new THREE.MeshStandardMaterial({
    color: 0xeeeeee,
    flatShading: true,
    side: THREE.DoubleSide,
    metalness: 0.02,
    roughness: 0.95,
    polygonOffset: true,
    // Mild offset: strong negative values fight the crown mesh at perpendicular views.
    polygonOffsetFactor: -1,
    polygonOffsetUnits: -1,
    depthWrite: true,
  });

  buildSeamThreading(sk, mat, group);
  buildBaseThreading(sk, mat, group);
  buildVisorThreading(sk, mat, group, visorGeometries);
  buildArchThreading(sk, mat, group);
  buildSweatbandThreading(sk, mat, group);

  return group;
}
