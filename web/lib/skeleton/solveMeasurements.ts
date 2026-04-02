import type { HatMeasurementTargets, HatSkeletonSpec, PanelCount } from "./types";
import { mergeHatSpecDefaults, MIN_TOP_RIM_FRACTION_WITH_FRONT_VSPLIT } from "./types";
import {
  measurementTargetsFromSpec,
  seamGroupIndices,
  sweatbandCircumference,
  visorLengthFromSpec,
  visorSpanFromSpec,
} from "./measurements";
import {
  panelSeamAngles,
  solveVPoint,
  sweatbandPoint,
  topRimPoint,
  type Vec3,
} from "./geometry";

const S_SCALE_LO = 0.02;
const S_SCALE_HI = 0.55;
const PROJ_LO = 0.001;
const PROJ_HI = 0.45;
const BISECT_ITERS = 56;

/** `f` increasing in x; find x in [lo,hi] with f(x) ≈ target. */
function bisectionIncreasing(
  f: (x: number) => number,
  target: number,
  lo: number,
  hi: number
): number {
  const fLo = f(lo);
  const fHi = f(hi);
  if (fLo >= target) return lo;
  if (fHi <= target) return hi;
  let a = lo;
  let b = hi;
  for (let i = 0; i < BISECT_ITERS; i++) {
    const mid = 0.5 * (a + b);
    const fm = f(mid);
    if (Math.abs(fm - target) < 1e-7) return mid;
    if (fm >= target) b = mid;
    else a = mid;
  }
  return 0.5 * (a + b);
}

/**
 * Stage A: scale both semi-axes uniformly (preserving current Y/X ratio)
 * so that perimeter ≈ target circumference.
 */
export function solveSemiAxesForCircumference(
  spec: HatSkeletonSpec,
  circumferenceTarget: number
): { semiAxisX: number; semiAxisY: number } {
  const ratio = spec.semiAxisY / Math.max(1e-9, spec.semiAxisX);
  const C = Math.max(0.08, circumferenceTarget);
  const yaw = spec.yawRad;
  const f = (s: number) => sweatbandCircumference(s, ratio * s, yaw, 512);
  const s = bisectionIncreasing(f, C, S_SCALE_LO, S_SCALE_HI);
  return { semiAxisX: s, semiAxisY: ratio * s };
}

/**
 * Stage B1: adjust `visor.projection` so visor length (rim → center outer edge) ≈ target.
 */
export function solveVisorProjectionForLength(
  spec: HatSkeletonSpec,
  lengthTarget: number
): number {
  const T = Math.max(0.005, lengthTarget);
  const f = (b: number) =>
    visorLengthFromSpec({ ...spec, visor: { ...spec.visor, projection: b } });
  const loV = f(PROJ_LO);
  const hiV = f(PROJ_HI);
  if (T <= loV) return PROJ_LO;
  if (T >= hiV) return PROJ_HI;
  return bisectionIncreasing(f, T, PROJ_LO, PROJ_HI);
}

/**
 * Stage B2: adjust `visor.rimOutsetBeyondSeamRad` so the left-to-right span ≈ target.
 * `halfSpanRad` is set to π so it doesn't constrain; the effective span is driven by outset.
 *
 * Span vs outset is unimodal (rises then falls as attach points wrap around the ellipse),
 * so we first find the peak, then bisect in the increasing region [0, peakOutset].
 */
export function solveVisorOutsetForSpan(
  spec: HatSkeletonSpec,
  spanTarget: number
): number {
  const T = Math.max(0.01, spanTarget);
  const f = (outset: number) =>
    visorSpanFromSpec({
      ...spec,
      visor: {
        ...spec.visor,
        rimOutsetBeyondSeamRad: outset,
        halfSpanRad: Math.PI,
      },
    });

  const PEAK_SAMPLES = 64;
  const MAX_OUTSET = Math.PI;
  let peakOutset = 0;
  let peakVal = f(0);
  for (let i = 1; i <= PEAK_SAMPLES; i++) {
    const o = (i / PEAK_SAMPLES) * MAX_OUTSET;
    const v = f(o);
    if (v > peakVal) {
      peakVal = v;
      peakOutset = o;
    }
  }

  if (T >= peakVal) return peakOutset;
  if (T <= f(0)) return 0;
  return bisectionIncreasing(f, T, 0, peakOutset);
}

/**
 * Stage C: assign target arc length per seam index (cubic λ-solve in `buildSkeleton`).
 * Mirrored seams in a group share the same length target.
 */
function seamTargetArcLengthsFromGroups(
  nSeams: import("./types").PanelCount,
  targets: { front: number; sideFront: number; sideBack: number; rear: number }
): (number | null)[] {
  const g = seamGroupIndices(nSeams);
  const out: (number | null)[] = new Array(nSeams).fill(null);
  const set = (indices: number[], len: number) => {
    if (indices.length === 0 || len <= 0) return;
    for (const i of indices) out[i] = len;
  };
  set(g.front, targets.front);
  set(g.sideFront, targets.sideFront);
  set(g.sideBack, targets.sideBack);
  set(g.rear, targets.rear);
  return out;
}

