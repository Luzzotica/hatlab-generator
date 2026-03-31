import * as THREE from "three";
import type { BuiltSkeleton } from "@/lib/skeleton/geometry";
import type { HatSkeletonSpec } from "@/lib/skeleton/types";
import {
  BACK_CLOSURE_WIDTH_M,
  getBackClosureOpeningFrame,
} from "@/lib/mesh/backClosureSubtract";
import {
  crownArcSegments,
  crownMeridianPointAtK,
  crownVerticalRings,
  findKRingForDeltaZ,
} from "@/lib/mesh/crownMesh";

/** Vertical rise (+Z in skeleton space) from the brim along each crown meridian (0.625 in). */
export const SWEATBAND_HEIGHT_M = 0.625 * 0.0254;

/** Radial thickness (inner vs outer surface). */
export const SWEATBAND_THICKNESS_M = 0.0015;

/** XY inset from crown surface toward the head (m). */
export const SWEATBAND_OUTER_INSET_M = 0.001;

/** Samples around the rim (full ring) or along the front arc when closure is on. */
export const SWEATBAND_SEGMENTS = 96;

const FILLET_STEPS = 4;
/** Interior samples along k between kf and (kTop − kf), excluding those endpoints. */
const LINEAR_RING_COUNT = 11;

function pushTriangle(
  positions: number[],
  a: [number, number, number],
  b: [number, number, number],
  c: [number, number, number]
): void {
  positions.push(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2]);
}

function pushQuad(
  positions: number[],
  a: [number, number, number],
  b: [number, number, number],
  c: [number, number, number],
  d: [number, number, number]
): void {
  pushTriangle(positions, a, b, c);
  pushTriangle(positions, a, c, d);
}

