import * as THREE from "three";
import type { BuiltSkeleton } from "@/lib/skeleton/geometry";
import type { HatSkeletonSpec } from "@/lib/skeleton/types";
import {
  BACK_CLOSURE_WIDTH_M,
  BACK_CLOSURE_TAPE_MARGIN_M,
  getBackClosureOpeningFrame,
} from "@/lib/mesh/backClosureSubtract";
import {
  CROWN_SHELL_THICKNESS_M,
  crownArcSegments,
  crownMeridianPointAtK,
  crownVerticalRings,
  findKRingForDeltaZ,
} from "@/lib/mesh/crownMesh";

/** Vertical rise (+Z in skeleton space) from the brim along each crown meridian (0.9375 in). */
export const SWEATBAND_HEIGHT_M = 0.9375 * 0.0254;

/** Radial thickness (inner vs outer surface). */
export const SWEATBAND_THICKNESS_M = 0.0015;

/** XY inset from crown surface toward the head (m). */
export const SWEATBAND_OUTER_INSET_M = CROWN_SHELL_THICKNESS_M;

/** Samples around the rim (full ring) or along the front arc when closure is on. */
export const SWEATBAND_SEGMENTS = 96;

/**
 * When the sweatband is an open strip (closure rails), extend each end slightly into the rear
 * closure gap so the strip runs almost flush with the closure arc. Clamped so a minimum gap remains.
 */
export const SWEATBAND_CLOSURE_ARC_EXTEND_RAD = 0.02;

const FILLET_STEPS = 4;
/** Interior samples along k between kf and (kTop − kf), excluding those endpoints. */
const LINEAR_RING_COUNT = 11;

type UVPair = [number, number];

function pushTriangle(
  positions: number[],
  uvs: number[],
  a: [number, number, number],
  b: [number, number, number],
  c: [number, number, number],
  ua: UVPair,
  ub: UVPair,
  uc: UVPair,
): void {
  positions.push(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2]);
  uvs.push(ua[0], ua[1], ub[0], ub[1], uc[0], uc[1]);
}

function pushQuad(
  positions: number[],
  uvs: number[],
  a: [number, number, number],
  b: [number, number, number],
  c: [number, number, number],
  d: [number, number, number],
  ua: UVPair,
  ub: UVPair,
  uc: UVPair,
  ud: UVPair,
): void {
  pushTriangle(positions, uvs, a, b, c, ua, ub, uc);
  pushTriangle(positions, uvs, a, c, d, ua, uc, ud);
}

