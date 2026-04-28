import * as THREE from "three";
import type { BuiltSkeleton } from "@/lib/skeleton/geometry";
import type { PanelCount } from "@/lib/skeleton/types";
import {
  evalSeamCurve,
  rearCenterSeamIndex,
  sweatbandTangentTheta,
  type SeamCurve,
} from "@/lib/skeleton/geometry";

/** 2.6 in — opening width (along circumferential / rim tangent). */
export const BACK_CLOSURE_WIDTH_M = 2.6 * 0.0254;
/** Kept for reference; profile is straight sides + semicircle (see total height below). */
export const BACK_CLOSURE_HEIGHT_M = 2.75 * 0.0254;

/** Vertical straight run on left/right (closure rails), then semicircular arc (diameter = width). */
export const BACK_CLOSURE_STRAIGHT_EDGE_M = 0.025;

/** Overall height = {@link BACK_CLOSURE_STRAIGHT_EDGE_M} + width/2 (semicircle on top). */
export const BACK_CLOSURE_TOTAL_HEIGHT_M =
  BACK_CLOSURE_STRAIGHT_EDGE_M + BACK_CLOSURE_WIDTH_M * 0.5;

/**
 * Move the opening toward the brim along −tH (from seam rim toward band). The seam sample at u=0
 * can sit slightly above where the sweatband polyline reads visually on screen.
 * {@link getBackClosureOpeningFrame}'s `rimAnchor` is `pRim − tH * this` (lh = 0 at rimAnchor; seam rim is at lh = +this).
 */
export const BACK_CLOSURE_DROP_TOWARD_BRIM_M = 0.02;

/** Extra width + straight leg on arch tape relative to cutout (pattern margin). */
export const BACK_CLOSURE_TAPE_MARGIN_M = 0.01;

function cross(
  a: readonly [number, number, number],
  b: readonly [number, number, number],
): [number, number, number] {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}

function dot(
  a: readonly [number, number, number],
  b: readonly [number, number, number],
): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function norm(v: readonly [number, number, number]): [number, number, number] {
  const L = Math.hypot(v[0], v[1], v[2]);
  if (L < 1e-15) throw new Error("degenerate vector");
  return [v[0] / L, v[1] / L, v[2] / L];
}

