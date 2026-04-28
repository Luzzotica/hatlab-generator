import * as THREE from "three";
import type { BuiltSkeleton } from "@/lib/skeleton/geometry";
import { sweatbandTangentTheta } from "@/lib/skeleton/geometry";
import {
  CROWN_MESH_HALF_MM_M,
  CROWN_SHELL_THICKNESS_M,
  crownArcSegments,
  crownMeridianPointAtK,
  crownVerticalRings,
  findKRingForDeltaZ,
} from "@/lib/mesh/crownMesh";
import { offsetInwardXY } from "@/lib/mesh/sweatbandMesh";

/** Radial clearance between stacked closure tabs (not tab thickness). */
export const CLOSURE_TAB_LAYER_GAP_M = 0.00012;
/** Nudge back (outer) strap slightly inward so it meets the stacked strap. */
export const CLOSURE_BACK_TAB_RADIAL_NUDGE_M = 0.00025;
/** Angular half-width of the stacked tab overlap from rear-arc center. */
export const CLOSURE_TAB_OVERLAP_FRAC = 0.28;
/** How far the tab outer surface sits inside the crown shell (radial inset). */
export const CLOSURE_TAB_INSET_M =
  CROWN_SHELL_THICKNESS_M + 2 * CROWN_MESH_HALF_MM_M;
/**
 * At free rail ends (outside the stacked overlap), ease outer surface toward the crown meridian.
 */
export const CLOSURE_TAB_FREE_END_INSET_M =
  0.0001 + 4 * CROWN_MESH_HALF_MM_M;

export const CLOSURE_TAB_H_M = 0.018;
export const CLOSURE_TAB_DEPTH_M = 0.001;

/** Default raised rim groove on snapback tabs; use 0 for flat fabric (e.g. velcro). */
export const CLOSURE_TAB_RIM_DEPTH_DEFAULT_M = 0.0004;
const TAB_RIM_BLEND_MIN = 0.065;
const TAB_RIM_BLEND_MAX = 0.2;

export const CLOSURE_TAB_ARC_SEGMENTS = 48;
export const CLOSURE_TAB_HEIGHT_RINGS = 8;
/** Extra rim arc length (m) past each closure rail (left + right). */
export const CLOSURE_EXTEND_RIM_M = 0.0075;
/** Segments on the semicircular free end. */
const ROUND_CAP_SEGMENTS = 12;
/** Segments per quarter-circle on rounded-rect ends. */
const ROUND_RECT_ARC_SEG = 5;
const ROUND_RECT_EDGE_SEG = 2;

/**
 * Half angular width (rad) around the rear arc center: blend crown samples across the seam groove.
 */
export const CLOSURE_SEAM_BRIDGE_HALF_RAD = 0.08;

export type SeamBridgeParams = { bridgeCenter: number; halfWidth: number };

function smoothstep01(t: number): number {
  const x = THREE.MathUtils.clamp(t, 0, 1);
  return x * x * (3 - 2 * x);
}

function lerp3(
  a: [number, number, number],
  b: [number, number, number],
  t: number,
): [number, number, number] {
  return [
    a[0] + (b[0] - a[0]) * t,
    a[1] + (b[1] - a[1]) * t,
    a[2] + (b[2] - a[2]) * t,
  ];
}

function outwardXY(
  p: readonly [number, number, number],
): [number, number, number] {
  const L = Math.hypot(p[0], p[1]);
  if (L < 1e-12) return [0, 0, 0];
  return [p[0] / L, p[1] / L, 0];
}

/** Max half-width so [center - w, center + w] is a subset of [thetaMin, thetaMax]. */
function clampBridgeHalfWidth(
  bridgeCenter: number,
  requestedHalf: number,
  thetaMin: number,
  thetaMax: number,
): number {
  if (requestedHalf <= 0 || thetaMax <= thetaMin + 1e-12) return 0;
  const maxHalf = Math.min(bridgeCenter - thetaMin, thetaMax - bridgeCenter);
  if (maxHalf <= 1e-9) return 0;
  return Math.min(requestedHalf, maxHalf - 1e-6);
}

