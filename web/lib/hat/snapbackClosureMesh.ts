import * as THREE from "three";
import type { BuiltSkeleton } from "@/lib/skeleton/geometry";
import { sweatbandPoint, sweatbandTangentTheta } from "@/lib/skeleton/geometry";
import {
  BACK_CLOSURE_TAPE_MARGIN_M,
  BACK_CLOSURE_WIDTH_M,
  getBackClosureOpeningFrame,
} from "@/lib/mesh/backClosureSubtract";
import {
  CROWN_MESH_HALF_MM_M,
  CROWN_SHELL_THICKNESS_M,
  crownArcSegments,
  crownMeridianPointAtK,
  crownVerticalRings,
  findKRingForDeltaZ,
} from "@/lib/mesh/crownMesh";
import {
  offsetInwardXY,
  rimWorldXYToSweatbandTheta,
  sweatbandRearArcStartAndSpan,
} from "@/lib/mesh/sweatbandMesh";
import { BASE_THREAD_Z_OFFSET_M } from "@/lib/hat/threadingMesh";

// ---------------------------------------------------------------------------
// Dimensions
// ---------------------------------------------------------------------------

const TAB_H_M = 0.018;
const TAB_DEPTH_M = 0.001;
/** Radial clearance between outer tab inner face and inner tab outer face (not tab thickness). */
const TAB_LAYER_GAP_M = 0.00012;
/** Nudge back (outer) strap slightly inward so it meets the stacked strap instead of floating. */
const BACK_TAB_RADIAL_NUDGE_M = 0.00025;
/** Angular half-width of the stacked tab overlap from rear-arc center (larger ⇒ wider snap zone). */
const TAB_OVERLAP_FRAC = 0.28;
/** How far the tab outer surface sits inside the crown shell (radial inset). */
const CLOSURE_INSET_M = CROWN_SHELL_THICKNESS_M + 2 * CROWN_MESH_HALF_MM_M;
/**
 * At free rail ends (outside the stacked overlap), ease outer surface toward the crown meridian.
 * Must be well below {@link CLOSURE_INSET_M} or the lerp is sub‑millimetre and invisible.
 */
const TAB_FREE_END_INSET_M = 0.0001 + 4 * CROWN_MESH_HALF_MM_M;

/**
 * Raised perimeter frame: extra radial inset on the tab field (center) vs the outer rim edge.
 * Applied after seam smoothing so the groove stays crisp.
 */
const TAB_RIM_DEPTH_M = 0.0004;
/** Normalized distance to nearest edge (in [0, 0.5]); blend where field indent ramps in. */
const TAB_RIM_BLEND_MIN = 0.065;
const TAB_RIM_BLEND_MAX = 0.2;

/** Male studs: flattened sphere (~50% of tab height diameter) + short stem on back tab only. */
const SNAP_EQUATOR_R_M = TAB_H_M * 0.11;
/** Squash along radial (local Y) so the stud reads as a dome, not a ball. */
const SNAP_FLATTEN_Y = 0.42;
const SNAP_STEM_R_M = SNAP_EQUATOR_R_M * 0.28;
const SNAP_STEM_H_M = 0.00034;
const SNAP_COUNT = 6;
/** Polyline samples for arc-length spacing of snaps along the back tab outer curve. */
const SNAP_ARCLEN_SAMPLES = 192;

/** Arc samples along each tab. */
const ARC_SEGMENTS = 48;
/** Radial samples (height rings) per column for the crown-following profile. */
const HEIGHT_RINGS = 8;
/** Extra rim arc length (m) past each closure rail (left + right); widens total closure arc. */
const CLOSURE_EXTEND_RIM_M = 0.0075;
/** Segments on the semicircular free end. */
const ROUND_CAP_SEGMENTS = 12;
/**
 * Half angular width (rad) around the rear arc center: blend crown samples across the seam groove
 * so the strap stays flat (see {@link crownMeridianPointAtKBridged}).
 */
