/** Hat wireframe spec (mirrors former Python HatSkeletonSpec / VisorSpec). */

export type VisorMode = "superellipse" | "circular";

export interface VisorSpec {
  attachAngleRad: number;
  /**
   * Upper bound on half the visor angular span (rad). Actual span is also limited by
   * `frontPanelRimThetaBounds` ± inset/outset (see `effectiveVisorHalfSpanRad`).
   */
  halfSpanRad: number;
  /**
   * Narrows the visor inward from the front-panel side seams (reduces angular span).
   */
  rimInsetBehindSeamRad: number;
  /**
   * Widens the rim attach past the front side seams (rad along θ). Typical ~0.03 so the
   * brim meets the crown just outside the blue seam lines. Omitted → same as default spec.
   */
  rimOutsetBeyondSeamRad?: number;
  projection: number;
  mode: VisorMode;
  superellipseN: number;
  samples: number;
}

/** Only five- and six-panel crowns are supported; seam angles follow cap conventions (see `panelSeamAngles`). */
export type PanelCount = 5 | 6;

/**
 * How seam curves (rim → top) are defined: quadratic bulge (`squareness`), arc-length target
 * on quadratics (`arcLength`), or visor-style superellipse in the seam plane (`superellipse`).
 */
export type SeamCurveMode = "squareness" | "arcLength" | "superellipse";

/**
 * 6-panel seam groups (indices: front center = 1; flanking front = 0,2; back = 3,4,5).
 * When `null`, all seams use `seamSquareness` / per-index overrides only.
 */
export interface SixPanelSeamSquareness {
  /** Seam at +Y (center front ridge). */
  front: number;
  /** Seams immediately left/right of the front seam (indices 0 and 2). */
  sideFront: number;
  /** Remaining three seams (back). */
  back: number;
}

/**
 * Cubic seam endpoint intent (rim → top): strengths scale handle lengths before λ enforces arc length.
 * Bottom angle mixes vertical (+Z in seam plane) vs outward +v when plane lock is on; chord +u vs +v when off.
 * With plane lock, the top handle uses horizontal radial outward (in XY, projected into the seam plane).
 */
export interface SeamEndpointStyle {
  /** Scale on the rim → P1 handle (before λ). */
  bottomStrength: number;
  /**
   * Angle in seam plane between “vertical” and outward bulge (+v): with plane lock, 0 = +Z
   * projected into the seam plane (straight up at the rim); π/2 = pure +v. Without lock, 0 = chord +u.
   */
  bottomAngleRad: number;
  /** Scale on the P2 → top handle (before λ). */
  topStrength: number;
  /** When plane lock is off: angle in seam plane for (P3−P2). Ignored at top when lock is on. */
  topAngleRad: number;
  /** If true: bottom uses angles in seam plane; top uses horizontal-out (projected). If false: full 3D. */
  lockAnglesToSeamPlane: boolean;
}

/**
 * 5-panel: the two front panel edges (seam 0 & 1) split into a lower (visor) and upper (crown) curve.
 * `splitT` is the fraction along rim→apex where the two quadratics meet.
 */
export interface FivePanelFrontSeams {
  /** Bulge on the rim → split segment (toward visor). */
  visor: number;
  /** Bulge on the split → apex segment (crown toward button). */
  crown: number;
  /** Where the two segments meet (0–1 along the overall seam). */
  splitT: number;
}

/** How the front seam arc length is specified. */
export type FrontSeamMode = "curve" | "split";

/** Primary physical targets for `solveHatSpecFromMeasurements` (metres). */
export interface HatMeasurementTargets {
  /** Sweatband ellipse perimeter. Solver scales both axes uniformly (preserving current ratio). */
  baseCircumferenceM: number;
  /** Visor length: distance from rim center-front to the center of the visor outer edge. */
  visorLengthM: number;
  /** Visor width: chord distance between left and right rim attach points (left-to-right span). */
  visorWidthM: number;
  /** Front seam mode: "curve" = single arc length, "split" = two segments (base + top). */
  frontSeamMode: FrontSeamMode;
  /** Rim → top seam arc length for the front center seam (used when frontSeamMode === "curve"). */
  seamEdgeLengthFrontM: number;
  /** Base → V-point straight-line length (used when frontSeamMode === "split"). */
  seamFrontBaseLengthM: number;
  /** V-point → top straight-line length (used when frontSeamMode === "split"). */
  seamFrontTopLengthM: number;
  /** 0 = original smooth curve, 1 = full V-shape (two straight segments). */
  frontSplitBlend: number;
  /** Mirrored side-front seams (6-panel 0,2; 5-panel 2,4). */
  seamEdgeLengthSideFrontM: number;
  /** Mirrored side-back seams (6-panel 3,5; 5-panel: not used). */
  seamEdgeLengthSideBackM: number;
  /** Rear center seam (6-panel 4; 5-panel 3). */
  seamEdgeLengthRearM: number;
}

