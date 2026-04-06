import * as THREE from "three";
import {
  effectiveVisorHalfSpanRad,
  type BuiltSkeleton,
} from "@/lib/skeleton/geometry";
import type { HatSkeletonSpec } from "@/lib/skeleton/types";
import { crownRimPointForBaseThreading } from "@/lib/hat/threadingMesh";
import {
  type Vec3,
  cross3,
  dot3,
  lerp3,
  norm3,
  outwardCrownNormalApprox,
} from "@/lib/hat/curveUtils";

/** Crown rim samples across the visor span (Thread_Base curve). */
const BILL_ROPE_INNER_RIM_SEGMENTS = 44;

/** How far below the rim point the under-tuck drops (metres). */
const BILL_ROPE_WRAP_DROP_M = 0.003;

/** How far inward (toward hat center) the tuck goes after dropping below the rim. */
const BILL_ROPE_WRAP_TUCK_INWARD_M = 0.0045;

/** How far up the curve rises at the very end of the tuck (back into the hat). */
const BILL_ROPE_WRAP_CURVE_UP_M = 0.006;

/** Minimum radius scale in the under-tuck (0 = taper to nothing, 0.5 = half width). */
const BILL_ROPE_WRAP_MIN_SCALE = 0.0;

/** Samples in the bezier tuck curve. */
const BILL_ROPE_WRAP_STEPS = 20;

/**
 * Fraction of the visor span from each edge where the wrap taper begins.
 * 0 = taper only in the under-tuck; full width right at the visor edge.
 * 0.1 = the first/last 10% of the rim arc is part of the wrap taper.
 */
const BILL_ROPE_WRAP_START_FRAC = 0.06;

const BILL_ROPE_RADIUS_M = 0.0022;

/** Min arc spacing along the **offset** centerline (chord length follows; see H6: resample after normal offset). */
const BILL_ROPE_MIN_SAMPLE_STEP_M = BILL_ROPE_RADIUS_M * 0.65;

/** Drop/merge samples closer than this (wrap taper still produced ~0.28 mm chords; see logs). */
const BILL_ROPE_MIN_CHORD_MERGE_M = BILL_ROPE_RADIUS_M * 0.42;

/** Use axis–tangent cross for tube normal when tangent is nearly vertical (meridian wrap). */
const TUBE_TANGENT_VERTICAL_DOT_Z = 0.88;

/** Push along crown normal so the rope clears the visor shell in the depth buffer. */
const BILL_ROPE_OUTWARD_M = 0.00075;

/** Vertical Z drop to bring the rope down from crown rim height onto the visor surface. */
const BILL_ROPE_Z_DROP_M = 0.001;

const BILL_ROPE_RADIAL_SEGMENTS = 10;

/** Logical segments for debug vertex colors (see {@link BILL_ROPE_PART_RGB}). */
export const BillRopePart = {
  WrapLeft: 0,
  InnerRim: 1,
  WrapRight: 2,
} as const;

/** sRGB 0–1 per {@link BillRopePart} for vertex-colored debug view. */
const BILL_ROPE_PART_RGB: [number, number, number][] = [
  [0.95, 0.2, 0.95],
  [0.15, 1, 0.2],
  [0.05, 0.85, 1],
];

const BILL_ROPE_PART_LABELS: string[] = [
  "WrapLeft (visor left edge, taper 0→1)",
  "InnerRim (crown / Thread_Base arc, full width)",
  "WrapRight (visor right edge, taper 1→0)",
];

function smoothstep01(t: number): number {
  const u = Math.max(0, Math.min(1, t));
  return u * u * (3 - 2 * u);
}