export function seamBridgeForTab(
  rearArcCenter: number,
  thetaA: number,
  thetaB: number,
): SeamBridgeParams {
  if (rearArcCenter < thetaA - 1e-9 || rearArcCenter > thetaB + 1e-9) {
    return { bridgeCenter: rearArcCenter, halfWidth: 0 };
  }
  const halfWidth = clampBridgeHalfWidth(
    rearArcCenter,
    CLOSURE_SEAM_BRIDGE_HALF_RAD,
    thetaA,
    thetaB,
  );
  return { bridgeCenter: rearArcCenter, halfWidth };
}

/**
 * Across |theta - center| < halfWidth, lerp between crown samples at theta = center +/- halfWidth (same k),
 * skipping the seam groove in the middle of the band.
 */
export function crownMeridianPointAtKBridged(
  sk: BuiltSkeleton,
  theta: number,
  kFloat: number,
  M: number,
  N: number,
  bridge: SeamBridgeParams,
): [number, number, number] {
  const { bridgeCenter, halfWidth } = bridge;
  if (halfWidth <= 1e-12) {
    return crownMeridianPointAtK(sk, theta, kFloat, M, N);
  }
  let d = theta - bridgeCenter;
  while (d > Math.PI) d -= 2 * Math.PI;
  while (d < -Math.PI) d += 2 * Math.PI;
  if (Math.abs(d) >= halfWidth - 1e-12) {
    return crownMeridianPointAtK(sk, theta, kFloat, M, N);
  }
  const t = smoothstep01((d + halfWidth) / (2 * halfWidth));
  const pLeft = crownMeridianPointAtK(
    sk,
    bridgeCenter - halfWidth,
    kFloat,
    M,
    N,
  );
  const pRight = crownMeridianPointAtK(
    sk,
    bridgeCenter + halfWidth,
    kFloat,
    M,
    N,
  );
  return lerp3(pLeft, pRight, t);
}

function smoothClosureColumnsInTheta(
  outerCols: [number, number, number][][],
  innerCols: [number, number, number][][],
  thickness: number,
): void {
  const nSeg = outerCols.length - 1;
  if (nSeg < 2) return;
  const R = outerCols[0]!.length;
  const copy = outerCols.map((col) =>
    col.map((p) => [...p] as [number, number, number]),
  );
  for (let i = 1; i < nSeg; i++) {
    for (let r = 0; r < R; r++) {
      const a = outerCols[i - 1]![r]!;
      const b = outerCols[i]![r]!;
      const c = outerCols[i + 1]![r]!;
      copy[i]![r] = [
        a[0] * 0.25 + b[0] * 0.5 + c[0] * 0.25,
        a[1] * 0.25 + b[1] * 0.5 + c[1] * 0.25,
        a[2] * 0.25 + b[2] * 0.5 + c[2] * 0.25,
      ];
    }
  }
  for (let i = 1; i < nSeg; i++) {
    outerCols[i] = copy[i]!;
    for (let r = 0; r < R; r++) {
      innerCols[i]![r] = offsetInwardXY(outerCols[i]![r]!, thickness);
    }
  }
}

function tabRimFactorFromGrid(
  i: number,
  nSeg: number,
  r: number,
  nRings: number,
): number {
  const u = i / Math.max(nSeg, 1);
  const v = r / Math.max(nRings, 1);
  const edgeDist = Math.min(u, 1 - u, v, 1 - v);
  return smoothstep01(
    (edgeDist - TAB_RIM_BLEND_MIN) /
      Math.max(TAB_RIM_BLEND_MAX - TAB_RIM_BLEND_MIN, 1e-6),
  );
}

function indentPointRadialTabRim(
  p: [number, number, number],
  rimFactor: number,
  rimDepthM: number,
): [number, number, number] {
  if (rimDepthM < 1e-12 || rimFactor < 1e-10) return p;
  const out = outwardXY(p);
  const d = rimDepthM * rimFactor;
  return [p[0] - out[0] * d, p[1] - out[1] * d, p[2] - out[2] * d];
}

