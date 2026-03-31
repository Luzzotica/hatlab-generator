import { describe, expect, it } from "vitest";
import { defaultHatSkeletonSpec, mergeHatSpecDefaults } from "./types";
import type { HatMeasurementTargets } from "./types";
import {
  measurementTargetsFromSpec,
  polylineLength,
  seamGroupLengthsFromSpec,
  sweatbandCircumference,
  visorLengthFromSpec,
  visorSpanFromSpec,
} from "./measurements";
import {
  solveHatSpecFromMeasurements,
  solveSemiAxesForCircumference,
} from "./solveMeasurements";
import { solveVPoint, buildSkeleton, evalSeamCurve } from "./geometry";

describe("sweatbandCircumference", () => {
  it("scales ~linearly with uniform scale (circle-like)", () => {
    const c1 = sweatbandCircumference(0.1, 0.1, 0, 256);
    const c2 = sweatbandCircumference(0.2, 0.2, 0, 256);
    expect(c2 / c1).toBeCloseTo(2, 1);
  });
});

describe("measurementTargetsFromSpec + solve round-trip", () => {
  it("recovers visor length and width approximately", () => {
    const base = mergeHatSpecDefaults(defaultHatSkeletonSpec());
    const t = measurementTargetsFromSpec(base);
    const solved = solveHatSpecFromMeasurements(base, t);
    expect(sweatbandCircumference(solved.semiAxisX, solved.semiAxisY, solved.yawRad)).toBeCloseTo(
      t.baseCircumferenceM,
      2
    );
    expect(visorLengthFromSpec(solved)).toBeCloseTo(t.visorLengthM, 2);
    expect(visorSpanFromSpec(solved)).toBeCloseTo(t.visorWidthM, 2);
  });
});

describe("solveSemiAxesForCircumference", () => {
  it("preserves Y/X ratio and hits circumference", () => {
    const spec = mergeHatSpecDefaults(defaultHatSkeletonSpec());
    const origRatio = spec.semiAxisY / spec.semiAxisX;
    const result = solveSemiAxesForCircumference(spec, 0.75);
    expect(result.semiAxisY / result.semiAxisX).toBeCloseTo(origRatio, 3);
    const c = sweatbandCircumference(result.semiAxisX, result.semiAxisY, spec.yawRad);
    expect(c).toBeCloseTo(0.75, 2);
  });
});

describe("solveHatSpecFromMeasurements per-group independence", () => {
  it("changing one seam group target does not shift others", () => {
    const base = mergeHatSpecDefaults(defaultHatSkeletonSpec());
    const t = measurementTargetsFromSpec(base);

    const tFrontBigger = { ...t, seamEdgeLengthFrontM: t.seamEdgeLengthFrontM * 1.15 };
    const solved = solveHatSpecFromMeasurements(base, tFrontBigger);
    const solvedLengths = seamGroupLengthsFromSpec(solved);

    const origLengths = seamGroupLengthsFromSpec(base);
    expect(solvedLengths.sideFront).toBeCloseTo(origLengths.sideFront, 2);
    expect(solvedLengths.rear).toBeCloseTo(origLengths.rear, 2);
    expect(solvedLengths.front).toBeGreaterThan(origLengths.front);
  });
});

describe("seamGroupLengthsFromSpec", () => {
  it("returns positive lengths for all 4 groups (6-panel)", () => {
    const g = seamGroupLengthsFromSpec(mergeHatSpecDefaults(defaultHatSkeletonSpec()));
    expect(g.front).toBeGreaterThan(0);
    expect(g.sideFront).toBeGreaterThan(0);
    expect(g.sideBack).toBeGreaterThan(0);
    expect(g.rear).toBeGreaterThan(0);
  });
});

describe("polylineLength", () => {
  it("is zero for short polyline", () => {
    expect(polylineLength([[0, 0, 0]])).toBe(0);
  });
});

