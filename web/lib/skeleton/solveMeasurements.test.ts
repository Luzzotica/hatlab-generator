import { describe, expect, it } from "vitest";
import { measurementTargetsFromSpec, seamGroupIndices } from "./measurements";
import {
  measurementTargetsEqualApprox,
  solveHatSpecFromMeasurements,
  solveHatSpecFromMeasurementsIncremental,
} from "./solveMeasurements";
import { defaultHatSkeletonSpec, mergeHatSpecDefaults, type HatMeasurementTargets } from "./types";

describe("solveHatSpecFromMeasurementsIncremental", () => {
  it("only updates seam arc lengths for groups whose target changed", () => {
    const base0 = mergeHatSpecDefaults(defaultHatSkeletonSpec());
    const mt0 = measurementTargetsFromSpec(base0);
    const spec0 = mergeHatSpecDefaults(solveHatSpecFromMeasurements(base0, mt0));
    const g = seamGroupIndices(6);
    const rearIdx = g.rear[0]!;
    const sideFrontIdx = g.sideFront[0]!;
    const mt1: HatMeasurementTargets = {
      ...mt0,
      seamEdgeLengthSideFrontM: mt0.seamEdgeLengthSideFrontM + 0.012,
    };
    const spec1 = mergeHatSpecDefaults(
      solveHatSpecFromMeasurementsIncremental(spec0, mt0, mt1)
    );
    expect(spec1.seamTargetArcLengthM[rearIdx]).toBe(spec0.seamTargetArcLengthM[rearIdx]);
    expect(spec1.seamTargetArcLengthM[sideFrontIdx]).not.toBe(
      spec0.seamTargetArcLengthM[sideFrontIdx]
    );
  });

  it("matches full solve for curve-only edits", () => {
    const base0 = mergeHatSpecDefaults(defaultHatSkeletonSpec());
    const mt0 = measurementTargetsFromSpec(base0);
    const spec0 = mergeHatSpecDefaults(solveHatSpecFromMeasurements(base0, mt0));
    const mt1: HatMeasurementTargets = {
      ...mt0,
      seamEdgeLengthRearM: mt0.seamEdgeLengthRearM + 0.008,
    };
    const inc = mergeHatSpecDefaults(
      solveHatSpecFromMeasurementsIncremental(spec0, mt0, mt1)
    );
    const full = mergeHatSpecDefaults(solveHatSpecFromMeasurements(spec0, mt1));
    expect(inc.seamTargetArcLengthM).toEqual(full.seamTargetArcLengthM);
    // Incremental skips re-bisecting circumference / visor when those inputs are unchanged.
    expect(inc.semiAxisX).toBe(spec0.semiAxisX);
    expect(inc.visor.projection).toBe(spec0.visor.projection);
  });
});

describe("measurementTargetsEqualApprox", () => {
  it("treats tiny float noise as equal", () => {
    const base0 = mergeHatSpecDefaults(defaultHatSkeletonSpec());
    const a = measurementTargetsFromSpec(base0);
    const b: HatMeasurementTargets = {
      ...a,
      baseCircumferenceM: a.baseCircumferenceM + 1e-6,
    };
    expect(measurementTargetsEqualApprox(a, b)).toBe(true);
  });
});
