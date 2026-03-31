import type { HatMeasurementTargets, HatSkeletonSpec, PanelCount } from "./types";
import {
  buildSkeleton,
  effectiveVisorHalfSpanRad,
  frontPanelRimThetaBounds,
  panelSeamAngles,
  sampleSeamCurve,
  sweatbandPoint,
  visorOuterPolyline,
  type BuiltSkeleton,
  type SeamCurve,
} from "./geometry";

/** Polyline length in 3D (sum of segment lengths). */
export function polylineLength(points: [number, number, number][]): number {
  if (points.length < 2) return 0;
  let L = 0;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]!;
    const b = points[i]!;
    L += Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
  }
  return L;
}

/**
 * Sweatband ellipse perimeter (rotation preserves length; sample in θ).
 * Uses many samples for stable measurement vs solver scale.
 */
export function sweatbandCircumference(
  semiAxisX: number,
  semiAxisY: number,
  yawRad: number,
  samples = 512
): number {
  let L = 0;
  let prev = sweatbandPoint(0, semiAxisX, semiAxisY, yawRad);
  for (let i = 1; i <= samples; i++) {
    const t = (i / samples) * 2 * Math.PI;
    const cur = sweatbandPoint(t, semiAxisX, semiAxisY, yawRad);
    L += Math.hypot(cur[0] - prev[0], cur[1] - prev[1], cur[2] - prev[2]);
    prev = cur;
  }
  return L;
}

/** Arc length of one seam curve (rim → top) as sampled. */
export function seamCurveArcLength(curve: SeamCurve, segments = 96): number {
  const pts = sampleSeamCurve(curve, segments);
  return polylineLength(pts);
}

/** Arc length of each seam in order 0 … n−1. */
export function seamArcLengthsFromBuiltSkeleton(sk: BuiltSkeleton): number[] {
  return sk.seamControls.map((c) => seamCurveArcLength(c));
}

export function seamArcLengthsFromSpec(spec: HatSkeletonSpec): number[] {
  return seamArcLengthsFromBuiltSkeleton(buildSkeleton(spec));
}

/**
 * Outer visor edge length (superellipse polyline) using the same half-span logic as the mesh.
 */
export function visorOuterArcLengthFromSpec(spec: HatSkeletonSpec): number {
  const angles =
    spec.seamAnglesRad !== null
      ? Float64Array.from(spec.seamAnglesRad)
      : panelSeamAngles(spec.nSeams);
  const half = effectiveVisorHalfSpanRad(spec.visor, spec.nSeams, angles);
  const poly = visorOuterPolyline(spec.semiAxisX, spec.semiAxisY, spec.yawRad, {
    ...spec.visor,
    halfSpanRad: half,
  });
  return polylineLength(poly);
}

/**
 * Visor length: distance from the center-front rim attach point to the center of the visor
 * outer edge — i.e. how far the visor sticks out from the hat base.
 */
export function visorLengthFromSpec(spec: HatSkeletonSpec): number {
  const c = spec.visor.attachAngleRad;
  const rimCenter = sweatbandPoint(c, spec.semiAxisX, spec.semiAxisY, spec.yawRad);
  const angles =
    spec.seamAnglesRad !== null
      ? Float64Array.from(spec.seamAnglesRad)
      : panelSeamAngles(spec.nSeams);
  const half = effectiveVisorHalfSpanRad(spec.visor, spec.nSeams, angles);
  const poly = visorOuterPolyline(spec.semiAxisX, spec.semiAxisY, spec.yawRad, {
    ...spec.visor,
    halfSpanRad: half,
  });
  if (poly.length === 0) return 0;
  const midIdx = Math.floor(poly.length / 2);
  const visorCenter = poly[midIdx]!;
  const dx = visorCenter[0] - rimCenter[0];
  const dy = visorCenter[1] - rimCenter[1];
  const dz = visorCenter[2] - rimCenter[2];
  return Math.hypot(dx, dy, dz);
}

/**
 * Visor width (span): chord distance between left and right visor rim attach points.
 */
