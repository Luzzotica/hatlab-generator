import type { HatMeasurementTargets, HatSkeletonSpec } from "./types";
import { mergeHatSpecDefaults, MIN_TOP_RIM_FRACTION_WITH_FRONT_VSPLIT } from "./types";
import {
  seamGroupIndices,
  sweatbandCircumference,
  visorLengthFromSpec,
  visorSpanFromSpec,
} from "./measurements";
import {
  arcLengthOfSeamQuadratic,
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
 * Stage C: for each seam group independently, solve squareness (bulge)
 * so that the arc length of each seam matches the target. Other groups
 * are unaffected because each solve only touches that group's bulge.
 */
function solveSquarenessForTargetArcLength(
  rim: Vec3,
  top: Vec3,
  target: number
): number {
  const L0 = arcLengthOfSeamQuadratic(rim, top, 0);
  if (target <= L0) return 0;
  const L1 = arcLengthOfSeamQuadratic(rim, top, 1);
  if (target >= L1) return 1;
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < BISECT_ITERS; i++) {
    const mid = 0.5 * (lo + hi);
    const L = arcLengthOfSeamQuadratic(rim, top, mid);
    if (L < target) lo = mid;
    else hi = mid;
  }
  return 0.5 * (lo + hi);
}

function solveSeamGroupSquareness(
  spec: HatSkeletonSpec,
  targets: { front: number; sideFront: number; sideBack: number; rear: number }
): (number | null)[] {
  const angles =
    spec.seamAnglesRad !== null
      ? Float64Array.from(spec.seamAnglesRad)
      : panelSeamAngles(spec.nSeams);
  const topFrac = spec.topRimFraction;
  const apex: Vec3 = [0, 0, spec.crownHeight];

  const rimOf = (i: number): Vec3 =>
    sweatbandPoint(angles[i]!, spec.semiAxisX, spec.semiAxisY, spec.yawRad);

  const topOf = (i: number): Vec3 => {
    if (topFrac <= 1e-12) return apex;
    return topRimPoint(
      angles[i]!,
      spec.semiAxisX,
      spec.semiAxisY,
      spec.yawRad,
      spec.crownHeight,
      topFrac
    );
  };

  const g = seamGroupIndices(spec.nSeams);
  const overrides: (number | null)[] = new Array(spec.nSeams).fill(null);

  const solveGroup = (indices: number[], target: number) => {
    if (indices.length === 0 || target <= 0) return;
    for (const i of indices) {
      const s = solveSquarenessForTargetArcLength(rimOf(i), topOf(i), target);
      overrides[i] = s;
    }
  };

  solveGroup(g.front, targets.front);
  solveGroup(g.sideFront, targets.sideFront);
  solveGroup(g.sideBack, targets.sideBack);
  solveGroup(g.rear, targets.rear);

  return overrides;
}

/**
 * Apply measurement targets in priority order:
 * 1. Base circumference → uniform scale of semi-axes (preserves Y/X ratio)
 * 2. Visor length → solve projection
 * 3. Visor width → solve rimOutsetBeyondSeamRad (left-to-right span)
 * 4. Seam arc lengths per group → solve per-seam squareness (independent)
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

  const overrides = solveSeamGroupSquareness(spec, {
    front: frontTarget,
    sideFront: targets.seamEdgeLengthSideFrontM,
    sideBack: targets.seamEdgeLengthSideBackM,
    rear: targets.seamEdgeLengthRearM,
  });
  spec = {
    ...spec,
    seamSquarenessOverrides: overrides,
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
      },
    };
  } else {
    spec = { ...spec, frontVSplit: null };
  }

  return mergeHatSpecDefaults(spec);
}
