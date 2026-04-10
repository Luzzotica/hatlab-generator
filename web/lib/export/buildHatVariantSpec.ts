import {
  mergeHatSpecDefaults,
  type EyeletStyle,
  type HatSkeletonSpec,
  validateSpec,
} from "@/lib/skeleton/types";
import { solveHatSpecFromMeasurements } from "@/lib/skeleton/solveMeasurements";
import {
  effectiveMeasurementTargets,
  finalizeSpecForVisorShape,
  type HatDocument,
  type VisorShapeIndex,
} from "@/lib/hat/hatDocument";

export interface HatVariantBuildOptions {
  eyeletStyle: EyeletStyle;
  /** true = closed back (no rear opening / no hardware); false = rear opening in crown/sweatband */
  closureClosedBack: boolean;
  /**
   * When `closureClosedBack` is false (rear opening), set false to omit closure hardware while still
   * cutting the opening (body + eyelet export passes). Default true when opening is enabled.
   */
  includeClosureHardware?: boolean;
}

/**
 * Full skeleton for one export pass: solved for `visorIndex`, then eyelet + closure patched.
 */
export function buildHatVariantSpec(
  doc: HatDocument,
  visorIndex: VisorShapeIndex,
  options: HatVariantBuildOptions,
): HatSkeletonSpec {
  const mt = effectiveMeasurementTargets(
    doc.measurementBase,
    visorIndex,
    doc.visorShapeOverrides,
  );
  let spec = solveHatSpecFromMeasurements(mergeHatSpecDefaults(doc.spec), mt);
  spec = finalizeSpecForVisorShape(spec, visorIndex, doc.visorShapeOverrides);

  const backClosureOpening = !options.closureClosedBack;
  let closures = spec.closures;
  if (!backClosureOpening) {
    closures = [];
  } else if (options.includeClosureHardware === false) {
    closures = [];
  } else if (closures.length === 0) {
    closures = [{ type: "snapback" }];
  }

  spec = mergeHatSpecDefaults({
    ...spec,
    eyeletStyle: options.eyeletStyle,
    backClosureOpening,
    closures,
  });
  // mergeHatSpecDefaults fills default snapback when `closures` is empty and opening is on; export
  // passes that need the cutout without meshing hardware must clear again after merge.
  if (backClosureOpening && options.includeClosureHardware === false) {
    spec = { ...spec, closures: [] };
  }
  validateSpec(spec);
  return spec;
}