const CLOSURE_SEAM_BRIDGE_HALF_RAD = 0.08;

const TAB_RENDER_ORDER = 4;
const SNAP_RENDER_ORDER = 5;

// ---------------------------------------------------------------------------

/** Same on both closure tabs — medium gray for visibility while iterating on shape. */
function closureTabMaterial(): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({
    color: 0x8e8e8e,
    flatShading: false,
    side: THREE.DoubleSide,
    metalness: 0.08,
    roughness: 0.78,
  });
}

function snapMaterial(): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({
    color: 0xa8a8a8,
    flatShading: false,
    side: THREE.DoubleSide,
    metalness: 0.28,
    roughness: 0.52,
  });
}

/**
 * Even spacing along arc length on the back tab outer surface (uniform θ would bunch
 * studs where the rim curve is tighter).
 */
function snapThetasEvenArcAlongBackOuter(
  sk: BuiltSkeleton,
  snapA: number,
  snapB: number,
  M: number,
  N: number,
  backInset: number,
  seamBridge: SeamBridgeParams,
  snapCount: number,
): number[] {
  const snapSpan = snapB - snapA;
  if (snapCount <= 0) return [];
  if (snapSpan <= 1e-12) {
    const mid = (snapA + snapB) * 0.5;
    return Array.from({ length: snapCount }, () => mid);
  }

  const n = SNAP_ARCLEN_SAMPLES;
  const pts: [number, number, number][] = [];
  for (let j = 0; j <= n; j++) {
    const theta = snapA + (j / n) * snapSpan;
    const kMid = findKRingForDeltaZ(sk, theta, M, N, TAB_H_M * 0.5);
    const pMid = crownMeridianPointAtKBridged(
      sk,
      theta,
      kMid,
      M,
      N,
      seamBridge,
    );
    pts.push(offsetInwardXY(pMid, backInset));
  }

  const dist: number[] = [0];
  for (let j = 1; j <= n; j++) {
    const a = pts[j - 1]!;
    const b = pts[j]!;
    dist.push(dist[j - 1]! + Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]));
  }
  const total = dist[n]!;
  if (total < 1e-12) {
    return Array.from(
      { length: snapCount },
      (_, k) => snapA + ((k + 0.5) / snapCount) * snapSpan,
    );
  }

  const result: number[] = [];
  for (let k = 0; k < snapCount; k++) {
    const targetS = ((k + 0.5) / snapCount) * total;
    let j = 0;
    while (j < n && dist[j + 1]! < targetS) j++;
    j = Math.min(j, n - 1);
    const d0 = dist[j]!;
    const d1 = dist[j + 1]!;
    const t = d1 > d0 + 1e-12 ? (targetS - d0) / (d1 - d0) : 0;
    const theta = snapA + ((j + t) / n) * snapSpan;
    result.push(theta);
  }
  return result;
}

function createSnapDomeGeometry(): THREE.SphereGeometry {
  const g = new THREE.SphereGeometry(SNAP_EQUATOR_R_M, 16, 12);
  g.scale(1, SNAP_FLATTEN_Y, 1);
  return g;
}

