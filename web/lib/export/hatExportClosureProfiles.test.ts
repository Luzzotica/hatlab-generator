import { describe, expect, it } from "vitest";
import { HAT_EXPORT_CLOSURE_PROFILES } from "./hatExportClosureProfiles";

describe("HAT_EXPORT_CLOSURE_PROFILES", () => {
  it("includes fitted (closed) and snapback (opening + hardware)", () => {
    expect(HAT_EXPORT_CLOSURE_PROFILES.length).toBeGreaterThanOrEqual(2);
    const fitted = HAT_EXPORT_CLOSURE_PROFILES.find((p) => p.id === "fitted");
    const snap = HAT_EXPORT_CLOSURE_PROFILES.find((p) => p.id === "snapback");
    expect(fitted?.rearOpening).toBe(false);
    expect(fitted?.emitClosureHardware).toBe(false);
    expect(snap?.rearOpening).toBe(true);
    expect(snap?.emitClosureHardware).toBe(true);
  });
});