export interface HatSkeletonSpec {
  semiAxisX: number;
  semiAxisY: number;
  yawRad: number;
  nSeams: PanelCount;
  seamAnglesRad: number[] | null;
  crownHeight: number;
  /**
   * Radius of the flat button ring at the crown top, as a fraction of sweatband semi-axes.
   * Seams end on this ellipse (z = crownHeight) so they meet horizontally like a real cap.
   * Use 0 for a single-point apex (sharp cone — not typical for hats).
   */
  topRimFraction: number;
  seamCurveMode: SeamCurveMode;
  /**
   * Target seam arc length = chord(rim, top) × multiplier. Used when `seamCurveMode === 'arcLength'`.
   * 1 = straight (minimal arc length for this Bézier family); larger values increase bulge.
   */
  seamArcLengthMultiplier: number;
  /**
   * Superellipse exponent for `seamCurveMode === 'superellipse'` (same family as visor: 2 ≈ ellipse, 3 ≈ squircle).
   */
  seamSuperellipseN: number;
  seamSquareness: number;
  seamSquarenessOverrides: (number | null)[];
  /**
   * Per-seam cubic endpoint style (bulge mode). If shorter than `nSeams`, missing entries default
   * from `seamSquareness` / overrides / sixPanelSeams.
   */
  seamEndpointStyles: SeamEndpointStyle[];
  /**
   * Optional resolved arc length per seam (m). When set (e.g. by measurement solver), cubic seams
   * scale handles with λ to match this length.
   */
  seamTargetArcLengthM: (number | null)[];
  /** 6-panel: optional grouped bulge per seam region. */
  sixPanelSeams: SixPanelSeamSquareness | null;
  /** 5-panel: split front edge curves (seams 0 and 1). Set to null to use a single bulge per seam. */
  fivePanelFrontSeams: FivePanelFrontSeams | null;
  /**
   * 5-panel only: decorative center seam from the apex toward the front rim; length as a
   * fraction of the straight segment apex → front rim (0 = off). Real caps often stop ~⅓ down.
   */
  fivePanelCenterSeamLength: number;
  /**
   * V-split data for the front seam (6-panel: seam 1). When set, `buildSkeleton` uses a
   * piecewise-linear V path blended with the base curve. Set by the measurement solver
   * when `frontSeamMode === "split"`.
   */
  frontVSplit?: {
    vPoint: [number, number, number];
    blend: number;
    baseLengthM: number;
    topLengthM: number;
    /** Quadratic bulge on rim → V leg (angles fixed by the V). Omitted → 0. */
    legBottomStrength?: number;
    /** Quadratic bulge on V → top leg. Omitted → 0. */
    legTopStrength?: number;
  } | null;
  /**
   * When true, subtract a fixed rectangular opening (3" × 2.75") at the rear center seam on the crown mesh.
   */
  backClosureOpening: boolean;
  /**
   * Radial inward groove depth at panel seams on the outer crown (metres). The crown shell is ~2 mm
   * thick; the inner surface follows with a smooth falloff so the seam reads as rounded inward.
   * Typical ~0.0005 (0.5 mm).
   */
  seamGrooveDepthM: number;
  visor: VisorSpec;
}

export const defaultVisorSpec = (): VisorSpec => ({
  attachAngleRad: 0.5 * Math.PI,
  /** Large enough that the seam-based cap (below) usually applies, not this value. */
  halfSpanRad: 1.25,
  rimInsetBehindSeamRad: 0,
  rimOutsetBeyondSeamRad: 0.035,
  projection: 0.12,
  mode: "superellipse",
  superellipseN: 3,
  samples: 48,
});

export const defaultHatSkeletonSpec = (): HatSkeletonSpec => ({
  semiAxisX: 0.095,
  semiAxisY: 0.11,
  yawRad: 0,
  nSeams: 6,
  seamAnglesRad: null,
  crownHeight: 0.11,
  topRimFraction: 0,
  seamCurveMode: "squareness",
  seamArcLengthMultiplier: 1.12,
  seamSuperellipseN: 3,
  seamSquareness: 0.35,
  seamSquarenessOverrides: [],
  seamEndpointStyles: [],
  seamTargetArcLengthM: [0.165, 0.175, 0.165, 0.165, 0.175, 0.165],
  sixPanelSeams: null,
  fivePanelFrontSeams: { visor: 0.35, crown: 0.35, splitT: 0.45 },
  fivePanelCenterSeamLength: 1.0,
  backClosureOpening: false,
  seamGrooveDepthM: 0.0005,
  visor: defaultVisorSpec(),
});

/** Minimum top button ring when front V-split is active (seams end on an arc, not a point). */
export const MIN_TOP_RIM_FRACTION_WITH_FRONT_VSPLIT = 0.048;

