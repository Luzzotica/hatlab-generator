import { describe, expect, it } from "vitest";
import {
  sweatbandPoint,
  sweatbandTangentTheta,
  rearCenterSeamIndex,
  crossSeamTapeIndices,
  evalQuadraticBezier,
  seamQuadraticBezier,
  panelSeamAngles,
  frontPanelRimThetaBounds,
  effectiveVisorHalfSpanRad,
  visorOuterPolyline,
  evalSeamCurve,
  buildSplitSeamCurve,
  effectiveSquarenessForSeam,
  topRimPoint,
  arcLengthOfSeamQuadratic,
  solveSquarenessForArcLengthMultiplier,
  evalSeamSuperellipse,
  buildSkeleton,
  evalVToArcGuideMeridianAt,
  sampleVToArcGuideMeridian,
  defaultSeamEndpointStyleFromSquareness,
  solveLambdaForSeamCubicArcLength,
  cubicBezierArcLength,
  buildSeamCubicWithLambda,
  buildSeamCubicControlPoints,
  evalCubicBezier,
} from "./geometry";
import { measurementTargetsFromSpec, seamGroupIndices } from "./measurements";
import { solveHatSpecFromMeasurements } from "./solveMeasurements";
import { defaultHatSkeletonSpec, defaultVisorSpec, mergeHatSpecDefaults } from "./types";

describe("topRimPoint", () => {
  it("lies on z = crownHeight and scales ellipse by fraction", () => {
    const H = 0.15;
    const f = 0.05;
    const p = topRimPoint(0.5 * Math.PI, 0.1, 0.1, 0, H, f);
    expect(p[2]).toBeCloseTo(H, 6);
    expect(p[1]).toBeCloseTo(0.1 * f, 5);
  });
});

describe("sweatbandPoint", () => {
  it("circle at theta=0 and pi/2", () => {
    const p0 = sweatbandPoint(0, 0.1, 0.1, 0);
    expect(p0[0]).toBeCloseTo(0.1, 6);
    expect(p0[1]).toBeCloseTo(0, 6);
    const p90 = sweatbandPoint(0.5 * Math.PI, 0.1, 0.1, 0);
    expect(p90[0]).toBeCloseTo(0, 5);
    expect(p90[1]).toBeCloseTo(0.1, 6);
  });
});

describe("rearCenterSeamIndex", () => {
  it("matches seamGroupIndices rear (6-panel → 4, 5-panel → 3)", () => {
    expect(rearCenterSeamIndex(6)).toBe(4);
    expect(rearCenterSeamIndex(5)).toBe(3);
  });
});

describe("crossSeamTapeIndices", () => {
  it("returns opposite side seam pairs for 5- and 6-panel", () => {
    expect(crossSeamTapeIndices(6)).toEqual([
      [0, 3],
      [2, 5],
    ]);
    expect(crossSeamTapeIndices(5)).toEqual([
      [2, 0],
      [4, 1],
    ]);
  });
});

describe("sweatbandTangentTheta", () => {
  it("is unit length and perpendicular to radial at circle (a=b)", () => {
    const t = sweatbandTangentTheta(0.3, 0.1, 0.1, 0);
    expect(Math.hypot(t[0], t[1], t[2])).toBeCloseTo(1, 6);
    const r = sweatbandPoint(0.3, 0.1, 0.1, 0);
    const radial = [r[0], r[1], r[2]] as const;
    const dot =
      radial[0] * t[0] + radial[1] * t[1] + radial[2] * t[2];
    expect(dot).toBeCloseTo(0, 5);
  });
});

describe("panelSeamAngles", () => {
  it("5-panel: front panel bisector at +Y (π/2), not a seam on center", () => {
    const a = panelSeamAngles(5);
    expect(a.length).toBe(5);
    const mid01 = 0.5 * (a[0]! + a[1]!);
    expect(mid01).toBeCloseTo(0.5 * Math.PI, 6);
  });

  it("6-panel: seam at +Y (π/2) for visor split", () => {
    const a = panelSeamAngles(6);
    expect(a.length).toBe(6);
    const hit = Array.from(a).some((x) => Math.abs(x - 0.5 * Math.PI) < 1e-9);
    expect(hit).toBe(true);
  });
});