/**
 * Apply measurement targets in priority order:
 * 1. Base circumference → uniform scale of semi-axes (preserves Y/X ratio)
 * 2. Visor length → solve projection
 * 3. Visor width → solve rimOutsetBeyondSeamRad (left-to-right span)
 * 4. Seam arc lengths per group → `seamTargetArcLengthM` (cubic λ-solve in build)
 * 5. Front V-split: compute V-point from two straight-line lengths (when split mode)
 */
export function solveHatSpecFromMeasurements(
  shapeSpec: HatSkeletonSpec,
  targets: HatMeasurementTargets
): HatSkeletonSpec {
  let spec = mergeHatSpecDefaults(shapeSpec);

  const { semiAxisX, semiAxisY } = solveSemiAxesForCircumference(
    spec,
    targets.baseCircumferenceM
  );
  spec = { ...spec, semiAxisX, semiAxisY };

  const projection = solveVisorProjectionForLength(spec, targets.visorLengthM);
  spec = { ...spec, visor: { ...spec.visor, projection } };

  const outset = solveVisorOutsetForSpan(spec, targets.visorWidthM);
  spec = {
    ...spec,
    visor: { ...spec.visor, rimOutsetBeyondSeamRad: outset, halfSpanRad: Math.PI },
  };

  const isSplit = targets.frontSeamMode === "split";

  const frontTarget = isSplit
    ? targets.seamFrontBaseLengthM + targets.seamFrontTopLengthM
    : targets.seamEdgeLengthFrontM;

  const seamTargetArcLengthM = seamTargetArcLengthsFromGroups(spec.nSeams, {
    front: frontTarget,
    sideFront: targets.seamEdgeLengthSideFrontM,
    sideBack: targets.seamEdgeLengthSideBackM,
    rear: targets.seamEdgeLengthRearM,
  });
  spec = {
    ...spec,
    seamSquarenessOverrides: [],
    seamTargetArcLengthM,
    seamCurveMode: "squareness",
  };

  if (isSplit) {
    const topFrac = Math.max(spec.topRimFraction ?? 0, MIN_TOP_RIM_FRACTION_WITH_FRONT_VSPLIT);
    spec = { ...spec, topRimFraction: topFrac };
    const angles =
      spec.seamAnglesRad !== null
        ? Float64Array.from(spec.seamAnglesRad)
        : panelSeamAngles(spec.nSeams);
    const frontIdx = spec.nSeams === 6 ? 1 : 0;
    const rim = sweatbandPoint(angles[frontIdx]!, spec.semiAxisX, spec.semiAxisY, spec.yawRad);
    const top: Vec3 =
      topFrac <= 1e-12
        ? [0, 0, spec.crownHeight]
        : topRimPoint(angles[frontIdx]!, spec.semiAxisX, spec.semiAxisY, spec.yawRad, spec.crownHeight, topFrac);

    const vPoint = solveVPoint(rim, top, targets.seamFrontBaseLengthM, targets.seamFrontTopLengthM);
    spec = {
      ...spec,
      frontVSplit: {
        vPoint: vPoint as [number, number, number],
        blend: targets.frontSplitBlend,
        baseLengthM: targets.seamFrontBaseLengthM,
        topLengthM: targets.seamFrontTopLengthM,
        legBottomStrength: spec.frontVSplit?.legBottomStrength ?? 0,
        legTopStrength: spec.frontVSplit?.legTopStrength ?? 0,
      },
    };
  } else {
    spec = { ...spec, frontVSplit: null };
  }

  return mergeHatSpecDefaults(spec);
}

/** Metres / dimensionless; skip solver work when nothing material changed. */
const MT_EPS_M = 0.00005;

function mChanged(a: number, b: number): boolean {
  return Math.abs(a - b) > MT_EPS_M;
}

/**
 * True when `next` measurement inputs are identical to `lastApplied` for solver purposes.
 */
export function measurementTargetsEqualApprox(
  a: HatMeasurementTargets,
  b: HatMeasurementTargets
): boolean {
  if (a.frontSeamMode !== b.frontSeamMode) return false;
  if (mChanged(a.baseCircumferenceM, b.baseCircumferenceM)) return false;
  if (mChanged(a.visorLengthM, b.visorLengthM)) return false;
  if (mChanged(a.visorWidthM, b.visorWidthM)) return false;
  if (mChanged(a.seamEdgeLengthFrontM, b.seamEdgeLengthFrontM)) return false;
  if (mChanged(a.seamFrontBaseLengthM, b.seamFrontBaseLengthM)) return false;
  if (mChanged(a.seamFrontTopLengthM, b.seamFrontTopLengthM)) return false;
  if (mChanged(a.frontSplitBlend, b.frontSplitBlend)) return false;
  if (mChanged(a.seamEdgeLengthSideFrontM, b.seamEdgeLengthSideFrontM)) return false;
  if (mChanged(a.seamEdgeLengthSideBackM, b.seamEdgeLengthSideBackM)) return false;
  if (mChanged(a.seamEdgeLengthRearM, b.seamEdgeLengthRearM)) return false;
  return true;
}