/** Fills fields added over time (e.g. from stale React state or partial objects). */
export function mergeHatSpecDefaults(spec: HatSkeletonSpec): HatSkeletonSpec {
  const d = defaultHatSkeletonSpec();
  let topRimFraction = spec.topRimFraction ?? d.topRimFraction;
  if (spec.frontVSplit != null) {
    topRimFraction = Math.max(topRimFraction, MIN_TOP_RIM_FRACTION_WITH_FRONT_VSPLIT);
  }
  return {
    ...d,
    ...spec,
    seamCurveMode: spec.seamCurveMode ?? d.seamCurveMode,
    seamArcLengthMultiplier: spec.seamArcLengthMultiplier ?? d.seamArcLengthMultiplier,
    seamSuperellipseN: spec.seamSuperellipseN ?? d.seamSuperellipseN,
    topRimFraction,
    backClosureOpening: spec.backClosureOpening ?? d.backClosureOpening,
    seamEndpointStyles: spec.seamEndpointStyles ?? d.seamEndpointStyles,
    seamTargetArcLengthM: spec.seamTargetArcLengthM ?? d.seamTargetArcLengthM,
    seamGrooveDepthM: spec.seamGrooveDepthM ?? d.seamGrooveDepthM,
    visor: { ...d.visor, ...spec.visor },
  };
}

export function validateSpec(spec: HatSkeletonSpec): void {
  if (spec.nSeams !== 5 && spec.nSeams !== 6) {
    throw new Error("nSeams must be 5 or 6");
  }
  if (spec.seamAnglesRad !== null && spec.seamAnglesRad.length !== spec.nSeams) {
    throw new Error("seamAnglesRad length must match nSeams");
  }
  const o = spec.seamSquarenessOverrides;
  if (o.length > 0 && o.length !== spec.nSeams) {
    throw new Error("seamSquarenessOverrides length must match nSeams");
  }
  const eps = spec.seamEndpointStyles;
  if (eps.length > 0 && eps.length !== spec.nSeams) {
    throw new Error("seamEndpointStyles length must match nSeams or be empty");
  }
  const st = spec.seamTargetArcLengthM;
  if (st.length > 0 && st.length !== spec.nSeams) {
    throw new Error("seamTargetArcLengthM length must match nSeams or be empty");
  }
  if (spec.visor.rimInsetBehindSeamRad < 0) {
    throw new Error("rimInsetBehindSeamRad must be >= 0");
  }
  if ((spec.visor.rimOutsetBeyondSeamRad ?? 0.035) < 0) {
    throw new Error("rimOutsetBeyondSeamRad must be >= 0");
  }
  if (
    spec.fivePanelCenterSeamLength < 0 ||
    spec.fivePanelCenterSeamLength > 1
  ) {
    throw new Error("fivePanelCenterSeamLength must be in [0, 1]");
  }
  if (spec.sixPanelSeams) {
    const m = spec.sixPanelSeams;
    for (const k of ["front", "sideFront", "back"] as const) {
      const v = m[k];
      if (v < 0 || v > 1) throw new Error(`sixPanelSeams.${k} must be in [0, 1]`);
    }
  }
  if (spec.fivePanelFrontSeams !== null) {
    const f = spec.fivePanelFrontSeams;
    if (f.visor < 0 || f.visor > 1 || f.crown < 0 || f.crown > 1) {
      throw new Error("fivePanelFrontSeams visor/crown must be in [0, 1]");
    }
    if (f.splitT <= 0 || f.splitT >= 1) {
      throw new Error("fivePanelFrontSeams.splitT must be in (0, 1)");
    }
  }
  if (spec.topRimFraction < 0 || spec.topRimFraction > 0.35) {
    throw new Error("topRimFraction must be in [0, 0.35]");
  }
  const g = spec.seamGrooveDepthM ?? defaultHatSkeletonSpec().seamGrooveDepthM;
  if (g < 0 || g > 0.003) {
    throw new Error("seamGrooveDepthM must be in [0, 0.003]");
  }
  if (
    spec.seamCurveMode !== "squareness" &&
    spec.seamCurveMode !== "arcLength" &&
    spec.seamCurveMode !== "superellipse"
  ) {
    throw new Error("seamCurveMode must be squareness, arcLength, or superellipse");
  }
  if (spec.seamArcLengthMultiplier < 1 || spec.seamArcLengthMultiplier > 2.5) {
    throw new Error("seamArcLengthMultiplier must be in [1, 2.5]");
  }
  const seamN = spec.seamSuperellipseN ?? defaultHatSkeletonSpec().seamSuperellipseN;
  if (seamN < 2 || seamN > 10) {
    throw new Error("seamSuperellipseN must be in [2, 10]");
  }
}