describe("frontPanelRimThetaBounds + visor inset", () => {
  it("5-panel: front arc between seam 0 and 1", () => {
    const a = panelSeamAngles(5);
    const b = frontPanelRimThetaBounds(5, a);
    expect(b.lo).toBeCloseTo(a[0]!, 9);
    expect(b.hi).toBeCloseTo(a[1]!, 9);
  });

  it("6-panel: front spans seam 0 to 2", () => {
    const a = panelSeamAngles(6);
    const b = frontPanelRimThetaBounds(6, a);
    expect(b.lo).toBeCloseTo(a[0]!, 9);
    expect(b.hi).toBeCloseTo(a[2]!, 9);
  });

  it("effective half span is reduced by rim inset", () => {
    const a = panelSeamAngles(5);
    const v = defaultVisorSpec();
    const wide = effectiveVisorHalfSpanRad({ ...v, rimInsetBehindSeamRad: 0 }, 5, a);
    const narrow = effectiveVisorHalfSpanRad({ ...v, rimInsetBehindSeamRad: 0.12 }, 5, a);
    expect(narrow).toBeLessThan(wide);
  });

  it("effective half span reaches front half + outset when halfSpanRad is generous", () => {
    const a = panelSeamAngles(6);
    const { lo, hi } = frontPanelRimThetaBounds(6, a);
    const frontHalf = 0.5 * (hi - lo);
    const outset = 0.035;
    const v = {
      ...defaultVisorSpec(),
      halfSpanRad: 2,
      rimInsetBehindSeamRad: 0,
      rimOutsetBeyondSeamRad: outset,
    };
    const e = effectiveVisorHalfSpanRad(v, 6, a);
    expect(e).toBeCloseTo(frontHalf + outset, 5);
  });
});

describe("visorOuterPolyline", () => {
  it("endpoints lie on the sweatband at attach ± halfSpan (ellipse chord)", () => {
    const semiX = 0.095;
    const semiY = 0.11;
    const yaw = 0;
    const c = 0.5 * Math.PI;
    const halfSpan = 0.4;
    const v = { ...defaultVisorSpec(), attachAngleRad: c, halfSpanRad: halfSpan, samples: 16 };
    const left = sweatbandPoint(c - halfSpan, semiX, semiY, yaw);
    const right = sweatbandPoint(c + halfSpan, semiX, semiY, yaw);
    const poly = visorOuterPolyline(semiX, semiY, yaw, v);
    const p0 = poly[0]!;
    const p1 = poly[poly.length - 1]!;
    const d = (a: number[], b: number[]) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
    expect(d(p0, left)).toBeLessThan(1e-5);
    expect(d(p1, right)).toBeLessThan(1e-5);
  });
});

describe("evalSeamCurve / split seams", () => {
  it("split seam is continuous at tSplit", () => {
    const rim: [number, number, number] = [0.1, 0, 0];
    const apex: [number, number, number] = [0, 0, 0.12];
    const c = buildSplitSeamCurve(rim, apex, 0.3, 0.5, 0.45);
    const ts = c.kind === "split" ? c.tSplit : 0.45;
    const a = evalSeamCurve(c, ts - 1e-6);
    const b = evalSeamCurve(c, ts + 1e-6);
    expect(a[0]).toBeCloseTo(b[0], 4);
    expect(a[2]).toBeCloseTo(b[2], 4);
  });

  it("effectiveSquarenessForSeam maps 6-panel groups", () => {
    const spec = {
      ...defaultHatSkeletonSpec(),
      nSeams: 6 as const,
      sixPanelSeams: { front: 0.9, sideFront: 0.2, back: 0.5 },
      seamSquarenessOverrides: [],
    };
    expect(effectiveSquarenessForSeam(spec, 1)).toBeCloseTo(0.9, 6);
    expect(effectiveSquarenessForSeam(spec, 0)).toBeCloseTo(0.2, 6);
    expect(effectiveSquarenessForSeam(spec, 4)).toBeCloseTo(0.5, 6);
  });
});