function outwardXY(
  p: readonly [number, number, number],
): [number, number, number] {
  const L = Math.hypot(p[0], p[1]);
  if (L < 1e-12) return [0, 0, 0];
  return [p[0] / L, p[1] / L, 0];
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

/** Max half-width so [center − w, center + w] ⊆ [thetaMin, thetaMax]. */
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

export type SeamBridgeParams = { bridgeCenter: number; halfWidth: number };

function seamBridgeForTab(
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
 * Across |θ − center| < halfWidth, lerp between crown samples at θ = center ± halfWidth (same k),
 * skipping the seam groove in the middle of the band.
 */
function crownMeridianPointAtKBridged(
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

/** Light 3-tap smoothing along arc index to soften any residual kink at bridge edges. */
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

/** Move outer shell slightly inward (radial −XY) for field indent; rim stays at edge. */
function indentPointRadialTabRim(
  p: [number, number, number],
  rimFactor: number,
): [number, number, number] {
  if (rimFactor < 1e-10) return p;
  const out = outwardXY(p);
  const d = TAB_RIM_DEPTH_M * rimFactor;
  return [p[0] - out[0] * d, p[1] - out[1] * d, p[2] - out[2] * d];
}

function applyTabRimIndentField(
  outerCols: [number, number, number][][],
  innerCols: [number, number, number][][],
  thickness: number,
  nSeg: number,
  nRings: number,
): void {
  const R = nRings + 1;
  for (let i = 0; i <= nSeg; i++) {
    for (let r = 0; r < R; r++) {
      const f = tabRimFactorFromGrid(i, nSeg, r, nRings);
      outerCols[i]![r] = indentPointRadialTabRim(outerCols[i]![r]!, f);
    }
  }
  for (let i = 0; i <= nSeg; i++) {
    for (let r = 0; r < R; r++) {
      innerCols[i]![r] = offsetInwardXY(outerCols[i]![r]!, thickness);
    }
  }
}

// ---------------------------------------------------------------------------
// Tab geometry
// ---------------------------------------------------------------------------

/**
 * Build a solid tab that follows the crown curvature along the rear rim arc.
 * - Outer surface sits on the crown inner wall (offset by `inset` from outer surface).
 * - Inner surface is `TAB_DEPTH_M` further inward.
 * - Free end is a semicircular cap in the (tangent, up) plane at the cap θ.
 *
 * `inset` may be a function of θ so the strap can ease radial depth along the arc
 * (e.g. hug the crown on the free end while staying stacked under the other tab in overlap).
 */
function buildCrownFollowingTab(
  sk: BuiltSkeleton,
  thetaA: number,
  thetaB: number,
  nSeg: number,
  inset: number | ((theta: number) => number),
  roundAtStart: boolean,
  roundAtEnd: boolean,
  seamBridge: SeamBridgeParams,
): THREE.BufferGeometry {
  const spec = sk.spec;
  const M = crownArcSegments(spec);
  const N = crownVerticalRings(spec);
  const thickness = TAB_DEPTH_M;
  const nRings = HEIGHT_RINGS;
  const span = thetaB - thetaA;

  const insetAt =
    typeof inset === "function" ? inset : (theta: number) => inset;

  const outerCols: [number, number, number][][] = [];
  const innerCols: [number, number, number][][] = [];

  for (let i = 0; i <= nSeg; i++) {
    const u = i / nSeg;
    const theta = thetaA + u * span;
    const insetVal = insetAt(theta);

    const kTop = findKRingForDeltaZ(sk, theta, M, N, TAB_H_M);

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
  applyTabRimIndentField(outerCols, innerCols, thickness, nSeg, nRings);

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

  // Bottom edge (rim)
  for (let i = 0; i < nSeg; i++) {
    const ob = outerCols[i]![0]!;
    const obn = outerCols[i + 1]![0]!;
    const ib = innerCols[i]![0]!;
    const ibn = innerCols[i + 1]![0]!;
    pushQuad(positions, ob, obn, ibn, ib);
  }

  // Top edge
  for (let i = 0; i < nSeg; i++) {
    const ot = outerCols[i]![R - 1]!;
    const otn = outerCols[i + 1]![R - 1]!;
    const it = innerCols[i]![R - 1]!;
    const itn = innerCols[i + 1]![R - 1]!;
    pushQuad(positions, ot, otn, itn, it);
  }

  // End caps (flat or round)
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

  // Semicircular rounded end caps
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
      const o0i = indentPointRadialTabRim(o0, rf0);
      const o1i = indentPointRadialTabRim(o1, rf1);
      const i0 = offsetInwardXY(o0i, thickness);
      const i1 = offsetInwardXY(o1i, thickness);

      pushQuad(positions, o0i, o1i, i1, i0);
    }

    // Solid end caps: fill the semicircular half-disks on outer and inner faces (tube was open).
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
      const oi = indentPointRadialTabRim(o, rf);
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

// ---------------------------------------------------------------------------
// Public
// ---------------------------------------------------------------------------

export function buildSnapbackClosureGroup(sk: BuiltSkeleton): THREE.Group {
  const group = new THREE.Group();
  group.name = "Closure_Snapback";

  if (!sk.spec.backClosureOpening) return group;

  const spec = sk.spec;
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

  const thetaL = rimWorldXYToSweatbandTheta(spec, left[0], left[1]);
  const thetaR = rimWorldXYToSweatbandTheta(spec, right[0], right[1]);
  const rear = sweatbandRearArcStartAndSpan(thetaL, thetaR);

  const avgR = (spec.semiAxisX + spec.semiAxisY) * 0.5;
  const dThetaExt = CLOSURE_EXTEND_RIM_M / Math.max(avgR, 1e-6);
  const a0 = rear.start - dThetaExt;
  const a1 = rear.start + rear.span + dThetaExt;
  const span = a1 - a0;
  const center = a0 + span * 0.5;
  const overlapRad = span * TAB_OVERLAP_FRAC;
  const backEnd = Math.min(a1, center + overlapRad);
  const frontStart = Math.max(a0, center - overlapRad);

  const backInset = CLOSURE_INSET_M + BACK_TAB_RADIAL_NUDGE_M;
  const frontInset = backInset + TAB_DEPTH_M + TAB_LAYER_GAP_M;

  // Back tab: left rail → overlap. In [a0, frontStart) ease inset down to hug crown; in overlap keep stack inset.
  const backTabInset =
    frontStart - a0 > 1e-8
      ? (theta: number) => {
          if (theta >= frontStart) return backInset;
          const t = (theta - a0) / (frontStart - a0);
          const w = smoothstep01(t);
          return TAB_FREE_END_INSET_M + w * (backInset - TAB_FREE_END_INSET_M);
        }
      : backInset;

  // Front tab: overlap → right rail. In (backEnd, a1] ease inset down (same as back tab free end).
  const frontTabInset =
    a1 - backEnd > 1e-8
      ? (theta: number) => {
          if (theta <= backEnd) return frontInset;
          const t = (theta - backEnd) / (a1 - backEnd);
          const w = smoothstep01(t);
          return frontInset + w * (TAB_FREE_END_INSET_M - frontInset);
        }
      : frontInset;

  const snapA = Math.max(a0, frontStart);
  const snapB = Math.min(backEnd, a1);

  const seamBridgeBack = seamBridgeForTab(center, a0, backEnd);
  const seamBridgeFront = seamBridgeForTab(center, frontStart, a1);
  const seamBridgeSnaps = seamBridgeForTab(center, snapA, snapB);

  const backGeo = buildCrownFollowingTab(
    sk,
    a0,
    backEnd,
    ARC_SEGMENTS,
    backTabInset,
    false,
    true,
    seamBridgeBack,
  );
  const backTab = new THREE.Mesh(backGeo, closureTabMaterial());
  backTab.name = "Closure_Snapback_Tab_Back";
  backTab.renderOrder = TAB_RENDER_ORDER;
  group.add(backTab);

  // Front tab: past center ← right rail, rounded tip at left (free end).
  const frontGeo = buildCrownFollowingTab(
    sk,
    frontStart,
    a1,
    ARC_SEGMENTS,
    frontTabInset,
    true,
    false,
    seamBridgeFront,
  );
  const frontTab = new THREE.Mesh(frontGeo, closureTabMaterial());
  frontTab.name = "Closure_Snapback_Tab_Front";
  frontTab.renderOrder = TAB_RENDER_ORDER + 1;
  group.add(frontTab);

  const sMat = snapMaterial();
  const sharedStemGeom = new THREE.CylinderGeometry(
    SNAP_STEM_R_M,
    SNAP_STEM_R_M,
    SNAP_STEM_H_M,
    10,
    1,
    false,
  );
  const snapBasis = new THREE.Matrix4();
  const M = crownArcSegments(spec);
  const N = crownVerticalRings(spec);

  const sy = SNAP_FLATTEN_Y;
  const domeCenterYBack = SNAP_STEM_H_M + SNAP_EQUATOR_R_M * sy;
  const domeCenterYFront = -SNAP_EQUATOR_R_M * sy;

  const snapThetas = snapThetasEvenArcAlongBackOuter(
    sk,
    snapA,
    snapB,
    M,
    N,
    backInset,
    seamBridgeSnaps,
    SNAP_COUNT,
  );

  for (let k = 0; k < SNAP_COUNT; k++) {
    const theta = snapThetas[k]!;
    const pRim = sweatbandPoint(
      theta,
      spec.semiAxisX,
      spec.semiAxisY,
      spec.yawRad,
    );
    const out = outwardXY(pRim);
    const kMid = findKRingForDeltaZ(sk, theta, M, N, TAB_H_M * 0.5);
    const pMid = crownMeridianPointAtKBridged(
      sk,
      theta,
      kMid,
      M,
      N,
      seamBridgeSnaps,
    );
    const pBackOuter = offsetInwardXY(pMid, backInset);

    const tang = sweatbandTangentTheta(
      theta,
      spec.semiAxisX,
      spec.semiAxisY,
      spec.yawRad,
    );
    const tangLen = Math.hypot(tang[0], tang[1], tang[2]);
    const tNorm: [number, number, number] =
      tangLen > 1e-12
        ? [tang[0] / tangLen, tang[1] / tangLen, tang[2] / tangLen]
        : [0, 1, 0];
    snapBasis.makeBasis(
      new THREE.Vector3(tNorm[0], tNorm[1], tNorm[2]),
      new THREE.Vector3(out[0], out[1], out[2]),
      new THREE.Vector3(0, 0, 1),
    );

    const backSnap = new THREE.Group();
    backSnap.name = `Closure_Snapback_Snap_Back_${k}`;
    backSnap.renderOrder = SNAP_RENDER_ORDER;
    backSnap.position.set(pBackOuter[0], pBackOuter[1], pBackOuter[2]);
    backSnap.setRotationFromMatrix(snapBasis);

    const stem = new THREE.Mesh(sharedStemGeom, sMat);
    stem.name = `Closure_Snapback_Snap_Back_Stem_${k}`;
    stem.renderOrder = SNAP_RENDER_ORDER;
    stem.position.y = SNAP_STEM_H_M * 0.5;

    const domeGeom = createSnapDomeGeometry();
    const domeBack = new THREE.Mesh(domeGeom, sMat);
    domeBack.name = `Closure_Snapback_Snap_Back_Dome_${k}`;
    domeBack.renderOrder = SNAP_RENDER_ORDER;
    domeBack.position.y = domeCenterYBack;

    backSnap.add(stem);
    backSnap.add(domeBack);
    group.add(backSnap);

    const pFrontOuter = offsetInwardXY(pMid, frontInset);
    const frontSnap = new THREE.Group();
    frontSnap.name = `Closure_Snapback_Snap_Front_${k}`;
    frontSnap.renderOrder = SNAP_RENDER_ORDER;
    frontSnap.position.set(pFrontOuter[0], pFrontOuter[1], pFrontOuter[2]);
    frontSnap.setRotationFromMatrix(snapBasis);

    const domeGeomFront = createSnapDomeGeometry();
    const domeFront = new THREE.Mesh(domeGeomFront, sMat);
    domeFront.name = `Closure_Snapback_Snap_Front_Dome_${k}`;
    domeFront.renderOrder = SNAP_RENDER_ORDER;
    domeFront.position.y = domeCenterYFront;

    frontSnap.add(domeFront);
    group.add(frontSnap);
  }

  // Align with base rim thread (same vertical stack as {@link crownRimPointForBaseThreading}).
  group.position.z = BASE_THREAD_Z_OFFSET_M;

  return group;
}
