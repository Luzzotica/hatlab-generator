import { describe, expect, it } from "vitest";
import { buildInnerFrontRiseGeometries } from "@/lib/mesh/crownMesh";
import { buildSkeleton } from "@/lib/skeleton/geometry";
import { defaultHatSkeletonSpec, mergeHatSpecDefaults } from "@/lib/skeleton/types";

describe("buildInnerFrontRiseGeometries", () => {
  it("6-panel returns one merged geometry with non-empty positions", () => {
    const spec = mergeHatSpecDefaults({
      ...defaultHatSkeletonSpec(),
      nSeams: 6,
    });
    const sk = buildSkeleton(spec);
    const geos = buildInnerFrontRiseGeometries(sk);
    expect(geos.length).toBe(1);
    const pos = geos[0]!.getAttribute("position");
    expect(pos).toBeTruthy();
    expect(pos!.count).toBeGreaterThan(0);
  });

  it("5-panel returns one geometry", () => {
    const spec = mergeHatSpecDefaults({
      ...defaultHatSkeletonSpec(),
      nSeams: 5,
    });
    const sk = buildSkeleton(spec);
    const geos = buildInnerFrontRiseGeometries(sk);
    expect(geos.length).toBe(1);
  });

  it("attaches laserPlaneMm with one vec2 per vertex", () => {
    for (const nSeams of [5, 6] as const) {
      const spec = mergeHatSpecDefaults({
        ...defaultHatSkeletonSpec(),
        nSeams,
      });
      const sk = buildSkeleton(spec);
      const geos = buildInnerFrontRiseGeometries(sk);
      const geo = geos[0]!;
      const pos = geo.getAttribute("position")!;
      const lp = geo.getAttribute("laserPlaneMm");
      expect(lp, `laserPlaneMm present (${nSeams}-panel)`).toBeTruthy();
      expect(lp!.itemSize).toBe(2);
      expect(lp!.count).toBe(pos.count);
      const arr = lp!.array as Float32Array;
      for (let i = 0; i < arr.length; i++) {
        expect(Number.isFinite(arr[i])).toBe(true);
      }
    }
  });

  it("6-panel laserPlaneMm.x spans across the merged front seam (both signs present)", () => {
    const spec = mergeHatSpecDefaults({
      ...defaultHatSkeletonSpec(),
      nSeams: 6,
    });
    const sk = buildSkeleton(spec);
    const geos = buildInnerFrontRiseGeometries(sk);
    const lp = geos[0]!.getAttribute("laserPlaneMm")!;
    const arr = lp.array as Float32Array;
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    for (let i = 0; i < arr.length; i += 2) {
      const x = arr[i]!;
      const y = arr[i + 1]!;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
    expect(minX).toBeLessThan(-10);
    expect(maxX).toBeGreaterThan(10);
    expect(maxX - minX).toBeGreaterThan(50);
    expect(minY).toBeGreaterThanOrEqual(-1);
    expect(maxY).toBeGreaterThan(10);
  });

  it("UVs stay in [0,1] after isotropic scaling", () => {
    const spec = mergeHatSpecDefaults(defaultHatSkeletonSpec());
    expect(spec.nSeams).toBe(6);
    const sk = buildSkeleton(spec);
    const geos = buildInnerFrontRiseGeometries(sk);
    const uv = geos[0]!.getAttribute("uv");
    expect(uv).toBeTruthy();
    const arr = uv!.array as Float32Array;
    for (let i = 0; i < arr.length; i++) {
      expect(arr[i]).toBeGreaterThanOrEqual(-1e-6);
      expect(arr[i]).toBeLessThanOrEqual(1 + 1e-6);
    }
  });
});