describe("seamQuadraticBezier", () => {
  it("squareness 0 gives straight chord at t=0.5", () => {
    const rim: [number, number, number] = [0.1, 0, 0];
    const apex: [number, number, number] = [0, 0, 0.1];
    const [p0, p1, p2] = seamQuadraticBezier(rim, apex, 0);
    expect(p1[0]).toBeCloseTo((p0[0] + p2[0]) / 2, 6);
    const mid = evalQuadraticBezier(p0, p1, p2, 0.5);
    expect(mid[0]).toBeCloseTo(0.05, 5);
    expect(mid[2]).toBeCloseTo(0.05, 5);
  });
});

function chordLen(
  a: [number, number, number],
  b: [number, number, number]
): number {
  return Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
}

describe("evalSeamSuperellipse", () => {
  const rim: [number, number, number] = [0.095, 0, 0];
  const top: [number, number, number] = [0, 0.01, 0.14];

  it("t=0 and t=1 hit rim and top", () => {
    const a = evalSeamSuperellipse(rim, top, 3, 0.4, 0);
    const b = evalSeamSuperellipse(rim, top, 3, 0.4, 1);
    expect(a[0]).toBeCloseTo(rim[0], 5);
    expect(a[1]).toBeCloseTo(rim[1], 5);
    expect(a[2]).toBeCloseTo(rim[2], 5);
    expect(b[0]).toBeCloseTo(top[0], 5);
    expect(b[1]).toBeCloseTo(top[1], 5);
    expect(b[2]).toBeCloseTo(top[2], 5);
  });

  it("bulge 0 is straight between rim and top", () => {
    const mid = evalSeamSuperellipse(rim, top, 3, 0, 0.5);
    expect(mid[0]).toBeCloseTo(0.5 * (rim[0] + top[0]), 5);
    expect(mid[1]).toBeCloseTo(0.5 * (rim[1] + top[1]), 5);
    expect(mid[2]).toBeCloseTo(0.5 * (rim[2] + top[2]), 5);
  });
});