/**
 * Skip re-running the measurement solver when the UI targets match what we last applied and the
 * current spec already matches those targets (avoids redundant work when the user has not changed
 * measurements, or catches drift after manual edits).
 */
export function shouldSkipMeasurementSolve(
  spec: HatSkeletonSpec,
  lastAppliedMeasurementTargets: HatMeasurementTargets | null,
  nextMeasurementTargets: HatMeasurementTargets
): boolean {
  if (lastAppliedMeasurementTargets === null) return false;
  if (!measurementTargetsEqualApprox(lastAppliedMeasurementTargets, nextMeasurementTargets)) {
    return false;
  }
  return measurementTargetsEqualApprox(measurementTargetsFromSpec(spec), nextMeasurementTargets);
}

/** True when `solveHatSpecFromMeasurements` must run (split, mode change, or split fields). */
function needsFullMeasurementSolve(
  prev: HatMeasurementTargets | null,
  next: HatMeasurementTargets
): boolean {
  if (prev === null) return true;
  if (prev.frontSeamMode !== next.frontSeamMode) return true;
  if (next.frontSeamMode === "split" || prev.frontSeamMode === "split") return true;
  return false;
}

function mergeSeamArcLengthsByGroupChanges(
  prevSpec: HatSkeletonSpec,
  fullNext: (number | null)[],
  prevTargets: HatMeasurementTargets,
  nextTargets: HatMeasurementTargets,
  nSeams: PanelCount
): (number | null)[] {
  const prevArr = prevSpec.seamTargetArcLengthM;
  if (!prevArr || prevArr.length !== nSeams) {
    return [...fullNext];
  }
  const g = seamGroupIndices(nSeams);
  const out: (number | null)[] = new Array(nSeams).fill(null);
  const takeFromFull = (indices: number[], groupChanged: boolean) => {
    for (const i of indices) {
      out[i] = groupChanged ? fullNext[i]! : prevArr[i] ?? fullNext[i]!;
    }
  };
  takeFromFull(
    g.front,
    mChanged(prevTargets.seamEdgeLengthFrontM, nextTargets.seamEdgeLengthFrontM)
  );
  takeFromFull(
    g.sideFront,
    mChanged(prevTargets.seamEdgeLengthSideFrontM, nextTargets.seamEdgeLengthSideFrontM)
  );
  takeFromFull(
    g.sideBack,
    mChanged(prevTargets.seamEdgeLengthSideBackM, nextTargets.seamEdgeLengthSideBackM)
  );
  takeFromFull(
    g.rear,
    mChanged(prevTargets.seamEdgeLengthRearM, nextTargets.seamEdgeLengthRearM)
  );
  return out;
}

/**
 * Apply measurement targets with minimal recomputation: only run semi-axes / visor bisection
 * when those inputs change; only overwrite `seamTargetArcLengthM` for seam groups whose
 * target length changed.
 *
 * Falls back to {@link solveHatSpecFromMeasurements} when front split mode is involved or
 * `prevTargets` is null.
 */
export function solveHatSpecFromMeasurementsIncremental(
  prevSpec: HatSkeletonSpec,
  prevTargets: HatMeasurementTargets | null,
  nextTargets: HatMeasurementTargets
): HatSkeletonSpec {
  if (needsFullMeasurementSolve(prevTargets, nextTargets)) {
    return solveHatSpecFromMeasurements(prevSpec, nextTargets);
  }
  const prevT = prevTargets!;
  let spec = mergeHatSpecDefaults(prevSpec);
  const nSeams = spec.nSeams;

  if (mChanged(prevT.baseCircumferenceM, nextTargets.baseCircumferenceM)) {
    const { semiAxisX, semiAxisY } = solveSemiAxesForCircumference(spec, nextTargets.baseCircumferenceM);
    spec = { ...spec, semiAxisX, semiAxisY };
  }

  if (mChanged(prevT.visorLengthM, nextTargets.visorLengthM)) {
    const projection = solveVisorProjectionForLength(spec, nextTargets.visorLengthM);
    spec = { ...spec, visor: { ...spec.visor, projection } };
  }

  if (mChanged(prevT.visorWidthM, nextTargets.visorWidthM)) {
    const outset = solveVisorOutsetForSpan(spec, nextTargets.visorWidthM);
    spec = {
      ...spec,
      visor: { ...spec.visor, rimOutsetBeyondSeamRad: outset, halfSpanRad: Math.PI },
    };
  }

  const fullNext = seamTargetArcLengthsFromGroups(nSeams, {
    front: nextTargets.seamEdgeLengthFrontM,
    sideFront: nextTargets.seamEdgeLengthSideFrontM,
    sideBack: nextTargets.seamEdgeLengthSideBackM,
    rear: nextTargets.seamEdgeLengthRearM,
  });

  const merged = mergeSeamArcLengthsByGroupChanges(spec, fullNext, prevT, nextTargets, nSeams);

  spec = {
    ...spec,
    seamSquarenessOverrides: [],
    seamTargetArcLengthM: merged,
    seamCurveMode: "squareness",
    frontVSplit: null,
  };

  return mergeHatSpecDefaults(spec);
}
