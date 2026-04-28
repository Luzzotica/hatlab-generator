import { describe, expect, it } from "vitest";
import { HAT_EXPORT_CLOSURE_PROFILES } from "./hatExportClosureProfiles";

describe("HAT_EXPORT_CLOSURE_PROFILES", () => {
  it("includes fitted (closed) and rear-opening profiles with closure hardware", () => {
    expect(HAT_EXPORT_CLOSURE_PROFILES.length).toBeGreaterThanOrEqual(2);
    const fitted = HAT_EXPORT_CLOSURE_PROFILES.find((p) => p.id === "fitted");
    const snap = HAT_EXPORT_CLOSURE_PROFILES.find((p) => p.id === "snapback");
    const velcro = HAT_EXPORT_CLOSURE_PROFILES.find((p) => p.id === "velcro");
    const strapback = HAT_EXPORT_CLOSURE_PROFILES.find(
      (p) => p.id === "strapback",
    );
    const metalSlide = HAT_EXPORT_CLOSURE_PROFILES.find(
      (p) => p.id === "metalSlide",
    );
    const shockCord = HAT_EXPORT_CLOSURE_PROFILES.find(
      (p) => p.id === "shockCord",
    );
    expect(fitted?.rearOpening).toBe(false);
    expect(fitted?.emitClosureHardware).toBe(false);
    expect(snap?.rearOpening).toBe(true);
    expect(snap?.emitClosureHardware).toBe(true);
    expect(velcro?.rearOpening).toBe(true);
    expect(velcro?.emitClosureHardware).toBe(true);
    expect(strapback?.rearOpening).toBe(true);
    expect(strapback?.emitClosureHardware).toBe(true);
    expect(metalSlide?.rearOpening).toBe(true);
    expect(metalSlide?.emitClosureHardware).toBe(true);
    expect(shockCord?.rearOpening).toBe(true);
    expect(shockCord?.emitClosureHardware).toBe(true);
  });
});