describe("sampleVToArcGuideMeridian", () => {
  function vSplitSpec() {
    const base = mergeHatSpecDefaults(defaultHatSkeletonSpec());
    return mergeHatSpecDefaults({
      ...base,
      frontVSplit: {
        vPoint: [0.08, 0.02, 0.055] as [number, number, number],
        blend: 0.85,
        baseLengthM: 0.07,
        topLengthM: 0.06,
        legBottomStrength: 0,
        legTopStrength: 0,
      },
    });
  }

  it("α=0 matches arc seam P_A(u) at every sample (no discrete rim jump)", () => {
    const spec = vSplitSpec();
    const sk = buildSkeleton(spec);
    const N = 24;
    const arc = 0;
    const v = 1;
    const pts = sampleVToArcGuideMeridian(sk, arc, v, 0, N);
    const seamA = sk.seamControls[arc]!;
    for (let k = 0; k <= N; k++) {
      const u = k / N;
      const e = evalSeamCurve(seamA, u);
      const p = pts[k]!;
      expect(p[0]).toBeCloseTo(e[0], 6);
      expect(p[1]).toBeCloseTo(e[1], 6);
      expect(p[2]).toBeCloseTo(e[2], 6);
    }
  });

  it("α=1 matches V seam P_V(u) at current frontVSplit.blend (V strength)", () => {
    const spec = vSplitSpec();
    const sk = buildSkeleton(spec);
    const N = 24;
    const seamV = sk.seamControls[1]!;
    expect(seamV.kind).toBe("vSplit");
    const pts = sampleVToArcGuideMeridian(sk, 0, 1, 1, N);
    for (let k = 0; k <= N; k++) {
      const u = k / N;
      const e = evalSeamCurve(seamV, u);
      const p = pts[k]!;
      expect(p[0]).toBeCloseTo(e[0], 6);
      expect(p[1]).toBeCloseTo(e[1], 6);
      expect(p[2]).toBeCloseTo(e[2], 6);
    }
  });

  it("endpoints are R(α) on sweatband and T(α) on top ring for interior α", () => {
    const spec = vSplitSpec();
    const sk = buildSkeleton(spec);
    const N = 24;
    const thetaA = sk.angles[0]!;
    const thetaV = sk.angles[1]!;
    const alpha = 0.37;
    const thetaMix = (1 - alpha) * thetaA + alpha * thetaV;
    const rim = sweatbandPoint(thetaMix, spec.semiAxisX, spec.semiAxisY, spec.yawRad);
    const top = topRimPoint(
      thetaMix,
      spec.semiAxisX,
      spec.semiAxisY,
      spec.yawRad,
      spec.crownHeight,
      spec.topRimFraction ?? 0
    );
    const pts = sampleVToArcGuideMeridian(sk, 0, 1, alpha, N);
    expect(pts[0]![0]).toBeCloseTo(rim[0], 6);
    expect(pts[0]![1]).toBeCloseTo(rim[1], 6);
    expect(pts[0]![2]).toBeCloseTo(rim[2], 6);
    expect(pts[N]![0]).toBeCloseTo(top[0], 6);
    expect(pts[N]![1]).toBeCloseTo(top[1], 6);
    expect(pts[N]![2]).toBeCloseTo(top[2], 6);
    expect(pts[0]![2]).toBeCloseTo(0, 6);
  });

  it("evalVToArcGuideMeridianAt matches sampleVToArcGuideMeridian at each u", () => {
    const spec = vSplitSpec();
    const sk = buildSkeleton(spec);
    const N = 24;
    const alpha = 0.41;
    const strip = sampleVToArcGuideMeridian(sk, 0, 1, alpha, N);
    for (let k = 0; k <= N; k++) {
      const u = k / N;
      const p = evalVToArcGuideMeridianAt(sk, 0, 1, alpha, u);
      const q = strip[k]!;
      expect(p[0]).toBeCloseTo(q[0], 7);
      expect(p[1]).toBeCloseTo(q[1], 7);
      expect(p[2]).toBeCloseTo(q[2], 7);
    }
  });

  it("first interior sample uses endpoint correction (not pure chord blend at u=1/N)", () => {
    const spec = vSplitSpec();
    const sk = buildSkeleton(spec);
    const N = 24;
    const alpha = 0.45;
    const seamA = sk.seamControls[0]!;
    const seamV = sk.seamControls[1]!;
    const u = 1 / N;
    const naive = [
      (1 - alpha) * evalSeamCurve(seamA, u)[0] + alpha * evalSeamCurve(seamV, u)[0],
      (1 - alpha) * evalSeamCurve(seamA, u)[1] + alpha * evalSeamCurve(seamV, u)[1],
      (1 - alpha) * evalSeamCurve(seamA, u)[2] + alpha * evalSeamCurve(seamV, u)[2],
    ];
    const corrected = sampleVToArcGuideMeridian(sk, 0, 1, alpha, N)[1]!;
    const distNaive = Math.hypot(naive[0] - corrected[0], naive[1] - corrected[1], naive[2] - corrected[2]);
    expect(distNaive).toBeGreaterThan(1e-5);
  });
});

describe("solveSquarenessForArcLengthMultiplier", () => {
  const rim: [number, number, number] = [0.095, 0, 0];
  const top: [number, number, number] = [0, 0.01, 0.14];

  it("multiplier 1 yields ~0 squareness (arc length ≈ chord)", () => {
    const chord = chordLen(rim, top);
    const s = solveSquarenessForArcLengthMultiplier(rim, top, 1);
    expect(s).toBeLessThan(0.02);
    const L = arcLengthOfSeamQuadratic(rim, top, s);
    expect(L).toBeCloseTo(chord, 2);
  });

  it("higher multiplier increases arc length and squareness", () => {
    const sLo = solveSquarenessForArcLengthMultiplier(rim, top, 1.05);
    const sHi = solveSquarenessForArcLengthMultiplier(rim, top, 1.25);
    expect(sHi).toBeGreaterThan(sLo);
    expect(arcLengthOfSeamQuadratic(rim, top, sHi)).toBeGreaterThan(
      arcLengthOfSeamQuadratic(rim, top, sLo)
    );
  });

  it("solved arc length matches target multiplier × chord", () => {
    const mult = 1.18;
    const chord = chordLen(rim, top);
    const target = chord * mult;
    const s = solveSquarenessForArcLengthMultiplier(rim, top, mult);
    const L = arcLengthOfSeamQuadratic(rim, top, s);
    expect(L).toBeCloseTo(target, 2);
  });
});

