/**
 * Logical closure modes (fitted vs snapback) for documentation. The unified GLB export builds one
 * modular tree per visor (`buildHatExportGroupModular`) with named slots (`Crown_Rear_Fitted`, etc.)
 * instead of duplicating full hats per mode.
 */
export interface HatExportClosureProfile {
  /**
   * Stable segment in object names. `fitted` = closed rear (no opening); matches common "fitted cap"
   * terminology. Other ids align with `HatClosureKind` where applicable.
   */
  readonly id: string;
  /** Rear crown cutout + sweatband opening (e.g. snapback opening). */
  readonly rearOpening: boolean;
  /** Emit a separate `Closures` subtree (strap, snaps, etc.) for this profile. */
  readonly emitClosureHardware: boolean;
}

/** @deprecated Use modular export slots; kept for tests / docs. */
export const HAT_EXPORT_CLOSURE_PROFILES = [
  { id: "fitted", rearOpening: false, emitClosureHardware: false },
  { id: "snapback", rearOpening: true, emitClosureHardware: true },
] as const satisfies readonly HatExportClosureProfile[];

export type HatExportClosureProfileId =
  (typeof HAT_EXPORT_CLOSURE_PROFILES)[number]["id"];