function sub(
  a: readonly [number, number, number],
  b: readonly [number, number, number],
): [number, number, number] {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

function scale(
  v: readonly [number, number, number],
  s: number,
): [number, number, number] {
  return [v[0] * s, v[1] * s, v[2] * s];
}

function seamTangentU(curve: SeamCurve, t: number): [number, number, number] {
  const eps = 1e-4;
  let t0 = t;
  let t1 = t + eps;
  if (t1 > 1) {
    t1 = t;
    t0 = Math.max(0, t - eps);
  }
  const p = evalSeamCurve(curve, t0);
  const q = evalSeamCurve(curve, t1);
  const d: [number, number, number] = [q[0] - p[0], q[1] - p[1], q[2] - p[2]];
  const L = Math.hypot(d[0], d[1], d[2]);
  if (L < 1e-12) return [0, 0, 1];
  return [d[0] / L, d[1] / L, d[2] / L];
}

/**
 * Orthonormal tangent frame: tW ≈ circumferential (width), tH ≈ up along seam (height),
 * n outward. Gram–Schmidt so width/height stay aligned with physical opening axes.
 */
function openingFrame(
  eTheta: [number, number, number],
  eU: [number, number, number],
  p: [number, number, number],
): {
  tW: [number, number, number];
  tH: [number, number, number];
  n: [number, number, number];
} {
  let nRaw = cross(eTheta, eU);
  if (Math.hypot(nRaw[0], nRaw[1], nRaw[2]) < 1e-10) {
    nRaw = cross(eTheta, [0, 0, 1]);
  }
  let n = norm(nRaw);
  const radial = norm([p[0], p[1], 0]);
  if (dot(n, radial) < 0) {
    n = [-n[0], -n[1], -n[2]];
  }

  let tW = sub(eTheta, scale(n, dot(eTheta, n)));
  const lenW = Math.hypot(tW[0], tW[1], tW[2]);
  if (lenW < 1e-8) {
    tW = norm(cross(eU, n));
  } else {
    tW = [tW[0] / lenW, tW[1] / lenW, tW[2] / lenW];
  }

  let tH = sub(eU, scale(n, dot(eU, n)));
  tH = sub(tH, scale(tW, dot(tH, tW)));
  const lenH = Math.hypot(tH[0], tH[1], tH[2]);
  if (lenH < 1e-8) {
    tH = norm(cross(n, tW));
  } else {
    tH = [tH[0] / lenH, tH[1] / lenH, tH[2] / lenH];
  }
  if (dot(tH, eU) < 0) {
    tH = [-tH[0], -tH[1], -tH[2]];
  }

  return { tW, tH, n };
}

/** Same frame as the closure cutter / CSG subtract — use for tape clipping and arch placement. */
export function getBackClosureOpeningFrame(sk: BuiltSkeleton): {
  tW: [number, number, number];
  tH: [number, number, number];
  n: [number, number, number];
  rimAnchor: [number, number, number];
} {
  const spec = sk.spec;
  const rearIdx = rearCenterSeamIndex(spec.nSeams);
  const theta = sk.angles[rearIdx]!;
  const seam = sk.seamControls[rearIdx]!;

  const pRim = evalSeamCurve(seam, 0);
  const uTiny = 1e-5;
  const eTheta = sweatbandTangentTheta(
    theta,
    spec.semiAxisX,
    spec.semiAxisY,
    spec.yawRad,
  );
  const eU = seamTangentU(seam, uTiny);

  const { tW, tH, n } = openingFrame(eTheta, eU, pRim);
  const rimAnchor = sub(pRim, scale(tH, BACK_CLOSURE_DROP_TOWARD_BRIM_M));
  return { tW, tH, n, rimAnchor };
}

/** Width / straight leg used for mesh cutout and tape (matches former CSG cutter). */
export function getClosureCutterDimensions(): {
  widthM: number;
  straightM: number;
} {
  return {
    widthM: BACK_CLOSURE_WIDTH_M + BACK_CLOSURE_TAPE_MARGIN_M,
    straightM: BACK_CLOSURE_STRAIGHT_EDGE_M + BACK_CLOSURE_TAPE_MARGIN_M,
  };
}

export function closureLocalWH(
  p: readonly [number, number, number],
  rimAnchor: readonly [number, number, number],
  tW: readonly [number, number, number],
  tH: readonly [number, number, number],
): { lw: number; lh: number } {
  const dx = p[0] - rimAnchor[0];
  const dy = p[1] - rimAnchor[1];
  const dz = p[2] - rimAnchor[2];
  return {
    lw: dx * tW[0] + dy * tW[1] + dz * tW[2],
    lh: dx * tH[0] + dy * tH[1] + dz * tH[2],
  };
}

/**
 * True if (lw,lh) lies inside the closed stadium: flat bottom on lh=0, vertical sides, semicircular top.
 * Same metric space as {@link buildStadiumShape}.
 */
export function pointInsideStadiumOpening2D(
  lw: number,
  lh: number,
  widthM: number,
  straightM: number,
): boolean {
  const halfW = widthM * 0.5;
  const h = straightM;
  const R = halfW;
  if (lh < -1e-8) return false;
  if (lh <= h + 1e-8) return Math.abs(lw) <= halfW + 1e-8;
  const dy = lh - h;
  return lw * lw + dy * dy <= R * R + 1e-8;
}

/**
 * Closed stadium outline in opening 2D (lw,lh), CCW when viewed from +surface normal n.
 * First point repeats at end for convenience.
 */
export function sampleStadiumBoundary2DClosed(
  widthM: number,
  straightM: number,
  pointsPerEdge: number,
): [number, number][] {
  const shape = buildStadiumShape(widthM, straightM);
  const n = Math.max(8, pointsPerEdge);
  const pts2d = shape.getPoints(n);
  const out: [number, number][] = [];
  for (const v of pts2d) {
    out.push([v.x, v.y]);
  }
  if (out.length > 0) {
    const f = out[0]!;
    const l = out[out.length - 1]!;
    if (Math.hypot(f[0] - l[0], f[1] - l[1]) > 1e-6) {
      out.push([f[0], f[1]]);
    }
  }
  return out;
}

function pointToSegmentDistance2D(
  px: number,
  py: number,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
): number {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len2 = dx * dx + dy * dy;
  if (len2 < 1e-18) return Math.hypot(px - x1, py - y1);
  let t = ((px - x1) * dx + (py - y1) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  const nx = x1 + t * dx;
  const ny = y1 + t * dy;
  return Math.hypot(px - nx, py - ny);
}

/**
 * Minimum distance (mm) from (lw,lh) to the stadium opening boundary when the point lies on
 * fabric outside the cutout. Returns 0 when inside the opening (hole) or on the boundary.
 * Used to mask laser etch away from closure arch seam tape.
 */
export function distanceToStadiumBoundaryOutsideMm(
  lw: number,
  lh: number,
  widthM: number,
  straightM: number,
): number {
  if (pointInsideStadiumOpening2D(lw, lh, widthM, straightM)) {
    return 0;
  }
  const pts = sampleStadiumBoundary2DClosed(widthM, straightM, 8);
  let minD = Infinity;
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i]!;
    const p1 = pts[i + 1]!;
    const d = pointToSegmentDistance2D(lw, lh, p0[0], p0[1], p1[0], p1[1]);
    minD = Math.min(minD, d);
  }
  return minD * 1000;
}

