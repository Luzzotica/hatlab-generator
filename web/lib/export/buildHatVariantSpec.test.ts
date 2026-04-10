import { describe, expect, it } from "vitest";
import { createDefaultHatDocument } from "@/lib/hat/hatDocument";
import { buildHatVariantSpec } from "./buildHatVariantSpec";
import { VISOR_SHAPE_CURVATURE_MS } from "@/lib/hat/hatDocument";

describe("buildHatVariantSpec", () => {
  it("sets eyelet and closure flags", () => {
    const doc = createDefaultHatDocument();
    const closed = buildHatVariantSpec(doc, 0, {
      eyeletStyle: "none",
      closureClosedBack: true,
    });
    expect(closed.eyeletStyle).toBe("none");
    expect(closed.backClosureOpening).toBe(false);
    expect(closed.closures.length).toBe(0);

    const snap = buildHatVariantSpec(doc, 0, {
      eyeletStyle: "cloth",
      closureClosedBack: false,
    });
    expect(snap.eyeletStyle).toBe("cloth");
    expect(snap.backClosureOpening).toBe(true);
    expect(snap.closures.some((c) => c.type === "snapback")).toBe(true);

    const openNoHardware = buildHatVariantSpec(doc, 0, {
      eyeletStyle: "none",
      closureClosedBack: false,
      includeClosureHardware: false,
    });
    expect(openNoHardware.backClosureOpening).toBe(true);
    expect(openNoHardware.closures.length).toBe(0);
  });

  it("forces visor curvature for visor index", () => {
    const doc = createDefaultHatDocument();
    const s = buildHatVariantSpec(doc, 2, {
      eyeletStyle: "none",
      closureClosedBack: true,
    });
    expect(s.visor.visorCurvatureM).toBe(VISOR_SHAPE_CURVATURE_MS[2]);
  });
});
