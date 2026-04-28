import { describe, expect, it } from "vitest";
import {
  createDefaultHatDocument,
  effectiveMeasurementTargets,
  finalizeSpecForVisorShape,
  mergeMeasurementTargetsWithDefaults,
  parseHatDocumentJSON,
  serializeHatDocument,
  VISOR_SHAPE_CURVATURE_MS,
  VISOR_THREAD_PLANFORM_DEPTH_SCALE_BY_SHAPE,
} from "./hatDocument";
import { VISOR_CURVATURE_PLANFORM_K } from "@/lib/skeleton/geometry";
import { defaultHatSkeletonSpec, mergeHatSpecDefaults } from "@/lib/skeleton/types";
import { measurementTargetsFromSpec } from "@/lib/skeleton/measurements";

describe("hatDocument", () => {
  it("visor thread depth scales align one-to-one with curve presets", () => {
    expect(VISOR_THREAD_PLANFORM_DEPTH_SCALE_BY_SHAPE.length).toBe(
      VISOR_SHAPE_CURVATURE_MS.length,
    );
    for (let i = 1; i < VISOR_THREAD_PLANFORM_DEPTH_SCALE_BY_SHAPE.length; i++) {
      expect(VISOR_THREAD_PLANFORM_DEPTH_SCALE_BY_SHAPE[i]!).toBeLessThan(
        VISOR_THREAD_PLANFORM_DEPTH_SCALE_BY_SHAPE[i - 1]!,
      );
    }
  });

  it("effectiveMeasurementTargets merges visor length override for active shape", () => {
    const base = measurementTargetsFromSpec(
      mergeHatSpecDefaults(defaultHatSkeletonSpec()),
    );
    const baseWithLen = { ...base, visorLengthM: 0.11 };
    const mt = effectiveMeasurementTargets(baseWithLen, 2, {
      2: { measurements: { visorLengthM: 0.15 } },
    });
    expect(mt.visorLengthM).toBe(0.15);
    expect(mt.baseCircumferenceM).toBe(baseWithLen.baseCircumferenceM);
  });

  it("finalizeSpecForVisorShape forces curvature and applies visor patch", () => {
    const spec = mergeHatSpecDefaults(defaultHatSkeletonSpec());
    const out = finalizeSpecForVisorShape(spec, 3, {
      3: { visor: { projection: 0.14 } },
    });
    expect(out.visor.visorCurvatureM).toBe(VISOR_SHAPE_CURVATURE_MS[3]);
    expect(out.visor.projection).toBe(0.14);
  });

  it("finalizeSpecForVisorShape scales projection when curvature changes to preserve planform depth", () => {
    const spec = mergeHatSpecDefaults(defaultHatSkeletonSpec());
    const p0 = spec.visor.projection;
    const K = VISOR_CURVATURE_PLANFORM_K;
    const c3 = VISOR_SHAPE_CURVATURE_MS[3]!;
    const curved = finalizeSpecForVisorShape(spec, 3, {});
    expect(curved.visor.projection).toBeCloseTo(p0 / (1 + K * c3), 6);
    const roundTrip = finalizeSpecForVisorShape(curved, 0, {});
    expect(roundTrip.visor.projection).toBeCloseTo(p0, 6);
  });

  it("serialize and parse round-trip", () => {
    const doc = createDefaultHatDocument();
    const json = serializeHatDocument(doc);
    const back = parseHatDocumentJSON(json);
    expect(back.id).toBe(doc.id);
    expect(back.activeVisorShape).toBe(doc.activeVisorShape);
    expect(back.measurementBase.baseCircumferenceM).toBe(
      doc.measurementBase.baseCircumferenceM,
    );
    expect(back.spec.semiAxisX).toBeCloseTo(doc.spec.semiAxisX, 8);
  });

  it("mergeMeasurementTargetsWithDefaults fills missing keys", () => {
    const m = mergeMeasurementTargetsWithDefaults({ visorLengthM: 0.12 });
    expect(m.visorLengthM).toBe(0.12);
    expect(typeof m.baseCircumferenceM).toBe("number");
    expect(m.baseCircumferenceM).toBeGreaterThan(0);
  });
});