describe("solveVPoint (triangle solver)", () => {
  it("finds a point at correct distances from rim and top", () => {
    const rim: [number, number, number] = [0.1, 0, 0];
    const top: [number, number, number] = [0, 0, 0.15];
    const Lbase = 0.12;
    const Ltop = 0.1;
    const v = solveVPoint(rim, top, Lbase, Ltop);
    const dRim = Math.hypot(v[0] - rim[0], v[1] - rim[1], v[2] - rim[2]);
    const dTop = Math.hypot(v[0] - top[0], v[1] - top[1], v[2] - top[2]);
    expect(dRim).toBeCloseTo(Lbase, 3);
    expect(dTop).toBeCloseTo(Ltop, 3);
  });

  it("returns midpoint when lengths are too short", () => {
    const rim: [number, number, number] = [0.1, 0, 0];
    const top: [number, number, number] = [0, 0, 0.15];
    const chord = Math.hypot(0.1, 0, 0.15);
    const v = solveVPoint(rim, top, chord * 0.2, chord * 0.2);
    const mid: [number, number, number] = [0.05, 0, 0.075];
    expect(v[0]).toBeCloseTo(mid[0], 5);
    expect(v[1]).toBeCloseTo(mid[1], 5);
    expect(v[2]).toBeCloseTo(mid[2], 5);
  });
});

describe("front V-split round-trip", () => {
  it("produces vSplit seam when frontSeamMode=split", () => {
    const base = mergeHatSpecDefaults(defaultHatSkeletonSpec());
    const t = measurementTargetsFromSpec(base);
    const splitTargets: HatMeasurementTargets = {
      ...t,
      frontSeamMode: "split",
      seamFrontBaseLengthM: t.seamEdgeLengthFrontM * 0.55,
      seamFrontTopLengthM: t.seamEdgeLengthFrontM * 0.55,
      frontSplitBlend: 1.0,
    };
    const solved = solveHatSpecFromMeasurements(base, splitTargets);
    expect(solved.frontVSplit).toBeTruthy();
    expect(solved.frontVSplit!.blend).toBe(1.0);

    const sk = buildSkeleton(solved);
    const frontIdx = solved.nSeams === 6 ? 1 : 0;
    const frontSeam = sk.seamControls[frontIdx]!;
    expect(frontSeam.kind).toBe("vSplit");
  });

  it("blend=0 gives the base Bézier curve", () => {
    const base = mergeHatSpecDefaults(defaultHatSkeletonSpec());
    const t = measurementTargetsFromSpec(base);
    const splitTargets: HatMeasurementTargets = {
      ...t,
      frontSeamMode: "split",
      seamFrontBaseLengthM: t.seamEdgeLengthFrontM * 0.55,
      seamFrontTopLengthM: t.seamEdgeLengthFrontM * 0.55,
      frontSplitBlend: 0,
    };
    const solved = solveHatSpecFromMeasurements(base, splitTargets);
    const sk = buildSkeleton(solved);
    const frontIdx = solved.nSeams === 6 ? 1 : 0;
    const seam = sk.seamControls[frontIdx]!;
    expect(seam.kind).toBe("vSplit");
    if (seam.kind !== "vSplit") return;
    const mid = evalSeamCurve(seam, 0.5);
    const basePt = evalSeamCurve({ kind: "bezier", ctrl: seam.baseCurve }, 0.5);
    expect(mid[0]).toBeCloseTo(basePt[0], 5);
    expect(mid[1]).toBeCloseTo(basePt[1], 5);
    expect(mid[2]).toBeCloseTo(basePt[2], 5);
  });

  it("blend=0 baseCurve uses V-point as control point (convex hull keeps curve inside V)", () => {
    const base = mergeHatSpecDefaults(defaultHatSkeletonSpec());
    const t = measurementTargetsFromSpec(base);
    const splitTargets: HatMeasurementTargets = {
      ...t,
      frontSeamMode: "split",
      seamFrontBaseLengthM: t.seamEdgeLengthFrontM * 0.6,
      seamFrontTopLengthM: t.seamEdgeLengthFrontM * 0.5,
      frontSplitBlend: 0,
    };
    const solved = solveHatSpecFromMeasurements(base, splitTargets);
    const sk = buildSkeleton(solved);
    const frontIdx = solved.nSeams === 6 ? 1 : 0;
    const seam = sk.seamControls[frontIdx]!;
    if (seam.kind !== "vSplit") return;
    expect(seam.baseCurve[1][0]).toBeCloseTo(seam.vPoint[0], 8);
    expect(seam.baseCurve[1][1]).toBeCloseTo(seam.vPoint[1], 8);
    expect(seam.baseCurve[1][2]).toBeCloseTo(seam.vPoint[2], 8);
  });

  it("clears frontVSplit when not in split mode", () => {
    const base = mergeHatSpecDefaults(defaultHatSkeletonSpec());
    const t = measurementTargetsFromSpec(base);
    const solved = solveHatSpecFromMeasurements(base, t);
    expect(solved.frontVSplit).toBeNull();
  });
});