function applyTabRimIndentField(
  outerCols: [number, number, number][][],
  innerCols: [number, number, number][][],
  thickness: number,
  nSeg: number,
  nRings: number,
  rimDepthM: number,
): void {
  if (rimDepthM < 1e-12) return;
  const R = nRings + 1;
  for (let i = 0; i <= nSeg; i++) {
    for (let r = 0; r < R; r++) {
      const f = tabRimFactorFromGrid(i, nSeg, r, nRings);
      outerCols[i]![r] = indentPointRadialTabRim(outerCols[i]![r]!, f, rimDepthM);
    }
  }
  for (let i = 0; i <= nSeg; i++) {
    for (let r = 0; r < R; r++) {
      innerCols[i]![r] = offsetInwardXY(outerCols[i]![r]!, thickness);
    }
  }
}

function pushQuad(
  positions: number[],
  a: [number, number, number],
  b: [number, number, number],
  c: [number, number, number],
  d: [number, number, number],
): void {
  positions.push(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2]);
  positions.push(a[0], a[1], a[2], c[0], c[1], c[2], d[0], d[1], d[2]);
}

function pushTriangle(
  positions: number[],
  a: [number, number, number],
  b: [number, number, number],
  c: [number, number, number],
): void {
  positions.push(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2]);
}

export type ClosureTabEndCapStyle = "semicircle" | "roundedRect";

export interface BuildCrownFollowingTabOptions {
  /** Default semicircle (snapback); roundedRect = mostly flat end with small corner fillets. */
  endCapStyle?: ClosureTabEndCapStyle;
  /** For roundedRect: corner radius as a fraction of min(half-width, half-height). Default 0.14. */
  roundedRectCornerFrac?: number;
  /** Raised rim groove depth; 0 = smooth flat fabric. */
  tabRimDepthM?: number;
}

/**
 * CCW 2D loop (u = tangent * sign, v = up) for a rounded rectangle: half-width a, half-height b.
 * One full turn with no duplicate closing vertex.
 */
function roundedRectLoop2D(
  a: number,
  b: number,
  r: number,
): [number, number][] {
  r = Math.min(r, a * 0.99, b * 0.99);
  const pts: [number, number][] = [];
  const ne = ROUND_RECT_EDGE_SEG;
  const na = ROUND_RECT_ARC_SEG;

  const segment = (
    ax: number,
    ay: number,
    bx: number,
    by: number,
    includeFirst: boolean,
  ) => {
    for (let i = includeFirst ? 0 : 1; i <= ne; i++) {
      const t = i / ne;
      pts.push([ax + (bx - ax) * t, ay + (by - ay) * t]);
    }
  };

  const arc = (cx: number, cy: number, a0: number, a1: number) => {
    for (let i = 1; i <= na; i++) {
      const t = i / na;
      const ang = a0 + t * (a1 - a0);
      pts.push([cx + r * Math.cos(ang), cy + r * Math.sin(ang)]);
    }
  };

  segment(-a + r, -b, a - r, -b, true);
  arc(a - r, -b + r, -Math.PI * 0.5, 0);
  segment(a, -b + r, a, b - r, false);
  arc(a - r, b - r, 0, Math.PI * 0.5);
  segment(a - r, b, -a + r, b, false);
  arc(-a + r, b - r, Math.PI * 0.5, Math.PI);
  segment(-a, b - r, -a, -b + r, false);
  arc(-a + r, -b + r, Math.PI, Math.PI * 1.5);

  if (pts.length > 1) {
    const p0 = pts[0]!;
    const pL = pts[pts.length - 1]!;
    if (Math.hypot(p0[0] - pL[0], p0[1] - pL[1]) < 1e-9) pts.pop();
  }
  return pts;
}