function sub3(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

function add3(a: Vec3, b: Vec3): Vec3 {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}

function scale3(v: Vec3, s: number): Vec3 {
  return [v[0] * s, v[1] * s, v[2] * s];
}

function cumulativeArcLengths(points: Vec3[]): number[] {
  const acc: number[] = [0];
  let s = 0;
  for (let i = 1; i < points.length; i++) {
    const d = Math.hypot(
      points[i]![0] - points[i - 1]![0],
      points[i]![1] - points[i - 1]![1],
      points[i]![2] - points[i - 1]![2],
    );
    s += d;
    acc.push(s);
  }
  return acc;
}

function samplePolylineAtArcLength(
  points: Vec3[],
  scales: number[],
  partIds: number[],
  arc: number[],
  s: number,
): { p: Vec3; scale: number; partId: number } {
  const L = arc[arc.length - 1] ?? 0;
  if (points.length === 0) return { p: [0, 0, 0], scale: 1, partId: 0 };
  if (points.length === 1)
    return { p: points[0]!, scale: scales[0]!, partId: partIds[0]! };
  if (s <= 0) return { p: points[0]!, scale: scales[0]!, partId: partIds[0]! };
  if (s >= L) {
    return {
      p: points[points.length - 1]!,
      scale: scales[scales.length - 1]!,
      partId: partIds[partIds.length - 1]!,
    };
  }
  for (let i = 0; i < arc.length - 1; i++) {
    const a0 = arc[i]!;
    const a1 = arc[i + 1]!;
    if (s <= a1 + 1e-12) {
      const t = a1 > a0 + 1e-15 ? (s - a0) / (a1 - a0) : 0;
      const p0 = points[i]!;
      const p1 = points[i + 1]!;
      const p: Vec3 = [
        p0[0] + t * (p1[0] - p0[0]),
        p0[1] + t * (p1[1] - p0[1]),
        p0[2] + t * (p1[2] - p0[2]),
      ];
      const scale = scales[i]! + t * (scales[i + 1]! - scales[i]!);
      const partId = t < 0.5 ? partIds[i]! : partIds[i + 1]!;
      return { p, scale, partId };
    }
  }
  return {
    p: points[points.length - 1]!,
    scale: scales[scales.length - 1]!,
    partId: partIds[partIds.length - 1]!,
  };
}

/** Evenly spaced samples along arc length so edge length ≲ step (fixes overlapping tube geometry). */
function resamplePolylineUniformStep(
  points: Vec3[],
  scales: number[],
  partIds: number[],
  step: number,
): { points: Vec3[]; scales: number[]; partIds: number[] } {
  if (points.length < 2 || step < 1e-8) {
    return {
      points: [...points],
      scales: [...scales],
      partIds: [...partIds],
    };
  }
  const arc = cumulativeArcLengths(points);
  const L = arc[arc.length - 1] ?? 0;
  if (L < 1e-10) {
    return {
      points: [...points],
      scales: [...scales],
      partIds: [...partIds],
    };
  }

  const nTarget = Math.max(2, Math.ceil(L / step) + 1);
  const outP: Vec3[] = [];
  const outS: number[] = [];
  const outPart: number[] = [];
  for (let k = 0; k < nTarget; k++) {
    const s = (k / (nTarget - 1)) * L;
    const { p, scale, partId } = samplePolylineAtArcLength(
      points,
      scales,
      partIds,
      arc,
      s,
    );
    outP.push(p);
    outS.push(scale);
    outPart.push(partId);
  }
  return { points: outP, scales: outS, partIds: outPart };
}

/** Second pass: merge consecutive points closer than minChord (fixes degenerate tris at wrap taper). */
function mergeCloseConsecutiveSamples(
  centers: Vec3[],
  scales: number[],
  partIds: number[],
  minChord: number,
): { centers: Vec3[]; scales: number[]; partIds: number[] } {
  if (centers.length < 2) {
    return {
      centers: [...centers],
      scales: [...scales],
      partIds: [...partIds],
    };
  }
  const c: Vec3[] = [centers[0]!];
  const s: number[] = [scales[0]!];
  const p: number[] = [partIds[0]!];
  for (let i = 1; i < centers.length; i++) {
    const prev = c[c.length - 1]!;
    const q = centers[i]!;
    const d = Math.hypot(q[0] - prev[0], q[1] - prev[1], q[2] - prev[2]);
    if (d < minChord) {
      s[s.length - 1] = Math.min(s[s.length - 1]!, scales[i]!);
      p[p.length - 1] = partIds[i]!;
      continue;
    }
    c.push(q);
    s.push(scales[i]!);
    p.push(partIds[i]!);
  }
  return { centers: c, scales: s, partIds: p };
}

function pushDeduped(
  points: Vec3[],
  scales: number[],
  partIds: number[],
  p: Vec3,
  scale: number,
  partId: number,
  eps: number = 1e-5,
): void {
  const prev = points[points.length - 1];
  if (
    prev &&
    Math.hypot(p[0] - prev[0], p[1] - prev[1], p[2] - prev[2]) < eps
  ) {
    // Min: if one duplicate sample is taper=0 and another is 1, keep 0 (max was re-inflating tips).
    scales[scales.length - 1] = Math.min(scales[scales.length - 1]!, scale);
    partIds[scales.length - 1] = partId;
    return;
  }
  points.push(p);
  scales.push(scale);
  partIds.push(partId);
}

function buildBillRopeCenterline(sk: BuiltSkeleton): {
  points: Vec3[];
  radiusScale: number[];
  partIds: number[];
} {
  const spec = sk.spec;
  const v = spec.visor;
  const halfSpan = effectiveVisorHalfSpanRad(v, spec.nSeams, sk.angles);
  const c = v.attachAngleRad;
  const thetaLeft = c - halfSpan;
  const thetaRight = c + halfSpan;

  const points: Vec3[] = [];
  const radiusScale: number[] = [];
  const partIds: number[] = [];

  const nWrap = BILL_ROPE_WRAP_STEPS;
  const wrapFrac = Math.max(0, Math.min(0.5, BILL_ROPE_WRAP_START_FRAC));
  const spanRad = 2 * halfSpan;

  const pRimL = crownRimPointForBaseThreading(sk, thetaLeft);
  const pRimR = crownRimPointForBaseThreading(sk, thetaRight);

  // The wrap transition points — inset from the visor edges by wrapFrac.
  const thetaWrapL = thetaLeft + wrapFrac * spanRad;
  const thetaWrapR = thetaRight - wrapFrac * spanRad;
  // Bezier tuck control points: P0 (up-inside) → P1 (inside) → P2 (bottom) → P3 (rim).
  function tuckBezierCPs(pRim: Vec3): [Vec3, Vec3, Vec3, Vec3] {
    const len = Math.hypot(pRim[0], pRim[1]);
    const inScale = len > 1e-12 ? BILL_ROPE_WRAP_TUCK_INWARD_M / len : 0;
    const inX = pRim[0] * (1 - inScale);
    const inY = pRim[1] * (1 - inScale);
    const p0: Vec3 = [
      inX,
      inY,
      pRim[2] - BILL_ROPE_WRAP_DROP_M + BILL_ROPE_WRAP_CURVE_UP_M,
    ];
    const p1: Vec3 = [inX, inY, pRim[2] - BILL_ROPE_WRAP_DROP_M];
    const p2: Vec3 = [pRim[0], pRim[1], pRim[2] - BILL_ROPE_WRAP_DROP_M];
    const p3: Vec3 = pRim;
    return [p0, p1, p2, p3];
  }

  function cubicBezier(P: [Vec3, Vec3, Vec3, Vec3], t: number): Vec3 {
    const s = 1 - t;
    return [
      s * s * s * P[0][0] +
        3 * s * s * t * P[1][0] +
        3 * s * t * t * P[2][0] +
        t * t * t * P[3][0],
      s * s * s * P[0][1] +
        3 * s * s * t * P[1][1] +
        3 * s * t * t * P[2][1] +
        t * t * t * P[3][1],
      s * s * s * P[0][2] +
        3 * s * s * t * P[1][2] +
        3 * s * t * t * P[2][2] +
        t * t * t * P[3][2],
    ];
  }

  const bezL = tuckBezierCPs(pRimL);
  const bezR = tuckBezierCPs(pRimR);

  const minW = BILL_ROPE_WRAP_MIN_SCALE;
  const nWrapArc = Math.max(
    1,
    Math.round(wrapFrac * BILL_ROPE_INNER_RIM_SEGMENTS),
  );

  // Left wrap: bezier tuck (t 0→1) then rim arc, linear taper over the whole section.
  const totalL = nWrap + nWrapArc;
  for (let j = 0; j <= nWrap; j++) {
    const t = j / nWrap;
    const w = minW + (1 - minW) * (j / totalL);
    pushDeduped(
      points,
      radiusScale,
      partIds,
      cubicBezier(bezL, t),
      w,
      BillRopePart.WrapLeft,
    );
  }
  for (let j = 1; j <= nWrapArc; j++) {
    const step = nWrap + j;
    const w = minW + (1 - minW) * (step / totalL);
    const theta = thetaLeft + (j / nWrapArc) * wrapFrac * spanRad;
    pushDeduped(
      points,
      radiusScale,
      partIds,
      crownRimPointForBaseThreading(sk, theta),
      w,
      BillRopePart.WrapLeft,
    );
  }

  // Main inner rim arc (full width) from thetaWrapL to thetaWrapR.
  const innerSpanRad = thetaWrapR - thetaWrapL;
  const nInner = Math.max(
    2,
    Math.round(BILL_ROPE_INNER_RIM_SEGMENTS * (1 - 2 * wrapFrac)),
  );
  for (let i = 1; i <= nInner; i++) {
    const theta = thetaWrapL + (i / nInner) * innerSpanRad;
    pushDeduped(
      points,
      radiusScale,
      partIds,
      crownRimPointForBaseThreading(sk, theta),
      1,
      BillRopePart.InnerRim,
    );
  }

  // Right wrap: rim arc then bezier tuck (reversed), linear taper over the whole section.
  const totalR = nWrap + nWrapArc;
  for (let j = 0; j <= nWrapArc; j++) {
    const w = minW + (1 - minW) * (1 - j / totalR);
    const theta = thetaWrapR + (j / nWrapArc) * wrapFrac * spanRad;
    pushDeduped(
      points,
      radiusScale,
      partIds,
      crownRimPointForBaseThreading(sk, theta),
      w,
      BillRopePart.WrapRight,
    );
  }
  for (let j = 1; j <= nWrap; j++) {
    const step = nWrapArc + j;
    const t = 1 - j / nWrap;
    const w = minW + (1 - minW) * (1 - step / totalR);
    pushDeduped(
      points,
      radiusScale,
      partIds,
      cubicBezier(bezR, t),
      w,
      BillRopePart.WrapRight,
    );
  }

  return { points, radiusScale, partIds };
}

function offsetAlongCrownNormal(
  points: Vec3[],
  spec: HatSkeletonSpec,
  dist: number,
): Vec3[] {
  if (dist < 1e-12) return points;
  return points.map((p) => {
    const n = outwardCrownNormalApprox(p, spec);
    return [p[0] + n[0] * dist, p[1] + n[1] * dist, p[2] + n[2] * dist];
  });
}

function normalFromAxisCrossSteepTangent(T: Vec3, Nprev: Vec3 | null): Vec3 {
  const ax = cross3([1, 0, 0], T);
  const ay = cross3([0, 1, 0], T);
  const lx = Math.hypot(ax[0], ax[1], ax[2]);
  const ly = Math.hypot(ay[0], ay[1], ay[2]);
  let Np = lx >= ly ? ax : ay;
  let len = Math.max(lx, ly);
  if (len < 1e-10) {
    Np = cross3([0, 0, 1], T);
    len = Math.hypot(Np[0], Np[1], Np[2]);
  }
  if (len < 1e-10) return [1, 0, 0];
  Np = [Np[0] / len, Np[1] / len, Np[2] / len];
  if (Nprev && dot3(Np, Nprev) < 0) {
    Np = [-Np[0], -Np[1], -Np[2]];
  }
  return Np;
}

function computeTubeFrames(points: Vec3[]): { nrm: Vec3[]; bin: Vec3[] } {
  const nPts = points.length;
  const tangents: Vec3[] = [];
  for (let i = 0; i < nPts; i++) {
    let t: Vec3;
    if (i === 0) {
      t = norm3(sub3(points[1]!, points[0]!));
    } else if (i === nPts - 1) {
      t = norm3(sub3(points[nPts - 1]!, points[nPts - 2]!));
    } else {
      const t0 = norm3(sub3(points[i]!, points[i - 1]!));
      const t1 = norm3(sub3(points[i + 1]!, points[i]!));
      t = norm3(add3(t0, t1));
    }
    tangents.push(t);
  }

  const UP: Vec3 = [0, 0, 1];
  const nrm: Vec3[] = [];
  const bin: Vec3[] = [];

  const T0 = tangents[0]!;
  let N0: Vec3;
  if (Math.abs(T0[2]) > TUBE_TANGENT_VERTICAL_DOT_Z) {
    N0 = normalFromAxisCrossSteepTangent(T0, null);
  } else {
    N0 = cross3(UP, T0);
    let len0 = Math.hypot(N0[0], N0[1], N0[2]);
    if (len0 < 1e-10) {
      N0 = cross3([1, 0, 0], T0);
      len0 = Math.hypot(N0[0], N0[1], N0[2]);
    }
    if (len0 < 1e-10) {
      N0 = [1, 0, 0];
    } else {
      N0 = [N0[0] / len0, N0[1] / len0, N0[2] / len0];
    }
  }
  nrm.push(N0);
  bin.push(norm3(cross3(T0, N0)));

  for (let i = 1; i < nPts; i++) {
    const T = tangents[i]!;
    const Nprev = nrm[i - 1]!;
    let Np: Vec3;
    if (Math.abs(T[2]) > TUBE_TANGENT_VERTICAL_DOT_Z) {
      Np = normalFromAxisCrossSteepTangent(T, Nprev);
    } else {
      Np = sub3(Nprev, scale3(T, dot3(Nprev, T)));
      let len = Math.hypot(Np[0], Np[1], Np[2]);
      if (len < 1e-10) {
        Np = cross3(UP, T);
        len = Math.hypot(Np[0], Np[1], Np[2]);
      }
      if (len < 1e-10) {
        Np = cross3([1, 0, 0], T);
        len = Math.hypot(Np[0], Np[1], Np[2]);
      }
      if (len < 1e-10) {
        Np = [1, 0, 0];
      } else {
        Np = [Np[0] / len, Np[1] / len, Np[2] / len];
      }
      if (dot3(Np, Nprev) < 0) {
        Np = [-Np[0], -Np[1], -Np[2]];
      }
    }
    nrm.push(Np);
    bin.push(norm3(cross3(T, Np)));
  }
  return { nrm, bin };
}

function buildTaperedTubeGeometry(
  centers: Vec3[],
  radiusScale: number[],
  rMax: number,
  radialSegs: number,
  partIds: number[],
): THREE.BufferGeometry {
  const n = centers.length;
  if (n < 2) return new THREE.BufferGeometry();

  const { nrm, bin } = computeTubeFrames(centers);
  const positions: number[] = [];
  const indices: number[] = [];
  const colors: number[] = [];

  for (let i = 0; i < n; i++) {
    const c = centers[i]!;
    const N = nrm[i]!;
    const B = bin[i]!;
    const w = radiusScale[i] ?? 1;
    const ri = rMax * Math.max(0, Math.min(1, w));
    const pid = Math.min(
      BILL_ROPE_PART_RGB.length - 1,
      Math.max(0, partIds[i] ?? 0),
    );
    const [cr, cg, cb] = BILL_ROPE_PART_RGB[pid]!;
    for (let j = 0; j < radialSegs; j++) {
      const ang = (j / radialSegs) * Math.PI * 2;
      const cos = Math.cos(ang);
      const sin = Math.sin(ang);
      positions.push(
        c[0] + ri * (cos * N[0] + sin * B[0]),
        c[1] + ri * (cos * N[1] + sin * B[1]),
        c[2] + ri * (cos * N[2] + sin * B[2]),
      );
      colors.push(cr, cg, cb);
    }
  }

  for (let i = 0; i < n - 1; i++) {
    for (let j = 0; j < radialSegs; j++) {
      const jn = (j + 1) % radialSegs;
      const a = i * radialSegs + j;
      const b = i * radialSegs + jn;
      const c = (i + 1) * radialSegs + jn;
      const d = (i + 1) * radialSegs + j;
      indices.push(a, b, c, a, c, d);
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
  geo.setIndex(indices);
  geo.computeVertexNormals();
  return geo;
}

/**
 * Tubular bill rope: crown rim (Thread_Base stack) across the visor span, with
 * rim→tip bridges only; radius tapers to zero at inner corners (no under-bill ladder).
 */
export function buildBillRopeGroup(sk: BuiltSkeleton): THREE.Group {
  const g = new THREE.Group();
  g.name = "BillRope";

  if (sk.visorPolyline.length < 2) return g;

  const raw = buildBillRopeCenterline(sk);

  // Drop tapered centers so the tube bottom stays flush with the visor surface.
  // At full width the center is at rim Z; at radius w<1 the bottom would lift
  // by R*(1-w), so we push the center down by that amount.
  // Also apply the global Z drop to bring the rope onto the visor surface.
  for (let i = 0; i < raw.points.length; i++) {
    const w = raw.radiusScale[i] ?? 1;
    raw.points[i]![2] -= BILL_ROPE_Z_DROP_M;
    if (w < 1) raw.points[i]![2] -= BILL_ROPE_RADIUS_M * (1 - w);
  }

  const centersAfterOffset = offsetAlongCrownNormal(
    raw.points,
    sk.spec,
    BILL_ROPE_OUTWARD_M,
  );
  const resampled = resamplePolylineUniformStep(
    centersAfterOffset,
    raw.radiusScale,
    raw.partIds,
    BILL_ROPE_MIN_SAMPLE_STEP_M,
  );
  const merged = mergeCloseConsecutiveSamples(
    resampled.points,
    resampled.scales,
    resampled.partIds,
    BILL_ROPE_MIN_CHORD_MERGE_M,
  );
  const centers = merged.centers;
  const radiusScale = merged.scales;
  const partIdsResampled = merged.partIds;
  const arcLens = cumulativeArcLengths(centers);
  const totalLen = arcLens[arcLens.length - 1] ?? 0;

  // #region agent log
  {
    const wrapLScales = raw.radiusScale.filter(
      (_, i) => raw.partIds[i] === BillRopePart.WrapLeft,
    );
    const wrapRScales = raw.radiusScale.filter(
      (_, i) => raw.partIds[i] === BillRopePart.WrapRight,
    );
    let minChordOffsetOnly = Infinity;
    for (let i = 1; i < centersAfterOffset.length; i++) {
      const d = Math.hypot(
        centersAfterOffset[i]![0] - centersAfterOffset[i - 1]![0],
        centersAfterOffset[i]![1] - centersAfterOffset[i - 1]![1],
        centersAfterOffset[i]![2] - centersAfterOffset[i - 1]![2],
      );
      minChordOffsetOnly = Math.min(minChordOffsetOnly, d);
    }
    const nPts = centers.length;
    const UP: Vec3 = [0, 0, 1];
    const segLens: number[] = [];
    for (let i = 1; i < nPts; i++) {
      segLens.push(
        Math.hypot(
          centers[i]![0] - centers[i - 1]![0],
          centers[i]![1] - centers[i - 1]![1],
          centers[i]![2] - centers[i - 1]![2],
        ),
      );
    }
    let minSeg = Infinity;
    let minSegIdx = -1;
    for (let i = 0; i < segLens.length; i++) {
      if (segLens[i]! < minSeg) {
        minSeg = segLens[i]!;
        minSegIdx = i;
      }
    }
    const shortSegIdx: number[] = [];
    for (let i = 0; i < segLens.length; i++) {
      if (segLens[i]! < BILL_ROPE_RADIUS_M * 0.5) shortSegIdx.push(i);
    }
    let badCross = 0;
    let maxDotAbs = 0;
    const tanDots: number[] = [];
    for (let i = 0; i < nPts; i++) {
      let t: Vec3;
      if (i === 0) {
        t = norm3(sub3(centers[1]!, centers[0]!));
      } else if (i === nPts - 1) {
        t = norm3(sub3(centers[nPts - 1]!, centers[nPts - 2]!));
      } else {
        const t0 = norm3(sub3(centers[i]!, centers[i - 1]!));
        const t1 = norm3(sub3(centers[i + 1]!, centers[i]!));
        t = norm3(add3(t0, t1));
      }
      const d = Math.abs(dot3(t, UP));
      tanDots.push(d);
      maxDotAbs = Math.max(maxDotAbs, d);
      const cr = cross3(UP, t);
      const cl = Math.hypot(cr[0], cr[1], cr[2]);
      if (cl < 1e-9) badCross++;
    }
    let maxOffsetJump = 0;
    for (let i = 1; i < raw.points.length; i++) {
      const j = Math.hypot(
        centersAfterOffset[i]![0] - raw.points[i]![0],
        centersAfterOffset[i]![1] - raw.points[i]![1],
        centersAfterOffset[i]![2] - raw.points[i]![2],
      );
      const j0 = Math.hypot(
        centersAfterOffset[i - 1]![0] - raw.points[i - 1]![0],
        centersAfterOffset[i - 1]![1] - raw.points[i - 1]![1],
        centersAfterOffset[i - 1]![2] - raw.points[i - 1]![2],
      );
      maxOffsetJump = Math.max(maxOffsetJump, Math.abs(j - j0));
    }
    fetch("http://127.0.0.1:7308/ingest/f207d8e5-31a4-4fc3-90ad-c0892d7b6fa9", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Debug-Session-Id": "33d427",
      },
      body: JSON.stringify({
        sessionId: "33d427",
        hypothesisId: "H10-rimOnly",
        location: "billRopeMesh.ts:buildBillRopeGroup",
        message: "bill rope centerline/tube diagnostics",
        data: {
          taperMode: "rimArc+zDropOnly",
          wrapDropM: BILL_ROPE_WRAP_DROP_M,
          wrapStartFrac: BILL_ROPE_WRAP_START_FRAC,
          wrapLScales,
          wrapRScales,
          rawCenterlineCount: raw.points.length,
          nPts,
          totalLen,
          minSegLen: minSeg === Infinity ? null : minSeg,
          minSegIdx,
          shortSegCount: shortSegIdx.length,
          shortSegIdxSample: shortSegIdx.slice(0, 12),
          badCrossCount: badCross,
          maxTanDotZAbs: maxDotAbs,
          tanDotZAbove09: tanDots.filter((x) => x > 0.9).length,
          maxOffsetJumpAlongPolyline: maxOffsetJump,
          radiusScaleMin: Math.min(...radiusScale),
          radiusScaleMax: Math.max(...radiusScale),
          minSampleStepM: BILL_ROPE_MIN_SAMPLE_STEP_M,
          resamplePhase: "afterOffset",
          minChordOffsetOnlyBeforeSecondResample:
            minChordOffsetOnly === Infinity ? null : minChordOffsetOnly,
          nPtsAfterResample: resampled.points.length,
          nPtsAfterMerge: centers.length,
          minChordMergeM: BILL_ROPE_MIN_CHORD_MERGE_M,
        },
        timestamp: Date.now(),
        runId: "vertical-wrap-v1",
      }),
    }).catch(() => {});
  }
  // #endregion

  const geo = buildTaperedTubeGeometry(
    centers,
    radiusScale,
    BILL_ROPE_RADIUS_M,
    BILL_ROPE_RADIAL_SEGMENTS,
    partIdsResampled,
  );
  if (!geo.getAttribute("position") || totalLen < 1e-8) return g;

  const mat = new THREE.MeshStandardMaterial({
    vertexColors: true,
    color: 0xffffff,
    emissive: 0x0a0a0a,
    emissiveIntensity: 0.25,
    flatShading: false,
    side: THREE.DoubleSide,
    metalness: 0.12,
    roughness: 0.45,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = "BillRope_Tube";
  mesh.renderOrder = 3;
  g.add(mesh);

  g.userData.billRopePartLegend = BILL_ROPE_PART_LABELS.map((label, i) => ({
    partId: i,
    label,
    rgb: BILL_ROPE_PART_RGB[i],
  }));

  return g;
}