export function visorSpanFromSpec(spec: HatSkeletonSpec): number {
  const c = spec.visor.attachAngleRad;
  const angles =
    spec.seamAnglesRad !== null
      ? Float64Array.from(spec.seamAnglesRad)
      : panelSeamAngles(spec.nSeams);
  const half = effectiveVisorHalfSpanRad(spec.visor, spec.nSeams, angles);
  const left = sweatbandPoint(c - half, spec.semiAxisX, spec.semiAxisY, spec.yawRad);
  const right = sweatbandPoint(c + half, spec.semiAxisX, spec.semiAxisY, spec.yawRad);
  return Math.hypot(right[0] - left[0], right[1] - left[1], right[2] - left[2]);
}

/**
 * Min and max achievable visor span (chord) for the current spec.
 * Min = span at outset 0 (front panel seams minus inset).
 * Max = peak of the unimodal span-vs-outset curve (attach points at widest ellipse chord).
 */
export function visorSpanRange(spec: HatSkeletonSpec): { min: number; max: number } {
  const c = spec.visor.attachAngleRad;
  const angles =
    spec.seamAnglesRad !== null
      ? Float64Array.from(spec.seamAnglesRad)
      : panelSeamAngles(spec.nSeams);
  const { lo, hi } = frontPanelRimThetaBounds(spec.nSeams, angles);
  const frontHalf = 0.5 * (hi - lo);
  const inset = Math.max(0, spec.visor.rimInsetBehindSeamRad);

  const chordAt = (halfAngle: number) => {
    const left = sweatbandPoint(c - halfAngle, spec.semiAxisX, spec.semiAxisY, spec.yawRad);
    const right = sweatbandPoint(c + halfAngle, spec.semiAxisX, spec.semiAxisY, spec.yawRad);
    return Math.hypot(right[0] - left[0], right[1] - left[1], right[2] - left[2]);
  };

  const minHalf = Math.max(0.015, frontHalf - inset);
  const minSpan = chordAt(minHalf);

  let peakSpan = minSpan;
  const SAMPLES = 64;
  for (let i = 1; i <= SAMPLES; i++) {
    const h = minHalf + (i / SAMPLES) * (Math.PI - minHalf);
    const s = chordAt(h);
    if (s > peakSpan) peakSpan = s;
    else break;
  }

  return { min: minSpan, max: peakSpan };
}

/** Which seam indices belong to each mirrored group (for length targets). */
export function seamGroupIndices(
  nSeams: PanelCount
): { front: number[]; sideFront: number[]; sideBack: number[]; rear: number[] } {
  if (nSeams === 6) {
    return {
      front: [1],
      sideFront: [0, 2],
      sideBack: [3, 5],
      rear: [4],
    };
  }
  return {
    front: [0, 1],
    sideFront: [2, 4],
    sideBack: [],
    rear: [3],
  };
}

/**
 * Representative lengths per group: average length of seams in that group.
 */
export function seamGroupLengthsFromSpec(spec: HatSkeletonSpec): {
  front: number;
  sideFront: number;
  sideBack: number;
  rear: number;
} {
  const L = seamArcLengthsFromSpec(spec);
  const g = seamGroupIndices(spec.nSeams);
  const avg = (idx: number[]) =>
    idx.length === 0
      ? 0
      : idx.reduce((s, i) => s + L[i]!, 0) / idx.length;
  return {
    front: avg(g.front),
    sideFront: avg(g.sideFront),
    sideBack: avg(g.sideBack),
    rear: avg(g.rear),
  };
}

/** Forward-compute targets from a resolved spec (for UI defaults / round-trip). */
export function measurementTargetsFromSpec(
  spec: HatSkeletonSpec
): HatMeasurementTargets {
  const cg = seamGroupLengthsFromSpec(spec);
  const frontLen = cg.front;
  return {
    baseCircumferenceM: sweatbandCircumference(
      spec.semiAxisX,
      spec.semiAxisY,
      spec.yawRad,
      512
    ),
    visorLengthM: visorLengthFromSpec(spec),
    visorWidthM: visorSpanFromSpec(spec),
    frontSeamMode: "curve",
    seamEdgeLengthFrontM: frontLen,
    seamFrontBaseLengthM: frontLen * 0.5,
    seamFrontTopLengthM: frontLen * 0.5,
    frontSplitBlend: 1.0,
    seamEdgeLengthSideFrontM: cg.sideFront,
    seamEdgeLengthSideBackM: cg.sideBack,
    seamEdgeLengthRearM: cg.rear,
  };
}
