import type { VisorShapeIndex } from "@/lib/hat/hatDocument";

/**
 * Stable keys for the four visor curve presets (matches art pipeline / outliner).
 * Index order aligns with {@link VISOR_SHAPE_CURVATURE_MS}.
 */
export const VISOR_GROUP_KEYS: readonly [
  string,
  string,
  string,
  string,
] = ["flat_curve", "pre_curve", "slight_curve", "high_curve"];

export function visorGroupKey(index: VisorShapeIndex): string {
  return VISOR_GROUP_KEYS[index]!;
}

/** `flat_curve` → `flatcurve` for compact child prefixes like `m1_flatcurve_*`. */
export function visorKeyCompact(visorGroupKey: string): string {
  return visorGroupKey.replace(/_/g, "");
}

/** Top-level group name: `{modelPrefix}_{visorGroupKey}` e.g. `m1_flat_curve`. */
export function visorRootGroupName(
  modelPrefix: string,
  visorGroupKey: string,
): string {
  return `${modelPrefix}_${visorGroupKey}`;
}

/**
 * Prefix for all mesh/object names under that visor branch:
 * `{modelPrefix}_{compact}` e.g. `m1_flatcurve`.
 */
export function childNamePrefix(
  modelPrefix: string,
  visorGroupKey: string,
): string {
  return `${modelPrefix}_${visorKeyCompact(visorGroupKey)}`;
}

/**
 * GLB object names use `{modelPrefix}_flatcurve_*`. Derive prefix from the hat name so e.g. "M2"
 * or "Hat M2" → `m2` instead of always `m1`. Falls back to `m1`.
 */
export function resolveExportModelPrefix(hatName: string): string {
  const trimmed = hatName.trim();
  const atStart = /^m\s*(\d+)/i.exec(trimmed);
  if (atStart) return `m${atStart[1]}`;
  const modelWord = /^model\s*(\d+)/i.exec(trimmed);
  if (modelWord) return `m${modelWord[1]}`;
  for (const token of trimmed.split(/\s+/)) {
    const mTok = /^m(\d+)$/i.exec(token);
    if (mTok) return `m${mTok[1]}`;
  }
  return "m1";
}