function localToWorld(
  mid: [number, number, number],
  u: number,
  v: number,
  upDir: [number, number, number],
  tDir: [number, number, number],
  sign: number,
): [number, number, number] {
  return [
    mid[0] + v * upDir[0] + u * tDir[0] * sign,
    mid[1] + v * upDir[1] + u * tDir[1] * sign,
    mid[2] + v * upDir[2] + u * tDir[2] * sign,
  ];
}

/**
 * Build a solid tab that follows the crown curvature along the rear rim arc.
 * See {@link BuildCrownFollowingTabOptions} for end-cap and rim styling.
 */
export function buildCrownFollowingTab(
  sk: BuiltSkeleton,
  thetaA: number,
  thetaB: number,
  nSeg: number,
  inset: number | ((theta: number) => number),
  roundAtStart: boolean,
  roundAtEnd: boolean,
  seamBridge: SeamBridgeParams,
  tabOpts?: BuildCrownFollowingTabOptions,
): THREE.BufferGeometry {
  const endCapStyle = tabOpts?.endCapStyle ?? "semicircle";
  const cornerFrac = tabOpts?.roundedRectCornerFrac ?? 0.14;
  const rimDepthM = tabOpts?.tabRimDepthM ?? CLOSURE_TAB_RIM_DEPTH_DEFAULT_M;

  const spec = sk.spec;
  const M = crownArcSegments(spec);
  const N = crownVerticalRings(spec);
  const thickness = CLOSURE_TAB_DEPTH_M;
  const nRings = CLOSURE_TAB_HEIGHT_RINGS;
  const span = thetaB - thetaA;

  const insetAt =
    typeof inset === "function" ? inset : (_theta: number) => inset;

  const outerCols: [number, number, number][][] = [];
  const innerCols: [number, number, number][][] = [];

  for (let i = 0; i <= nSeg; i++) {
    const u = i / nSeg;
    const theta = thetaA + u * span;
    const insetVal = insetAt(theta);

    const kTop = findKRingForDeltaZ(sk, theta, M, N, CLOSURE_TAB_H_M);

    const outer: [number, number, number][] = [];
    const inner: [number, number, number][] = [];
    for (let r = 0; r <= nRings; r++) {
      const kFloat = (r / nRings) * kTop;
      const p = crownMeridianPointAtKBridged(
        sk,
        theta,
        kFloat,
        M,
        N,
        seamBridge,
      );
      const oP = offsetInwardXY(p, insetVal);
      outer.push(oP);
      inner.push(offsetInwardXY(oP, thickness));
    }
    outerCols.push(outer);
    innerCols.push(inner);
  }

  smoothClosureColumnsInTheta(outerCols, innerCols, thickness);
  applyTabRimIndentField(
    outerCols,
    innerCols,
    thickness,
    nSeg,
    nRings,
    rimDepthM,
  );

  const R = nRings + 1;
  const positions: number[] = [];

  for (let r = 0; r < R - 1; r++) {
    for (let i = 0; i < nSeg; i++) {
      const ob = outerCols[i]![r]!;
      const obn = outerCols[i + 1]![r]!;
      const ot = outerCols[i]![r + 1]!;
      const otn = outerCols[i + 1]![r + 1]!;
      const ib = innerCols[i]![r]!;
      const ibn = innerCols[i + 1]![r]!;
      const it = innerCols[i]![r + 1]!;
      const itn = innerCols[i + 1]![r + 1]!;

      pushQuad(positions, ob, obn, otn, ot);
      pushQuad(positions, ibn, ib, it, itn);
    }
  }

  for (let i = 0; i < nSeg; i++) {
    const ob = outerCols[i]![0]!;
    const obn = outerCols[i + 1]![0]!;
    const ib = innerCols[i]![0]!;
    const ibn = innerCols[i + 1]![0]!;
    pushQuad(positions, ob, obn, ibn, ib);
  }

  for (let i = 0; i < nSeg; i++) {
    const ot = outerCols[i]![R - 1]!;
    const otn = outerCols[i + 1]![R - 1]!;
    const it = innerCols[i]![R - 1]!;
    const itn = innerCols[i + 1]![R - 1]!;
    pushQuad(positions, ot, otn, itn, it);
  }

  if (!roundAtStart) {
    for (let r = 0; r < R - 1; r++) {
      pushQuad(
        positions,
        outerCols[0]![r]!,
        innerCols[0]![r]!,
        innerCols[0]![r + 1]!,
        outerCols[0]![r + 1]!,
      );
    }
  }
  if (!roundAtEnd) {
    for (let r = 0; r < R - 1; r++) {
      pushQuad(
        positions,
        outerCols[nSeg]![r]!,
        outerCols[nSeg]![r + 1]!,
        innerCols[nSeg]![r + 1]!,
        innerCols[nSeg]![r]!,
      );
    }
  }

  function appendRoundEndCap(col: number): void {
    const outerStrip = outerCols[col]!;
    const pBot = outerStrip[0]!;
    const pTop = outerStrip[R - 1]!;
    const mid: [number, number, number] = [
      (pBot[0] + pTop[0]) * 0.5,
      (pBot[1] + pTop[1]) * 0.5,
      (pBot[2] + pTop[2]) * 0.5,
    ];
    const halfH =
      Math.hypot(pTop[0] - pBot[0], pTop[1] - pBot[1], pTop[2] - pBot[2]) * 0.5;
    if (halfH < 1e-8) return;

    const upDir: [number, number, number] = [
      (pTop[0] - pBot[0]) / (2 * halfH),
      (pTop[1] - pBot[1]) / (2 * halfH),
      (pTop[2] - pBot[2]) / (2 * halfH),
    ];

    const theta = col === 0 ? thetaA : thetaB;
    const tang = sweatbandTangentTheta(
      theta,
      spec.semiAxisX,
      spec.semiAxisY,
      spec.yawRad,
    );
    const tangLen = Math.hypot(tang[0], tang[1], tang[2]);
    const tDir: [number, number, number] =
      tangLen > 1e-12
        ? [tang[0] / tangLen, tang[1] / tangLen, tang[2] / tangLen]
        : [0, 1, 0];
    const sign = col === 0 ? -1 : 1;

    if (endCapStyle === "roundedRect") {
      const halfW = halfH * 0.94;
      const halfHu = halfH;
      const rCorn = Math.min(halfW, halfHu) * cornerFrac;
      const loop2d = roundedRectLoop2D(halfW, halfHu, rCorn);
      const n = loop2d.length;
      const outerArc: [number, number, number][] = [];
      const innerArc: [number, number, number][] = [];
      for (let j = 0; j < n; j++) {
        const [u, v] = loop2d[j]!;
        const o = localToWorld(mid, u, v, upDir, tDir, sign);
        const ax = Math.abs(u);
        const ay = Math.abs(v);
        const rf = smoothstep01(
          (Math.min(halfW - ax, halfHu - ay) - TAB_RIM_BLEND_MIN) /
            Math.max(TAB_RIM_BLEND_MAX - TAB_RIM_BLEND_MIN, 1e-6),
        );
        const oi =
          rimDepthM < 1e-12 ? o : indentPointRadialTabRim(o, rf, rimDepthM);
        outerArc.push(oi);
        innerArc.push(offsetInwardXY(oi, thickness));
      }
      for (let j = 0; j < n; j++) {
        const jn = (j + 1) % n;
        pushQuad(positions, outerArc[j]!, outerArc[jn]!, innerArc[jn]!, innerArc[j]!);
      }
      const innerStrip = innerCols[col]!;
      const midInner: [number, number, number] = [
        (innerStrip[0]![0] + innerStrip[R - 1]![0]) * 0.5,
        (innerStrip[0]![1] + innerStrip[R - 1]![1]) * 0.5,
        (innerStrip[0]![2] + innerStrip[R - 1]![2]) * 0.5,
      ];
      for (let j = 0; j < n; j++) {
        const jn = (j + 1) % n;
        pushTriangle(positions, mid, outerArc[j]!, outerArc[jn]!);
        pushTriangle(positions, midInner, innerArc[jn]!, innerArc[j]!);
      }
      return;
    }

    for (let k = 0; k < ROUND_CAP_SEGMENTS; k++) {
      const phi0 = -Math.PI * 0.5 + (k / ROUND_CAP_SEGMENTS) * Math.PI;
      const phi1 = -Math.PI * 0.5 + ((k + 1) / ROUND_CAP_SEGMENTS) * Math.PI;

      const o0: [number, number, number] = [
        mid[0] +
          halfH * Math.sin(phi0) * upDir[0] +
          halfH * Math.cos(phi0) * tDir[0] * sign,
        mid[1] +
          halfH * Math.sin(phi0) * upDir[1] +
          halfH * Math.cos(phi0) * tDir[1] * sign,
        mid[2] +
          halfH * Math.sin(phi0) * upDir[2] +
          halfH * Math.cos(phi0) * tDir[2] * sign,
      ];
      const o1: [number, number, number] = [
        mid[0] +
          halfH * Math.sin(phi1) * upDir[0] +
          halfH * Math.cos(phi1) * tDir[0] * sign,
        mid[1] +
          halfH * Math.sin(phi1) * upDir[1] +
          halfH * Math.cos(phi1) * tDir[1] * sign,
        mid[2] +
          halfH * Math.sin(phi1) * upDir[2] +
          halfH * Math.cos(phi1) * tDir[2] * sign,
      ];
      const rf0 = 1 - Math.abs(Math.sin(phi0));
      const rf1 = 1 - Math.abs(Math.sin(phi1));
      const o0i =
        rimDepthM < 1e-12 ? o0 : indentPointRadialTabRim(o0, rf0, rimDepthM);
      const o1i =
        rimDepthM < 1e-12 ? o1 : indentPointRadialTabRim(o1, rf1, rimDepthM);
      const i0 = offsetInwardXY(o0i, thickness);
      const i1 = offsetInwardXY(o1i, thickness);

      pushQuad(positions, o0i, o1i, i1, i0);
    }

    const outerArc: [number, number, number][] = [];
    const innerArc: [number, number, number][] = [];
    for (let j = 0; j <= ROUND_CAP_SEGMENTS; j++) {
      const phi = -Math.PI * 0.5 + (j / ROUND_CAP_SEGMENTS) * Math.PI;
      const o: [number, number, number] = [
        mid[0] +
          halfH * Math.sin(phi) * upDir[0] +
          halfH * Math.cos(phi) * tDir[0] * sign,
        mid[1] +
          halfH * Math.sin(phi) * upDir[1] +
          halfH * Math.cos(phi) * tDir[1] * sign,
        mid[2] +
          halfH * Math.sin(phi) * upDir[2] +
          halfH * Math.cos(phi) * tDir[2] * sign,
      ];
      const rf = 1 - Math.abs(Math.sin(phi));
      const oi = rimDepthM < 1e-12 ? o : indentPointRadialTabRim(o, rf, rimDepthM);
      outerArc.push(oi);
      innerArc.push(offsetInwardXY(oi, thickness));
    }
    const innerStrip = innerCols[col]!;
    const midInner: [number, number, number] = [
      (innerStrip[0]![0] + innerStrip[R - 1]![0]) * 0.5,
      (innerStrip[0]![1] + innerStrip[R - 1]![1]) * 0.5,
      (innerStrip[0]![2] + innerStrip[R - 1]![2]) * 0.5,
    ];
    for (let j = 0; j < ROUND_CAP_SEGMENTS; j++) {
      pushTriangle(positions, mid, outerArc[j]!, outerArc[j + 1]!);
      pushTriangle(positions, midInner, innerArc[j + 1]!, innerArc[j]!);
    }
  }

  if (roundAtEnd) appendRoundEndCap(nSeg);
  if (roundAtStart) appendRoundEndCap(0);

  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geo.computeVertexNormals();
  return geo;
}