function sub(
  a: [number, number, number],
  b: [number, number, number],
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

function dot(a: [number, number, number], b: [number, number, number]): number {
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
export function rimWorldXYToSweatbandTheta(
  spec: HatSkeletonSpec,
  x: number,
  y: number,
): number {
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
export function sweatbandFrontArcStartAndSpan(
  thetaL: number,
  thetaR: number,
): {
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

/**
 * Short arc (rear gap / closure strip) between closure rails: CCW start and span.
 * Complement of {@link sweatbandFrontArcStartAndSpan}.
 */
export function sweatbandRearArcStartAndSpan(
  thetaL: number,
  thetaR: number,
): {
  start: number;
  span: number;
} {
  const L = normalizeAngle(thetaL);
  const R2 = normalizeAngle(thetaR);
  const dCcw = normalizeAngle(R2 - L);
  if (dCcw <= Math.PI + 1e-9) {
    return { start: L, span: dCcw };
  }
  return { start: R2, span: 2 * Math.PI - dCcw };
}

/** Move p toward z-axis in XY by dist (inward). Negative dist pushes outward. */
export function offsetInwardXY(
  p: [number, number, number],
  dist: number,
): [number, number, number] {
  const L = Math.hypot(p[0], p[1]);
  if (L < 1e-12) return [p[0], p[1], p[2]];
  const s = dist / L;
  return [p[0] - p[0] * s, p[1] - p[1] * s, p[2]];
}

/**
 * Crown point on meridian θ at k, then inset toward the head (inside outer shell).
 */
export function outerSurfacePoint(
  sk: BuiltSkeleton,
  theta: number,
  kFloat: number,
  M: number,
  N: number,
  inset: number,
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
  steps: number,
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
export function buildOuterColumn(
  sk: BuiltSkeleton,
  theta: number,
  M: number,
  N: number,
  inset: number,
  thickness: number,
  heightScale = 1,
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

/** Parameters describing how the sweatband bulges outward where the visor tucks underneath. */
export interface VisorTuckLiftParams {
  thetaCenter: number;
  halfSpanRad: number;
  liftAmount: number;
  liftHeightM: number;
  blendAngleRad: number;
}

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

function visorLiftAlpha(theta: number, lift: VisorTuckLiftParams): number {
  let d = theta - lift.thetaCenter;
  while (d > Math.PI) d -= 2 * Math.PI;
  while (d < -Math.PI) d += 2 * Math.PI;
  const dist = Math.abs(d);
  if (dist >= lift.halfSpanRad) return 0;
  const innerEdge = lift.halfSpanRad - lift.blendAngleRad;
  if (dist <= innerEdge) return 1;
  return 1 - smoothstep(innerEdge, lift.halfSpanRad, dist);
}

/** Pushes the sweatband outward at the closure rail edges so it overlaps the closure tabs. */
export interface ClosureEdgeLiftParams {
  thetaL: number;
  thetaR: number;
  /** Outward push amount (m) — should match or exceed the tab plastic thickness. */
  liftAmount: number;
  /** Angular width of the smooth blend on each side of the rail (rad). */
  blendRad: number;
}

function closureEdgeLiftAlpha(
  theta: number,
  params: ClosureEdgeLiftParams,
): number {
  const { thetaL, thetaR, blendRad } = params;
  let dL = theta - thetaL;
  while (dL > Math.PI) dL -= 2 * Math.PI;
  while (dL < -Math.PI) dL += 2 * Math.PI;
  let dR = theta - thetaR;
  while (dR > Math.PI) dR -= 2 * Math.PI;
  while (dR < -Math.PI) dR += 2 * Math.PI;
  const aL =
    Math.abs(dL) < blendRad ? 1 - smoothstep(0, blendRad, Math.abs(dL)) : 0;
  const aR =
    Math.abs(dR) < blendRad ? 1 - smoothstep(0, blendRad, Math.abs(dR)) : 0;
  return Math.max(aL, aR);
}

/**
 * Visor-style tuck at both back-closure rails: same inward + vertical fade as {@link VisorTuckLiftParams}.
 * Use instead of {@link ClosureEdgeLiftParams} when you want the strip to wrap the closure like the visor.
 */
export type BackClosureTuckLiftParams = {
  left: VisorTuckLiftParams;
  right: VisorTuckLiftParams;
};

/**
 * `full` = one closed shell (default). `outer` / `inner` = longitudinal faces only (export split so
 * decals / textures do not project through both sides).
 */
export type SweatbandGeometryShell = "full" | "outer" | "inner";

export type SweatbandGeometryOptions = {
  /** When true, mesh only the front arc between closure rails (no CSG). */
  closure?: boolean;
  /** When provided, bulge the sweatband outward in the visor tuck region. */
  lift?: VisorTuckLiftParams;
  /** When provided, raise sweatband at closure rail θ angles so it overlaps tab edges. */
  closureEdgeLift?: ClosureEdgeLiftParams;
  /**
   * When provided, tuck the sweatband inward under the snapback region (same math as visor tuck).
   * Prefer this over {@link closureEdgeLift} for a glove-like wrap; do not pass both.
   */
  backClosureTuck?: BackClosureTuckLiftParams;
  /** GLB export: emit only the outer or inner fabric surface (see {@link SweatbandGeometryShell}). */
  shell?: SweatbandGeometryShell;
};

/**
 * Solid sweatband: follows crown meridians (no vertical cylinder), radial thickness,
 * bottom/top edge fillets. Outer surface is inset inside the crown shell.
 */
export function buildSweatbandGeometry(
  sk: BuiltSkeleton,
  options: SweatbandGeometryOptions = {},
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
    const halfW =
      (BACK_CLOSURE_WIDTH_M + BACK_CLOSURE_TAPE_MARGIN_M) * 0.5 + 0.01;
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
      const rearGap = 2 * Math.PI - span;
      const extend = Math.min(
        SWEATBAND_CLOSURE_ARC_EXTEND_RAD,
        Math.max(0, (rearGap - 0.02) * 0.5),
      );
      const spanOpen = span + 2 * extend;
      const startOpen = normalizeAngle(start - extend);
      const denom = Math.max(nSeg - 1, 1);
      thetas = Array.from({ length: nSeg }, (_, i) =>
        normalizeAngle(startOpen + (i / denom) * spanOpen),
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
    const { outer, inner } = buildOuterColumn(
      sk,
      theta,
      M,
      N,
      inset,
      thickness,
    );
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

  const lift = options.lift;
  if (lift && lift.liftAmount > 1e-8) {
    for (let i = 0; i < nSeg; i++) {
      const theta = thetas[i]!;
      const alpha = visorLiftAlpha(theta, lift);
      if (alpha < 1e-8) continue;
      for (let r = 0; r < ringCount; r++) {
        const op = outerCols[i]![r]!;
        const beta = Math.max(0, 1 - op[2] / lift.liftHeightM);
        const push = lift.liftAmount * alpha * beta;
        if (push < 1e-8) continue;
        // Positive dist moves toward the axis (smaller XY radius), away from the crown outer shell.
        outerCols[i]![r] = offsetInwardXY(op, push);
        innerCols[i]![r] = offsetInwardXY(outerCols[i]![r]!, thickness);
      }
    }
  }

  const bct = options.backClosureTuck;
  if (bct && bct.left.liftAmount > 1e-8) {
    const amt = bct.left.liftAmount;
    for (let i = 0; i < nSeg; i++) {
      const theta = thetas[i]!;
      const alpha = Math.max(
        visorLiftAlpha(theta, bct.left),
        visorLiftAlpha(theta, bct.right),
      );
      if (alpha < 1e-8) continue;
      // Snapback meets the strip on the vertical cut edges. Tuck is strongest mid-edge so rim (r=0) and
      // crown end (r=ringCount-1) stay on the crown-following column; uniform tuck left corners floating.
      const rMax = Math.max(ringCount - 1, 1);
      for (let r = 0; r < ringCount; r++) {
        const op = outerCols[i]![r]!;
        const edgeGamma = Math.sin((Math.PI * r) / rMax);
        const push = amt * alpha * edgeGamma;
        if (push < 1e-8) continue;
        outerCols[i]![r] = offsetInwardXY(op, push);
        innerCols[i]![r] = offsetInwardXY(outerCols[i]![r]!, thickness);
      }
    }
  }

  const ceLift = options.closureEdgeLift;
  if (ceLift && ceLift.liftAmount > 1e-8) {
    for (let i = 0; i < nSeg; i++) {
      const theta = thetas[i]!;
      const alpha = closureEdgeLiftAlpha(theta, ceLift);
      if (alpha < 1e-8) continue;
      for (let r = 0; r < ringCount; r++) {
        const op = outerCols[i]![r]!;
        const push = ceLift.liftAmount * alpha;
        outerCols[i]![r] = offsetInwardXY(op, -push);
        innerCols[i]![r] = offsetInwardXY(outerCols[i]![r]!, thickness);
      }
    }
  }

  const positions: number[] = [];
  const uvs: number[] = [];
  const R = ringCount;
  const wrap = !openArc;

  const shell = options.shell ?? "full";
  const isFull = shell === "full";
  const wantOuter = shell === "outer" || isFull;
  const wantInner = shell === "inner" || isFull;

  const uAt = (i: number) =>
    wrap ? i / Math.max(1, nSeg) : i / Math.max(1, nSeg - 1);
  const vAt = (r: number) => r / Math.max(1, R - 1);

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
      const ui = uAt(i);
      const uj = uAt(j);
      const vr = vAt(r);
      const vrp = vAt(r + 1);

      if (wantOuter) {
        pushQuad(
          positions,
          uvs,
          ob,
          obn,
          otn,
          ot,
          [ui, vr],
          [uj, vr],
          [uj, vrp],
          [ui, vrp],
        );
      }
      if (wantInner) {
        pushQuad(
          positions,
          uvs,
          ibn,
          ib,
          it,
          itn,
          [uj, vr],
          [ui, vr],
          [ui, vrp],
          [uj, vrp],
        );
      }
      if (isFull) {
        pushQuad(
          positions,
          uvs,
          ob,
          ib,
          ibn,
          obn,
          [ui, 0],
          [ui, 1],
          [uj, 1],
          [uj, 0],
        );
        pushQuad(
          positions,
          uvs,
          ot,
          otn,
          itn,
          it,
          [ui, 0],
          [uj, 0],
          [uj, 1],
          [ui, 1],
        );
      }
    }
  }

  if (openArc && nSeg >= 2) {
    for (let r = 0; r < R - 1; r++) {
      const ob0 = outerCols[0]![r]!;
      const ot0 = outerCols[0]![r + 1]!;
      const ib0 = innerCols[0]![r]!;
      const it0 = innerCols[0]![r + 1]!;
      const vr = vAt(r);
      const vrp = vAt(r + 1);
      if (isFull) {
        pushQuad(
          positions,
          uvs,
          ob0,
          ib0,
          it0,
          ot0,
          [0, vr],
          [1, vr],
          [1, vrp],
          [0, vrp],
        );
      } else {
        if (wantOuter) {
          pushTriangle(
            positions,
            uvs,
            ob0,
            it0,
            ot0,
            [0, vr],
            [1, vrp],
            [0, vrp],
          );
        }
        if (wantInner) {
          pushTriangle(
            positions,
            uvs,
            ob0,
            ib0,
            it0,
            [0, vr],
            [1, vr],
            [1, vrp],
          );
        }
      }
      const last = nSeg - 1;
      const obL = outerCols[last]![r]!;
      const otL = outerCols[last]![r + 1]!;
      const ibL = innerCols[last]![r]!;
      const itL = innerCols[last]![r + 1]!;
      if (isFull) {
        pushQuad(
          positions,
          uvs,
          obL,
          otL,
          itL,
          ibL,
          [0, vr],
          [0, vrp],
          [1, vrp],
          [1, vr],
        );
      } else {
        if (wantOuter) {
          pushTriangle(
            positions,
            uvs,
            obL,
            otL,
            itL,
            [0, vr],
            [0, vrp],
            [1, vrp],
          );
        }
        if (wantInner) {
          pushTriangle(
            positions,
            uvs,
            obL,
            itL,
            ibL,
            [0, vr],
            [1, vrp],
            [1, vr],
          );
        }
      }
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
  geo.computeVertexNormals();
  return geo;
}
