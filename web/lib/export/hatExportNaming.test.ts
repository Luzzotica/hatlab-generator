import { describe, expect, it } from "vitest";
import {
  VISOR_GROUP_KEYS,
  childNamePrefix,
  resolveExportModelPrefix,
  visorGroupKey,
  visorKeyCompact,
  visorRootGroupName,
} from "./hatExportNaming";

describe("hatExportNaming", () => {
  it("maps four indices to stable group keys", () => {
    expect(VISOR_GROUP_KEYS.length).toBe(4);
    expect(visorGroupKey(0)).toBe("flat_curve");
    expect(visorGroupKey(3)).toBe("high_curve");
  });

  it("visorKeyCompact removes underscores", () => {
    expect(visorKeyCompact("flat_curve")).toBe("flatcurve");
  });

  it("visorRootGroupName and childNamePrefix", () => {
    expect(visorRootGroupName("m1", "flat_curve")).toBe("m1_flat_curve");
    expect(childNamePrefix("m1", "flat_curve")).toBe("m1_flatcurve");
  });

  it("resolveExportModelPrefix", () => {
    expect(resolveExportModelPrefix("Untitled hat")).toBe("m1");
    expect(resolveExportModelPrefix("M2")).toBe("m2");
    expect(resolveExportModelPrefix("m2")).toBe("m2");
    expect(resolveExportModelPrefix("M12 export")).toBe("m12");
    expect(resolveExportModelPrefix("Hat M2")).toBe("m2");
    expect(resolveExportModelPrefix("Model 3")).toBe("m3");
  });
});