function sub(
  a: [number, number, number],
  b: [number, number, number]
): [number, number, number] {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

function len3(v: [number, number, number]): number {
  return Math.hypot(v[0], v[1], v[2]);
}

function normalize3(v: [number, number, number]): [number, number, number] {
  const L = len3(v);
  if (L < 1e-14) return [0, 0, 0];
  return [v[0] / L, v[1] / L, v[2] / L];
}

/** Horizontal inward (toward z-axis) from p in XY. */
function radialInwardXY(p: [number, number, number]): [number, number, number] {
  const L = Math.hypot(p[0], p[1]);
  if (L < 1e-12) return [0, 0, 0];
  return [-p[0] / L, -p[1] / L, 0];
}

function dot(
  a: [number, number, number],
  b: [number, number, number]
): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function normalizeAngle(theta: number): number {
  let t = theta % (2 * Math.PI);
  if (t < 0) t += 2 * Math.PI;
  return t;
}

/**
 * Inverse of sweatband ellipse at z=0: world XY → θ (radians).
 * World = R_z(yaw) * [a cos θ, b sin θ, 0].
 */
export function rimWorldXYToSweatbandTheta(spec: HatSkeletonSpec, x: number, y: number): number {
  const c = Math.cos(-spec.yawRad);
  const s = Math.sin(-spec.yawRad);
  const lx = c * x - s * y;
  const ly = s * x + c * y;
  return Math.atan2(ly / spec.semiAxisY, lx / spec.semiAxisX);
}

/**
 * Long arc (front of hat) between closure rails: CCW span and starting θ.
 * Rails at θL, θR; rear gap is the shorter arc between them.
 */
export function sweatbandFrontArcStartAndSpan(thetaL: number, thetaR: number): {
  start: number;
  span: number;
} {
  const L = normalizeAngle(thetaL);
  const R2 = normalizeAngle(thetaR);
  const dCcw = normalizeAngle(R2 - L);
  if (dCcw <= Math.PI + 1e-9) {
    return { start: R2, span: 2 * Math.PI - dCcw };
  }
  return { start: L, span: dCcw };
}

/** Move p toward z-axis in XY by dist (inward). */
function offsetInwardXY(
  p: [number, number, number],
  dist: number
): [number, number, number] {
  const L = Math.hypot(p[0], p[1]);
  if (L < 1e-12) return [p[0], p[1], p[2]];
  const s = dist / L;
  return [p[0] - p[0] * s, p[1] - p[1] * s, p[2]];
}

/**
 * Crown point on meridian θ at k, then inset toward the head (inside outer shell).
 */
function outerSurfacePoint(
  sk: BuiltSkeleton,
  theta: number,
  kFloat: number,
  M: number,
  N: number,
  inset: number
): [number, number, number] {
  const p = crownMeridianPointAtK(sk, theta, kFloat, M, N);
  return offsetInwardXY(p, inset);
}

/**
 * Quarter-circle style fillet in the plane of horizontal inward N and meridian direction T,
 * from corner A toward the segment A→B (same pattern as visor rim fillet).
 */
function filletArcFromCorner(
  A: [number, number, number],
  B: [number, number, number],
  R: number,
  steps: number
): [number, number, number][] {
  const N = radialInwardXY(A);
  let T = normalize3(sub(B, A));
  const d = dot(T, N);
  T = normalize3([T[0] - d * N[0], T[1] - d * N[1], T[2] - d * N[2]]);
  if (len3(T) < 1e-10) {
    T = [0, 0, 1];
  }
  const out: [number, number, number][] = [];
  for (let k = 0; k <= steps; k++) {
    const phi = (k / steps) * (0.5 * Math.PI);
    const inward = R * (1 - Math.cos(phi));
    const along = R * Math.sin(phi);
    out.push([
      A[0] + N[0] * inward + T[0] * along,
      A[1] + N[1] * inward + T[1] * along,
      A[2] + N[2] * inward + T[2] * along,
    ]);
  }
  return out;
}

/** One θ column: outer points per ring (bottom → top), following the crown meridian + fillets. */
function buildOuterColumn(
  sk: BuiltSkeleton,
  theta: number,
  M: number,
  N: number,
  inset: number,
  thickness: number,
  heightScale = 1
): { outer: [number, number, number][]; inner: [number, number, number][] } {
  const dz = Math.max(SWEATBAND_HEIGHT_M * heightScale, 1e-10);
  const kTop = findKRingForDeltaZ(sk, theta, M, N, dz);
  let kf = Math.min(kTop * 0.12, kTop * 0.45);
  if (kf > kTop * 0.5 - 1e-6) {
    kf = kTop * 0.25;
  }
  if (kf < 1e-8) {
    kf = Math.min(kTop * 0.05, kTop * 0.5);
  }

  const P0 = outerSurfacePoint(sk, theta, 0, M, N, inset);
  const Pkf = outerSurfacePoint(sk, theta, kf, M, N, inset);
  const Ptk = outerSurfacePoint(sk, theta, kTop - kf, M, N, inset);
  const PT = outerSurfacePoint(sk, theta, kTop, M, N, inset);

  const segLen = len3(sub(Pkf, P0));
  const Rf = Math.min(0.00055, thickness * 0.35, segLen * 0.42);

  const arcBot = filletArcFromCorner(P0, Pkf, Rf, FILLET_STEPS);
  const arcTop = filletArcFromCorner(Ptk, PT, Rf, FILLET_STEPS);

  const outer: [number, number, number][] = [];
  for (let i = 0; i < FILLET_STEPS; i++) {
    outer.push(arcBot[i]!);
  }
  outer.push(Pkf);

  for (let s = 1; s <= LINEAR_RING_COUNT; s++) {
    const k = kf + (s / (LINEAR_RING_COUNT + 1)) * (kTop - 2 * kf);
    outer.push(outerSurfacePoint(sk, theta, k, M, N, inset));
  }
  outer.push(Ptk);

  for (let i = 1; i < arcTop.length - 1; i++) {
    outer.push(arcTop[i]!);
  }
  outer.push(PT);

  const inner = outer.map((p) => offsetInwardXY(p, thickness));
  return { outer, inner };
}

export type SweatbandGeometryOptions = {
  /** When true, mesh only the front arc between closure rails (no CSG). */
  closure?: boolean;
};

/**
 * Solid sweatband: follows crown meridians (no vertical cylinder), radial thickness,
 * bottom/top edge fillets. Outer surface is inset inside the crown shell.
 */
export function buildSweatbandGeometry(
  sk: BuiltSkeleton,
  options: SweatbandGeometryOptions = {}
): THREE.BufferGeometry {
  const M = crownArcSegments(sk.spec);
  const N = crownVerticalRings(sk.spec);
  const inset = SWEATBAND_OUTER_INSET_M;
  const thickness = SWEATBAND_THICKNESS_M;
  const nSeg = SWEATBAND_SEGMENTS;
  const closure = options.closure === true;

  let thetas: number[] = [];
  /** Front arc only (open strip); false when degenerate span falls back to full ring. */
  let openArc = false;

  if (closure) {
    const { tW, rimAnchor } = getBackClosureOpeningFrame(sk);
    const halfW = BACK_CLOSURE_WIDTH_M * 0.5;
    const left: [number, number, number] = [
      rimAnchor[0] - halfW * tW[0],
      rimAnchor[1] - halfW * tW[1],
      rimAnchor[2] - halfW * tW[2],
    ];
    const right: [number, number, number] = [
      rimAnchor[0] + halfW * tW[0],
      rimAnchor[1] + halfW * tW[1],
      rimAnchor[2] + halfW * tW[2],
    ];
    const spec = sk.spec;
    const thetaL = rimWorldXYToSweatbandTheta(spec, left[0], left[1]);
    const thetaR = rimWorldXYToSweatbandTheta(spec, right[0], right[1]);
    const { start, span } = sweatbandFrontArcStartAndSpan(thetaL, thetaR);
    if (span < 0.15) {
      thetas = Array.from({ length: nSeg }, (_, i) => (i / nSeg) * 2 * Math.PI);
      openArc = false;
    } else {
      const denom = Math.max(nSeg - 1, 1);
      thetas = Array.from({ length: nSeg }, (_, i) =>
        normalizeAngle(start + (i / denom) * span)
      );
      openArc = true;
    }
  } else {
    thetas = Array.from({ length: nSeg }, (_, i) => (i / nSeg) * 2 * Math.PI);
  }

  const outerCols: [number, number, number][][] = [];
  const innerCols: [number, number, number][][] = [];
  let ringCount = 0;

  for (let i = 0; i < nSeg; i++) {
    const theta = thetas[i]!;
    const { outer, inner } = buildOuterColumn(sk, theta, M, N, inset, thickness);
    outerCols.push(outer);
    innerCols.push(inner);
    if (ringCount === 0) ringCount = outer.length;
    else if (outer.length !== ringCount) {
      throw new Error("sweatband ring count mismatch across θ");
    }
  }

  if (ringCount < 2) {
    return new THREE.BufferGeometry();
  }

  const positions: number[] = [];
  const R = ringCount;
  const wrap = !openArc;

  for (let r = 0; r < R - 1; r++) {
    const iMax = wrap ? nSeg : nSeg - 1;
    for (let i = 0; i < iMax; i++) {
      const j = wrap ? (i + 1) % nSeg : i + 1;
      const ob = outerCols[i]![r]!;
      const obn = outerCols[j]![r]!;
      const ot = outerCols[i]![r + 1]!;
      const otn = outerCols[j]![r + 1]!;
      const ib = innerCols[i]![r]!;
      const ibn = innerCols[j]![r]!;
      const it = innerCols[i]![r + 1]!;
      const itn = innerCols[j]![r + 1]!;

      pushQuad(positions, ob, obn, otn, ot);
      pushQuad(positions, ibn, ib, it, itn);
      pushQuad(positions, ob, ib, ibn, obn);
      pushQuad(positions, ot, otn, itn, it);
    }
  }

  if (openArc && nSeg >= 2) {
    for (let r = 0; r < R - 1; r++) {
      const ob0 = outerCols[0]![r]!;
      const ot0 = outerCols[0]![r + 1]!;
      const ib0 = innerCols[0]![r]!;
      const it0 = innerCols[0]![r + 1]!;
      pushQuad(positions, ob0, ib0, it0, ot0);
      const last = nSeg - 1;
      const obL = outerCols[last]![r]!;
      const otL = outerCols[last]![r + 1]!;
      const ibL = innerCols[last]![r]!;
      const itL = innerCols[last]![r + 1]!;
      pushQuad(positions, obL, otL, itL, ibL);
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geo.computeVertexNormals();
  return geo;
}