/**
 * Stadium profile: flat bottom on rim, vertical sides for `straightM`, then semicircle (diameter = widthM).
 * Local 2D: x = width (circumferential), y = height along seam-up (tH). Total height = straightM + widthM/2.
 */
export function buildStadiumShape(
  widthM: number,
  straightM: number,
): THREE.Shape {
  const halfW = widthM * 0.5;
  const R = halfW;
  const h = straightM;
  const shape = new THREE.Shape();
  shape.moveTo(-halfW, 0);
  shape.lineTo(-halfW, h);
  shape.absarc(0, h, R, Math.PI, 0, true);
  shape.lineTo(halfW, 0);
  shape.lineTo(-halfW, 0);
  return shape;
}

/** Inner boundary for {@link buildStadiumShape}, opposite winding for use as `Shape.holes` entry. */
export function buildStadiumHolePath(
  widthM: number,
  straightM: number,
): THREE.Path {
  const halfW = widthM * 0.5;
  const R = halfW;
  const h = straightM;
  const hole = new THREE.Path();
  hole.moveTo(-halfW, 0);
  hole.lineTo(halfW, 0);
  hole.lineTo(halfW, h);
  hole.absarc(0, h, R, 0, Math.PI, false);
  hole.lineTo(-halfW, h);
  hole.lineTo(-halfW, 0);
  return hole;
}

/** Panels sharing the rear center seam (closure spans both). */
export function getRearClosureAdjacentPanelIndices(nSeams: PanelCount): {
  leftPanel: number;
  rightPanel: number;
} {
  const rearIdx = rearCenterSeamIndex(nSeams);
  return {
    leftPanel: (rearIdx - 1 + nSeams) % nSeams,
    rightPanel: rearIdx % nSeams,
  };
}

/** Debug: 3D outline of the stadium cutter profile in world space (for wireframe overlay). */
export function getClosureCutterOutline(
  sk: BuiltSkeleton,
): [number, number, number][] {
  const { tW, tH, rimAnchor } = getBackClosureOpeningFrame(sk);
  const { widthM: w, straightM: s } = getClosureCutterDimensions();
  const shape = buildStadiumShape(w, s);
  const pts2d = shape.getPoints(64);
  return pts2d.map((v) => {
    const lx = v.x;
    const ly = v.y;
    return [
      rimAnchor[0] + lx * tW[0] + ly * tH[0],
      rimAnchor[1] + lx * tW[1] + ly * tH[1],
      rimAnchor[2] + lx * tW[2] + ly * tH[2],
    ] as [number, number, number];
  });
}
