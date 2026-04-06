import { describe, expect, it } from "vitest";
import { pointAlongPolylineByArcLengthFromTop } from "@/lib/hat/hatSurfaceAnchor";

describe("pointAlongPolylineByArcLengthFromTop", () => {
  it("walks from top toward rim by arc length", () => {
    const pts: [number, number, number][] = [
      [0, 0, 0],
      [0, 0, 1],
      [0, 0, 2],
    ];
    const p = pointAlongPolylineByArcLengthFromTop(pts, 0.5);
    expect(p[2]).toBeCloseTo(1.5, 6);
    expect(p[0]).toBeCloseTo(0, 6);
    expect(p[1]).toBeCloseTo(0, 6);
  });

  it("returns rim when distance exceeds polyline length", () => {
    const pts: [number, number, number][] = [
      [1, 0, 0],
      [1, 0, 3],
    ];
    const p = pointAlongPolylineByArcLengthFromTop(pts, 100);
    expect(p[2]).toBeCloseTo(0, 6);
  });
});