describe("seam cubic λ-solve", () => {
  it("achieves target arc length for sample endpoints", () => {
    const rim: [number, number, number] = [0.1, 0, 0];
    const top: [number, number, number] = [0, 0, 0.12];
    const style = defaultSeamEndpointStyleFromSquareness(0.35);
    const target = 0.19;
    const lam = solveLambdaForSeamCubicArcLength(rim, top, style, target);
    const [p0, p1, p2, p3] = buildSeamCubicWithLambda(rim, top, style, lam);
    const L = cubicBezierArcLength(p0, p1, p2, p3);
    expect(L).toBeCloseTo(target, 2);
  });

  it("buildSeamCubicControlPoints keeps radial bulge ≥ chord (no inward sag vs straight rim→top)", () => {
    const rim: [number, number, number] = [0, 0.11, 0];
    const top: [number, number, number] = [0, 0, 0.12];
    const style = defaultSeamEndpointStyleFromSquareness(0.35);
    const target = arcLengthOfSeamQuadratic(rim, top, 0.35);
    const [p0, p1, p2, p3] = buildSeamCubicControlPoints(rim, top, style, target);
    for (let s = 1; s < 20; s++) {
      const t = s / 20;
      const p = evalCubicBezier(p0, p1, p2, p3, t);
      const q: [number, number, number] = [
        rim[0] + t * (top[0] - rim[0]),
        rim[1] + t * (top[1] - rim[1]),
        rim[2] + t * (top[2] - rim[2]),
      ];
      const rp = Math.hypot(p[0], p[1]);
      const rq = Math.hypot(q[0], q[1]);
      if (rq > 1e-4) {
        expect(rp).toBeGreaterThanOrEqual(rq - 1e-5);
      }
    }
  });
});

describe("buildSkeleton cubic seams", () => {
  it("uses cubic seam controls in squareness mode", () => {
    const spec = mergeHatSpecDefaults(defaultHatSkeletonSpec());
    const sk = buildSkeleton(spec);
    expect(sk.seamControls[0]?.kind).toBe("cubic");
  });

  it("reuses cubic seam controls when only another seam's target length changes", () => {
    const base0 = mergeHatSpecDefaults(defaultHatSkeletonSpec());
    const mt = measurementTargetsFromSpec(base0);
    const base = mergeHatSpecDefaults(solveHatSpecFromMeasurements(base0, mt));
    const g = seamGroupIndices(6);
    const rearIdx = g.rear[0]!;
    const sideFrontIdx = g.sideFront[0]!;
    const arr = [...base.seamTargetArcLengthM];
    arr[sideFrontIdx] = (arr[sideFrontIdx] ?? 0.1) + 0.02;
    const spec2 = mergeHatSpecDefaults({ ...base, seamTargetArcLengthM: arr });
    const sk0 = buildSkeleton(base);
    const sk1 = buildSkeleton(spec2, sk0);
    expect(sk1.seamControls[rearIdx]).toBe(sk0.seamControls[rearIdx]);
    expect(sk1.seamControls[sideFrontIdx]).not.toBe(sk0.seamControls[sideFrontIdx]);
  });

  it("mirror seam pairs (6-panel 0↔2, 3↔5) have identical Z along the curve at apex top", () => {
    const spec = mergeHatSpecDefaults(defaultHatSkeletonSpec());
    expect(spec.topRimFraction).toBe(0);
    const sk = buildSkeleton(spec);
    const pairs: [number, number][] = [
      [0, 2],
      [3, 5],
    ];
    for (const [a, b] of pairs) {
      const ca = sk.seamControls[a]!;
      const cb = sk.seamControls[b]!;
      for (let s = 0; s <= 20; s++) {
        const t = s / 20;
        const za = evalSeamCurve(ca, t)[2];
        const zb = evalSeamCurve(cb, t)[2];
        expect(za).toBeCloseTo(zb, 7);
      }
    }
  });
});

describe("seamGroupIndices mirror pairs", () => {
  it("6-panel side-front lists 0 and 2", () => {
    const g = seamGroupIndices(6);
    expect(g.sideFront).toEqual([0, 2]);
    expect(g.sideBack).toEqual([3, 5]);
  });
});
