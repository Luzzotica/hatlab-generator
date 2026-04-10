import * as THREE from "three";
import type { BuiltSkeleton } from "@/lib/skeleton/geometry";
import {
  effectiveVisorHalfSpanRad,
  sweatbandPoint,
} from "@/lib/skeleton/geometry";
import {
  CROWN_SHELL_THICKNESS_M,
  crownArcSegments,
  crownMeridianPointAtK,
  crownVerticalRings,
  findKRingForDeltaZ,
} from "@/lib/mesh/crownMesh";
import {
  outerSurfacePoint,
  SWEATBAND_OUTER_INSET_M,
} from "@/lib/mesh/sweatbandMesh";

/** Brim slab thickness (skeleton units ≈ metres → 2 mm). */
export const VISOR_THICKNESS_M = 0.002;

/**
 * Per-sample local Z offset along the visor outer edge (before {@link VISOR_Z_BASE}),
 * matching {@link computeVisorSlabData}. Zero at tips, maximum at span center.
 * Positive = outer edge curves upward in skeleton +Z.
 */
export function computeVisorOuterCurvatureZArray(
  m: number,
  curvatureM: number,
): number[] {
  const out: number[] = [];
  for (let i = 0; i < m; i++) {
    out.push(curvatureM * Math.sin((Math.PI * i) / (m - 1)));
  }
  return out;
}

/** Same curvature Z array as the visor slab for the built skeleton's visor polyline. */
export function visorOuterCurvatureZLocal(sk: BuiltSkeleton): number[] {
  const m = sk.visorPolyline.length;
  if (m < 2) return [];
  return computeVisorOuterCurvatureZArray(
    m,
    sk.spec.visor.visorCurvatureM ?? 0,
  );
}

/**
 * Fraction of outer-edge droop on the inner rim (hat attachment). Use `1` so the base follows
 * the same height profile as the bill; values below 1 leave the rim lower than the outer edge.
 */
export const VISOR_RIM_DROOP_BLEND = 1;

function computeVisorRimDroopZArray(droop: number[]): number[] {
  return droop.map((z) => z * VISOR_RIM_DROOP_BLEND);
}

/** Rim arc, outer planform, and per-column Z — same basis as visor slab quads (before fillet insets). */
export function getVisorRuledBasis(sk: BuiltSkeleton): {
  m: number;
  /** Chord midpoint between sweatband tips (same frame as {@link sampleVisorSuperellipsePolyline}). */
  rimMid: [number, number, number];
  rim: [number, number, number][];
  outer: [number, number, number][];
  droop: number[];
  rimDroop: number[];
} | null {
  const outer = sk.visorPolyline;
  const m = outer.length;
  if (m < 2) return null;
  const spec = sk.spec;
  const v = spec.visor;
  const halfSpan = effectiveVisorHalfSpanRad(v, spec.nSeams, sk.angles);
  const c = v.attachAngleRad;
  const rim: [number, number, number][] = [];
  for (let i = 0; i < m; i++) {
    const u = i / (m - 1);
    const theta = c - halfSpan + u * 2 * halfSpan;
    rim.push(
      sweatbandPoint(theta, spec.semiAxisX, spec.semiAxisY, spec.yawRad),
    );
  }
  const droop = computeVisorOuterCurvatureZArray(m, v.visorCurvatureM ?? 0);
  const rimDroop = computeVisorRimDroopZArray(droop);
  const r0 = rim[0]!;
  const r1 = rim[m - 1]!;
  const rimMid: [number, number, number] = [
    0.5 * (r0[0] + r1[0]),
    0.5 * (r0[1] + r1[1]),
    0.5 * (r0[2] + r1[2]),
  ];
  return {
    m,
    rimMid,
    rim,
    outer: outer as [number, number, number][],
    droop,
    rimDroop,
  };
}

function lerp3(
  a: [number, number, number],
  b: [number, number, number],
  t: number,
): [number, number, number] {
  const u = 1 - t;
  return [u * a[0] + t * b[0], u * a[1] + t * b[1], u * a[2] + t * b[2]];
}

/**
 * Ruled bill surface from inner rim toward outer edge (slab local Z before {@link applyVisorSlabTransform}).
 * `s` = span 0…1 (left tip → right); `d` = depth 0 = inner rim, 1 = outer edge.
 *
 * XY uses homothety from the chord midpoint (`rimMid`) toward the outer superellipse so fixed-`d`
 * curves are concentric copies of the bill (same family as {@link sampleVisorSuperellipsePolyline} with
 * `aScale = bScale`). A perpendicular blend restores the exact sweatband rim at `d = 0`.
 * Z still interpolates rim / outer droop. For fixed `s`, the map `d ↦ P` is affine (straight ruling).
 */
export function evalVisorRuledPointLocal(
  sk: BuiltSkeleton,
  s: number,
  d: number,
): [number, number, number] {
  const basis = getVisorRuledBasis(sk);
  if (!basis) return [0, 0, 0];
  const { m, rimMid, rim, outer, droop, rimDroop } = basis;
  const sCl = Math.max(0, Math.min(1, s));
  const dCl = Math.max(0, Math.min(1, d));
  const fx = sCl * (m - 1);
  const i0 = Math.min(Math.floor(fx), m - 2);
  const frac = fx - i0;
  const rimS = lerp3(rim[i0]!, rim[i0 + 1]!, frac);
  const outS = lerp3(outer[i0]!, outer[i0 + 1]!, frac);
  const zRim = rimDroop[i0]! * (1 - frac) + rimDroop[i0 + 1]! * frac;
  const zOuter = droop[i0]! * (1 - frac) + droop[i0 + 1]! * frac;
  const z = (1 - dCl) * zRim + dCl * zOuter;

  const vx = outS[0] - rimMid[0];
  const vy = outS[1] - rimMid[1];
  const lenO2 = vx * vx + vy * vy;
  if (lenO2 < 1e-18) {
    const xy = lerp3(rimS, outS, dCl);
    return [xy[0], xy[1], z];
  }

  const rx = rimS[0] - rimMid[0];
  const ry = rimS[1] - rimMid[1];
  const kRim = (rx * vx + ry * vy) / lenO2;
  const px = rimMid[0] + kRim * vx;
  const py = rimMid[1] + kRim * vy;
  const cx = rimS[0] - px;
  const cy = rimS[1] - py;
  const t = (1 - dCl) * kRim + dCl;
  const x = rimMid[0] + t * vx + (1 - dCl) * cx;
  const y = rimMid[1] + t * vy + (1 - dCl) * cy;
  return [x, y, z];
}

/** Top outer face: same XY as bottom at (s,d), local Z + {@link VISOR_THICKNESS_M}. */
export function evalVisorRuledTopLocal(
  sk: BuiltSkeleton,
  s: number,
  d: number,
): [number, number, number] {
  const p = evalVisorRuledPointLocal(sk, s, d);
  return [p[0], p[1], p[2] + VISOR_THICKNESS_M];
}

export function evalVisorRuledPointWorld(
  sk: BuiltSkeleton,
  s: number,
  d: number,
): [number, number, number] {
  return applyVisorSlabTransform(evalVisorRuledPointLocal(sk, s, d), sk);
}

export function evalVisorRuledTopWorld(
  sk: BuiltSkeleton,
  s: number,
  d: number,
): [number, number, number] {
  return applyVisorSlabTransform(evalVisorRuledTopLocal(sk, s, d), sk);
}

const VISOR_RULED_FD_H = 1e-4;

function visorCross3(
  a: [number, number, number],
  b: [number, number, number],
): [number, number, number] {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}

/**
 * Unit normal on the ruled bill (world space) from ∂P/∂s × ∂P/∂d on the **bottom** face only.
 * Top and bottom faces share the same tangents in (s,d), so the cross product is identical for
 * both — we must **not** offset both ribbons in that same direction. Orient using the slab
 * thickness vector T = top − bottom so **top** gets **+n** (outward toward open air above) and
 * **bottom** gets **−n** (outward below).
 */
export function evalVisorRuledNormalWorld(
  sk: BuiltSkeleton,
  s: number,
  d: number,
  top: boolean,
): [number, number, number] {
  const sm = Math.max(0, Math.min(1, s));
  const dm = Math.max(0, Math.min(1, d));
  const h = VISOR_RULED_FD_H;

  const sa = Math.max(0, sm - h);
  const sb = Math.min(1, sm + h);
  const da = Math.max(0, dm - h);
  const db = Math.min(1, dm + h);

  const pa = evalVisorRuledPointWorld(sk, sa, dm);
  const pb = evalVisorRuledPointWorld(sk, sb, dm);
  const ds = sb - sa;
  const dPs: [number, number, number] =
    ds > 1e-12
      ? [(pb[0] - pa[0]) / ds, (pb[1] - pa[1]) / ds, (pb[2] - pa[2]) / ds]
      : [0, 0, 0];

  const pc = evalVisorRuledPointWorld(sk, sm, da);
  const pd = evalVisorRuledPointWorld(sk, sm, db);
  const dd = db - da;
  const dPd: [number, number, number] =
    dd > 1e-12
      ? [(pd[0] - pc[0]) / dd, (pd[1] - pc[1]) / dd, (pd[2] - pc[2]) / dd]
      : [0, 0, 0];

  let n = visorCross3(dPs, dPd);
  let len = Math.hypot(n[0], n[1], n[2]);
  if (len < 1e-12) {
    n = visorCross3(dPd, dPs);
    len = Math.hypot(n[0], n[1], n[2]);
  }

  const pBot = evalVisorRuledPointWorld(sk, sm, dm);
  const pTop = evalVisorRuledTopWorld(sk, sm, dm);
  const Tx = pTop[0] - pBot[0];
  const Ty = pTop[1] - pBot[1];
  const Tz = pTop[2] - pBot[2];
  const tLen = Math.hypot(Tx, Ty, Tz);

  if (len < 1e-12) {
    if (tLen < 1e-12) return [0, 0, 1];
    const inv = 1 / tLen;
    const nT: [number, number, number] = [Tx * inv, Ty * inv, Tz * inv];
    return top ? nT : [-nT[0], -nT[1], -nT[2]];
  }
  n = [n[0] / len, n[1] / len, n[2] / len];

  if (tLen > 1e-12) {
    const dotT = n[0] * Tx + n[1] * Ty + n[2] * Tz;
    if (dotT < 0) {
      n = [-n[0], -n[1], -n[2]];
    }
  }

  return top ? n : [-n[0], -n[1], -n[2]];
}

/**
 * Z offset applied to the entire visor slab so it sits *under* the crown rim.
 * Top surface lands at z ≈ 0 (flush with the rim); bottom at z ≈ −thickness.
 * {@link applyVisorSlabTransform} also adds {@link visorCurvatureSlabLiftM} when the bill curves.
 */
export const VISOR_Z_BASE = -VISOR_THICKNESS_M;

/** Upward shift (m) for the whole visor slab: `visorCurvatureM / 10` to close gaps to the crown. */
export function visorCurvatureSlabLiftM(sk: BuiltSkeleton): number {
  return (sk.spec.visor.visorCurvatureM ?? 0) / 25;
}

/**
 * Radial pull toward the hat center (XY) so the visor sits inside the crown /
 * inner-front rise instead of intersecting the inner mesh. ~1.5× shell thickness
 * clears the brim–inner offset; tune if the edge still clips.
 */
const VISOR_RADIAL_INSET_M = CROWN_SHELL_THICKNESS_M * 1.5 - 0.001;

/**
 * Radial XY scale only (matches visor mesh); leaves Z unchanged — use for threading
 * with separate topZ/botZ that already include {@link VISOR_Z_BASE}.
 */
export function applyVisorSlabXYOnly(
  p: [number, number, number],
): [number, number, number] {
  const L = Math.hypot(p[0], p[1]);
  if (L < 1e-12) return [p[0], p[1], p[2]];
  const s = 1 - VISOR_RADIAL_INSET_M / L;
  return [p[0] * s, p[1] * s, p[2]];
}

/**
 * Same XY radial inset + Z shift applied to all visor slab vertices (bottom, top, wrap).
 * Adds {@link visorCurvatureSlabLiftM} so the bill moves up slightly when curved.
 */
export function applyVisorSlabTransform(
  p: [number, number, number],
  sk: BuiltSkeleton,
): [number, number, number] {
  const [x, y] = applyVisorSlabXYOnly(p);
  return [x, y, p[2] + VISOR_Z_BASE + visorCurvatureSlabLiftM(sk)];
}

/** How far the tuck strip rises along the crown meridian under the hat. */
export const VISOR_TUCK_HEIGHT_M = 0.006;

const FILLET_SEGMENTS = 5;

type VisorUV = [number, number];

function pushTriangleUv(
  positions: number[],
  uv: number[],
  a: [number, number, number],
  b: [number, number, number],
  c: [number, number, number],
  ua: VisorUV,
  ub: VisorUV,
  uc: VisorUV,
): void {
  positions.push(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2]);
  uv.push(ua[0], ua[1], ub[0], ub[1], uc[0], uc[1]);
}

function pushQuadUv(
  positions: number[],
  uv: number[],
  a: [number, number, number],
  b: [number, number, number],
  c: [number, number, number],
  d: [number, number, number],
  ua: VisorUV,
  ub: VisorUV,
  uc: VisorUV,
  ud: VisorUV,
): void {
  pushTriangleUv(positions, uv, a, b, c, ua, ub, uc);
  pushTriangleUv(positions, uv, a, c, d, ua, uc, ud);
}

/** Inward XY direction from point toward centroid (visor interior). */
function inwardXY(
  p: [number, number, number],
  cx: number,
  cy: number,
): [number, number, number] {
  const dx = cx - p[0];
  const dy = cy - p[1];
  const L = Math.hypot(dx, dy);
  if (L < 1e-12) return [0, 0, 0];
  return [dx / L, dy / L, 0];
}

/**
 * Top fillet: quarter-circle from (p, z=baseZ+t-R) curving inward to (p+N*R, z=baseZ+t).
 * Returns FILLET_SEGMENTS+1 points (θ = 0 … π/2).
 */
function filletArcTop(
  p: [number, number, number],
  N: [number, number, number],
  R: number,
  t: number,
  steps: number,
  baseZ = 0,
): [number, number, number][] {
  const z0 = baseZ + t - R;
  const out: [number, number, number][] = [];
  for (let k = 0; k <= steps; k++) {
    const theta = (k / steps) * (0.5 * Math.PI);
    const inward = R - R * Math.cos(theta);
    const dz = R * Math.sin(theta);
    out.push([p[0] + N[0] * inward, p[1] + N[1] * inward, z0 + dz]);
  }
  return out;
}

/**
 * Bottom fillet: quarter-circle from (p+N*R, z=baseZ) curving outward to (p, z=baseZ+R).
 * Returns FILLET_SEGMENTS+1 points (θ = 0 … π/2).
 */
function filletArcBot(
  p: [number, number, number],
  N: [number, number, number],
  R: number,
  steps: number,
  baseZ = 0,
): [number, number, number][] {
  const out: [number, number, number][] = [];
  for (let k = 0; k <= steps; k++) {
    const theta = (k / steps) * (0.5 * Math.PI);
    const inward = R * Math.cos(theta);
    const dz = R * Math.sin(theta);
    out.push([p[0] + N[0] * inward, p[1] + N[1] * inward, baseZ + dz]);
  }
  return out;
}

/** Shared intermediate data for visor geometry construction. */
interface VisorSlabData {
  m: number;
  t: number;
  R: number;
  /** Per-sample z-displacement on the outer edge (+Z = up). Zero at tips, max at center. */
  droop: number[];
  /** Inner-rim Z in slab space (`droop` × {@link VISOR_RIM_DROOP_BLEND}; equals `droop` when blend is 1). */
  rimDroop: number[];
  rim: [number, number, number][];
  outer: [number, number, number][];
  rimBotFlat: [number, number, number][];
  outerBotFlat: [number, number, number][];
  rimTopFlat: [number, number, number][];
  outerTopFlat: [number, number, number][];
  rimFilletBot: [number, number, number][][];
  rimFilletTop: [number, number, number][][];
  outerFilletBot: [number, number, number][][];
  outerFilletTop: [number, number, number][][];
}

function computeVisorSlabData(sk: BuiltSkeleton): VisorSlabData | null {
  const outer = sk.visorPolyline;
  const m = outer.length;
  if (m < 2) return null;

  const spec = sk.spec;
  const v = spec.visor;
  const halfSpan = effectiveVisorHalfSpanRad(v, spec.nSeams, sk.angles);
  const c = v.attachAngleRad;
  const t = VISOR_THICKNESS_M;
  const R = t * 0.45;

  const rim: [number, number, number][] = [];
  for (let i = 0; i < m; i++) {
    const u = i / (m - 1);
    const theta = c - halfSpan + u * 2 * halfSpan;
    rim.push(
      sweatbandPoint(theta, spec.semiAxisX, spec.semiAxisY, spec.yawRad),
    );
  }

  let cx = 0;
  let cy = 0;
  const nPts = 2 * m;
  for (let i = 0; i < m; i++) {
    cx += rim[i]![0] + outer[i]![0];
    cy += rim[i]![1] + outer[i]![1];
  }
  cx /= nPts;
  cy /= nPts;

  const Nrim = rim.map((p) => inwardXY(p, cx, cy));
  const Nout = outer.map((p) => inwardXY(p, cx, cy));

  const droop = computeVisorOuterCurvatureZArray(m, v.visorCurvatureM ?? 0);
  const rimDroop = computeVisorRimDroopZArray(droop);

  return {
    m,
    t,
    R,
    droop,
    rimDroop,
    rim,
    outer: outer as [number, number, number][],
    rimBotFlat: rim.map((p, i) => {
      const N = Nrim[i]!;
      const rz = rimDroop[i]!;
      return [p[0] + N[0] * R, p[1] + N[1] * R, rz] as [number, number, number];
    }),
    outerBotFlat: outer.map((p, i) => {
      const N = Nout[i]!;
      return [p[0] + N[0] * R, p[1] + N[1] * R, droop[i]!] as [
        number,
        number,
        number,
      ];
    }),
    rimTopFlat: rim.map((p, i) => {
      const N = Nrim[i]!;
      const rz = rimDroop[i]!;
      return [p[0] + N[0] * R, p[1] + N[1] * R, rz + t] as [
        number,
        number,
        number,
      ];
    }),
    outerTopFlat: outer.map((p, i) => {
      const N = Nout[i]!;
      return [p[0] + N[0] * R, p[1] + N[1] * R, droop[i]! + t] as [
        number,
        number,
        number,
      ];
    }),
    rimFilletBot: rim.map((p, i) =>
      filletArcBot(p, Nrim[i]!, R, FILLET_SEGMENTS, rimDroop[i]!),
    ),
    rimFilletTop: rim.map((p, i) =>
      filletArcTop(p, Nrim[i]!, R, t, FILLET_SEGMENTS, rimDroop[i]!),
    ),
    outerFilletBot: outer.map((p, i) =>
      filletArcBot(p, Nout[i]!, R, FILLET_SEGMENTS, droop[i]!),
    ),
    outerFilletTop: outer.map((p, i) =>
      filletArcTop(p, Nout[i]!, R, t, FILLET_SEGMENTS, droop[i]!),
    ),
  };
}

/**
 * Filled visor with filleted edges on both top and bottom.
 * Bottom at z=0, top at z=THICKNESS. Both faces are inset by R.
 * Each edge (inner rim, outer, end caps) has bottom fillet + straight wall + top fillet.
 */
export function buildVisorGeometry(sk: BuiltSkeleton): THREE.BufferGeometry {
  const { top, bottom } = buildVisorTopBottomGeometries(sk);
  const merged = new THREE.BufferGeometry();
  const topAttr = top.getAttribute("position") as THREE.BufferAttribute | null;
  const botAttr = bottom.getAttribute(
    "position",
  ) as THREE.BufferAttribute | null;
  const allPositions: number[] = [];
  const allUvs: number[] = [];
  if (botAttr)
    for (let i = 0; i < botAttr.count * 3; i++)
      allPositions.push(botAttr.array[i]!);
  const botUv = bottom.getAttribute("uv") as THREE.BufferAttribute | null;
  if (botUv) {
    for (let i = 0; i < botUv.count * 2; i++) allUvs.push(botUv.array[i]!);
  }
  if (topAttr)
    for (let i = 0; i < topAttr.count * 3; i++)
      allPositions.push(topAttr.array[i]!);
  const topUv = top.getAttribute("uv") as THREE.BufferAttribute | null;
  if (topUv) {
    for (let i = 0; i < topUv.count * 2; i++) allUvs.push(topUv.array[i]!);
  }
  top.dispose();
  bottom.dispose();
  if (allPositions.length > 0) {
    merged.setAttribute(
      "position",
      new THREE.Float32BufferAttribute(allPositions, 3),
    );
    if (allUvs.length === (allPositions.length / 3) * 2) {
      merged.setAttribute("uv", new THREE.Float32BufferAttribute(allUvs, 2));
    }
    merged.computeVertexNormals();
  }
  return merged;
}

/** Shell above the bottom plane: top face, all fillets, and all vertical edge walls. */
export function buildVisorTopGeometry(sk: BuiltSkeleton): THREE.BufferGeometry {
  return buildVisorTopBottomGeometries(sk).top;
}

/** Underside plane only (rim–outer strip at z≈0); no edge wrap. */
export function buildVisorBottomGeometry(
  sk: BuiltSkeleton,
): THREE.BufferGeometry {
  return buildVisorTopBottomGeometries(sk).bottom;
}

export type VisorTopBottomOptions = {
  /**
   * When true, omit inner-rim fillets + wall on the top shell (hat-attach edge).
   * Use with {@link buildVisorFilletGeometry} so teal fillet replaces the gray band.
   */
  omitInnerRimInTop?: boolean;
};

export function buildVisorTopBottomGeometries(
  sk: BuiltSkeleton,
  options?: VisorTopBottomOptions,
): { top: THREE.BufferGeometry; bottom: THREE.BufferGeometry } {
  const data = computeVisorSlabData(sk);
  if (!data) {
    return {
      top: new THREE.BufferGeometry(),
      bottom: new THREE.BufferGeometry(),
    };
  }

  const {
    m,
    t,
    R,
    droop,
    rimDroop,
    rim,
    outer,
    rimBotFlat,
    outerBotFlat,
    rimTopFlat,
    outerTopFlat,
    rimFilletBot,
    rimFilletTop,
    outerFilletBot,
    outerFilletTop,
  } = data;

  const zBotWall = R;
  const zTopWall = t - R;

  const topPos: number[] = [];
  const topUv: number[] = [];
  const botPos: number[] = [];
  const botUv: number[] = [];

  // Bottom mesh: flat underside only (meets hat at rim inset; outer edge inset).
  for (let i = 0; i < m - 1; i++) {
    const s0 = i / (m - 1);
    const s1 = (i + 1) / (m - 1);
    pushTriangleUv(
      botPos,
      botUv,
      rimBotFlat[i]!,
      outerBotFlat[i]!,
      rimBotFlat[i + 1]!,
      [s0, 0],
      [s0, 1],
      [s1, 0],
    );
    pushTriangleUv(
      botPos,
      botUv,
      rimBotFlat[i + 1]!,
      outerBotFlat[i]!,
      outerBotFlat[i + 1]!,
      [s1, 0],
      [s0, 1],
      [s1, 1],
    );
  }

  // Top mesh: top face + entire perimeter (all fillets and walls); one material to the edge.
  for (let i = 0; i < m - 1; i++) {
    const s0 = i / (m - 1);
    const s1 = (i + 1) / (m - 1);
    pushTriangleUv(
      topPos,
      topUv,
      rimTopFlat[i]!,
      rimTopFlat[i + 1]!,
      outerTopFlat[i]!,
      [s0, 0],
      [s1, 0],
      [s0, 1],
    );
    pushTriangleUv(
      topPos,
      topUv,
      rimTopFlat[i + 1]!,
      outerTopFlat[i + 1]!,
      outerTopFlat[i]!,
      [s1, 0],
      [s1, 1],
      [s0, 1],
    );
  }

  const omitInnerRim = options?.omitInnerRimInTop === true;

  if (!omitInnerRim) {
    // --- Inner rim edge (rim droop matches bill curvature; wall connects fillets) ---
    for (let i = 0; i < m - 1; i++) {
      const s0 = i / (m - 1);
      const s1 = (i + 1) / (m - 1);
      for (let k = 0; k < FILLET_SEGMENTS; k++) {
        const v0 = k / FILLET_SEGMENTS;
        const v1 = (k + 1) / FILLET_SEGMENTS;
        pushQuadUv(
          topPos,
          topUv,
          rimFilletBot[i]![k]!,
          rimFilletBot[i + 1]![k]!,
          rimFilletBot[i + 1]![k + 1]!,
          rimFilletBot[i]![k + 1]!,
          [s0, v0],
          [s1, v0],
          [s1, v1],
          [s0, v1],
        );
      }
    }
    for (let i = 0; i < m - 1; i++) {
      const s0 = i / (m - 1);
      const s1 = (i + 1) / (m - 1);
      const d0 = rimDroop[i]!;
      const d1 = rimDroop[i + 1]!;
      const r0b: [number, number, number] = [
        rim[i]![0],
        rim[i]![1],
        d0 + zBotWall,
      ];
      const r1b: [number, number, number] = [
        rim[i + 1]![0],
        rim[i + 1]![1],
        d1 + zBotWall,
      ];
      const r0t: [number, number, number] = [
        rim[i]![0],
        rim[i]![1],
        d0 + zTopWall,
      ];
      const r1t: [number, number, number] = [
        rim[i + 1]![0],
        rim[i + 1]![1],
        d1 + zTopWall,
      ];
      pushQuadUv(topPos, topUv, r0b, r1b, r1t, r0t, [s0, 0], [s1, 0], [s1, 1], [s0, 1]);
    }
    for (let i = 0; i < m - 1; i++) {
      const s0 = i / (m - 1);
      const s1 = (i + 1) / (m - 1);
      for (let k = 0; k < FILLET_SEGMENTS; k++) {
        const v0 = k / FILLET_SEGMENTS;
        const v1 = (k + 1) / FILLET_SEGMENTS;
        pushQuadUv(
          topPos,
          topUv,
          rimFilletTop[i]![k]!,
          rimFilletTop[i + 1]![k]!,
          rimFilletTop[i + 1]![k + 1]!,
          rimFilletTop[i]![k + 1]!,
          [s0, v0],
          [s1, v0],
          [s1, v1],
          [s0, v1],
        );
      }
    }
  }

  // --- Outer edge (z-values offset by per-sample droop) ---
  for (let i = 0; i < m - 1; i++) {
    const s0 = i / (m - 1);
    const s1 = (i + 1) / (m - 1);
    for (let k = 0; k < FILLET_SEGMENTS; k++) {
      const v0 = k / FILLET_SEGMENTS;
      const v1 = (k + 1) / FILLET_SEGMENTS;
      pushQuadUv(
        topPos,
        topUv,
        outerFilletBot[i]![k]!,
        outerFilletBot[i]![k + 1]!,
        outerFilletBot[i + 1]![k + 1]!,
        outerFilletBot[i + 1]![k]!,
        [s0, v0],
        [s0, v1],
        [s1, v1],
        [s1, v0],
      );
    }
  }
  for (let i = 0; i < m - 1; i++) {
    const s0 = i / (m - 1);
    const s1 = (i + 1) / (m - 1);
    const d0 = droop[i]!;
    const d1 = droop[i + 1]!;
    const o0b: [number, number, number] = [
      outer[i]![0],
      outer[i]![1],
      d0 + zBotWall,
    ];
    const o1b: [number, number, number] = [
      outer[i + 1]![0],
      outer[i + 1]![1],
      d1 + zBotWall,
    ];
    const o0t: [number, number, number] = [
      outer[i]![0],
      outer[i]![1],
      d0 + zTopWall,
    ];
    const o1t: [number, number, number] = [
      outer[i + 1]![0],
      outer[i + 1]![1],
      d1 + zTopWall,
    ];
    pushQuadUv(topPos, topUv, o0b, o1b, o1t, o0t, [s0, 0], [s1, 0], [s1, 1], [s0, 1]);
  }
  for (let i = 0; i < m - 1; i++) {
    const s0 = i / (m - 1);
    const s1 = (i + 1) / (m - 1);
    for (let k = 0; k < FILLET_SEGMENTS; k++) {
      const v0 = k / FILLET_SEGMENTS;
      const v1 = (k + 1) / FILLET_SEGMENTS;
      pushQuadUv(
        topPos,
        topUv,
        outerFilletTop[i]![k]!,
        outerFilletTop[i]![k + 1]!,
        outerFilletTop[i + 1]![k + 1]!,
        outerFilletTop[i + 1]![k]!,
        [s0, v0],
        [s0, v1],
        [s1, v1],
        [s1, v0],
      );
    }
  }

  // --- End caps (left & right tips of visor; droop[0]=droop[m-1]=0) ---
  for (const side of [0, m - 1] as const) {
    const sTip = side / (m - 1);
    const ds = droop[side]!;
    const dr = rimDroop[side]!;
    for (let k = 0; k < FILLET_SEGMENTS; k++) {
      const v0 = k / FILLET_SEGMENTS;
      const v1 = (k + 1) / FILLET_SEGMENTS;
      pushQuadUv(
        topPos,
        topUv,
        rimFilletBot[side]![k]!,
        outerFilletBot[side]![k]!,
        outerFilletBot[side]![k + 1]!,
        rimFilletBot[side]![k + 1]!,
        [v0, 0],
        [v0, 1],
        [v1, 1],
        [v1, 0],
      );
    }
    const rb: [number, number, number] = [
      rim[side]![0],
      rim[side]![1],
      dr + zBotWall,
    ];
    const ob: [number, number, number] = [
      outer[side]![0],
      outer[side]![1],
      ds + zBotWall,
    ];
    const rt: [number, number, number] = [
      rim[side]![0],
      rim[side]![1],
      dr + zTopWall,
    ];
    const ot: [number, number, number] = [
      outer[side]![0],
      outer[side]![1],
      ds + zTopWall,
    ];
    pushQuadUv(topPos, topUv, rb, ob, ot, rt, [sTip, 0], [sTip, 1], [sTip, 1], [sTip, 0]);
    for (let k = 0; k < FILLET_SEGMENTS; k++) {
      const v0 = k / FILLET_SEGMENTS;
      const v1 = (k + 1) / FILLET_SEGMENTS;
      pushQuadUv(
        topPos,
        topUv,
        rimFilletTop[side]![k]!,
        outerFilletTop[side]![k]!,
        outerFilletTop[side]![k + 1]!,
        rimFilletTop[side]![k + 1]!,
        [v0, 0],
        [v0, 1],
        [v1, 1],
        [v1, 0],
      );
    }
  }

  for (const arr of [topPos, botPos]) {
    for (let i = 0; i < arr.length; i += 3) {
      const [nx, ny, nz] = applyVisorSlabTransform(
        [arr[i]!, arr[i + 1]!, arr[i + 2]!],
        sk,
      );
      arr[i] = nx;
      arr[i + 1] = ny;
      arr[i + 2] = nz;
    }
  }

  const topGeo = new THREE.BufferGeometry();
  topGeo.setAttribute("position", new THREE.Float32BufferAttribute(topPos, 3));
  topGeo.setAttribute("uv", new THREE.Float32BufferAttribute(topUv, 2));
  topGeo.computeVertexNormals();

  const botGeo = new THREE.BufferGeometry();
  botGeo.setAttribute("position", new THREE.Float32BufferAttribute(botPos, 3));
  botGeo.setAttribute("uv", new THREE.Float32BufferAttribute(botUv, 2));
  botGeo.computeVertexNormals();

  return { top: topGeo, bottom: botGeo };
}

// ---------------------------------------------------------------------------
// Visor fillet: volumetric rounded transition from visor inner rim up into
// the crown–sweatband channel.  Swept crescent profile along the inner rim arc.
// ---------------------------------------------------------------------------

/** Arc-profile resolution (points = steps + 1). */
const FILLET_ARC_STEPS = 10;
/** Radial wall thickness of the fillet shell (m). */
const FILLET_WALL_M = 0.001;
/** Inward bulge as a fraction of the A→B chord length. */
const FILLET_BULGE_FRAC = 0.35;
/** Inset fraction along SWEATBAND_OUTER_INSET_M for the crown target point (higher = deeper into gap). */
const FILLET_INSET_U = 0.9;
/** Fraction of VISOR_TUCK_HEIGHT_M used for the fillet top target (keeps it below crown surface). */
const FILLET_HEIGHT_FRAC = 0.6;
/** Number of columns at each end over which the fillet tapers to zero. */
const FILLET_TAPER_COLS = 1;

/**
 * Volumetric fillet: a rounded crescent-profile tube swept along the visor
 * inner rim arc, bridging from the visor bottom edge up into the gap between
 * the crown shell and the sweatband.
 *
 * Cross-section per column (radial-Z plane):
 * - Outer arc: sin-bulged curve from A (visor bottom rim) to B (crown surface),
 *   bowing outward (away from hat center).
 * - Inner arc: same curve offset inward by {@link FILLET_WALL_M}.
 * - Caps seal the tube at bottom/top edges and at the two arc tips.
 */
export function buildVisorFilletGeometry(
  sk: BuiltSkeleton,
): THREE.BufferGeometry {
  const data = computeVisorSlabData(sk);
  if (!data) return new THREE.BufferGeometry();

  const { m, rimBotFlat } = data;
  const spec = sk.spec;
  const v = spec.visor;
  const halfSpan = effectiveVisorHalfSpanRad(v, spec.nSeams, sk.angles);
  const center = v.attachAngleRad;
  const M = crownArcSegments(spec);
  const N = crownVerticalRings(spec);

  type V3 = [number, number, number];
  const outerCols: V3[][] = [];
  const innerCols: V3[][] = [];

  for (let i = 0; i < m; i++) {
    const u = i / (m - 1);
    const theta = center - halfSpan + u * 2 * halfSpan;

    const A = applyVisorSlabTransform(rimBotFlat[i]!, sk);
    const kTarget = findKRingForDeltaZ(
      sk,
      theta,
      M,
      N,
      VISOR_TUCK_HEIGHT_M * FILLET_HEIGHT_FRAC,
    );
    const B = outerSurfacePoint(
      sk,
      theta,
      kTarget,
      M,
      N,
      FILLET_INSET_U * SWEATBAND_OUTER_INSET_M,
    );

    const dx = B[0] - A[0];
    const dy = B[1] - A[1];
    const dz = B[2] - A[2];
    const chordLen = Math.hypot(dx, dy, dz);

    const outer: V3[] = [];
    const inner: V3[] = [];

    if (chordLen < 1e-8) {
      for (let s = 0; s <= FILLET_ARC_STEPS; s++) {
        outer.push([A[0], A[1], A[2]]);
        inner.push([A[0], A[1], A[2]]);
      }
    } else {
      const cdx = dx / chordLen;
      const cdy = dy / chordLen;
      const cdz = dz / chordLen;

      const mx = (A[0] + B[0]) * 0.5;
      const my = (A[1] + B[1]) * 0.5;
      const mR = Math.hypot(mx, my);
      const rx = mR > 1e-12 ? mx / mR : 1;
      const ry = mR > 1e-12 ? my / mR : 0;

      const dotRC = rx * cdx + ry * cdy;
      let px = rx - dotRC * cdx;
      let py = ry - dotRC * cdy;
      let pz = -dotRC * cdz;
      const pLen = Math.hypot(px, py, pz);
      if (pLen > 1e-10) {
        px /= pLen;
        py /= pLen;
        pz /= pLen;
      }

      // Negate so the bulge points inward (toward hat center), placing
      // the fillet inside the hat between visor and crown/sweatband.
      px = -px;
      py = -py;
      pz = -pz;

      // Taper at the tips so the cross-section shrinks to zero smoothly.
      let taper = 1;
      if (i < FILLET_TAPER_COLS) {
        taper = Math.sin((Math.PI / 2) * (i / FILLET_TAPER_COLS));
      } else if (i > m - 1 - FILLET_TAPER_COLS) {
        taper = Math.sin((Math.PI / 2) * ((m - 1 - i) / FILLET_TAPER_COLS));
      }

      const bulge = FILLET_BULGE_FRAC * chordLen * taper;
      const wall = FILLET_WALL_M * taper;

      for (let s = 0; s <= FILLET_ARC_STEPS; s++) {
        const t = s / FILLET_ARC_STEPS;
        const sinB = Math.sin(Math.PI * t) * bulge;

        const ox = A[0] + dx * t + px * sinB;
        const oy = A[1] + dy * t + py * sinB;
        const oz = A[2] + dz * t + pz * sinB;
        outer.push([ox, oy, oz]);

        // Wall-thickness offset toward the crown shell (larger radius).
        const oR = Math.hypot(ox, oy);
        if (oR > 1e-12 && wall > 1e-8) {
          const sc = (oR + wall) / oR;
          inner.push([ox * sc, oy * sc, oz]);
        } else {
          inner.push([ox, oy, oz]);
        }
      }
    }

    outerCols.push(outer);
    innerCols.push(inner);
  }

  if (outerCols.length < 2) return new THREE.BufferGeometry();

  const positions: number[] = [];
  const uvs: number[] = [];
  const n = FILLET_ARC_STEPS + 1;
  const mc = outerCols.length;
  const uI = (i: number) => i / Math.max(1, mc - 1);
  const vS = (s: number) => s / Math.max(1, n - 1);

  // Outer skin
  for (let i = 0; i < mc - 1; i++) {
    for (let s = 0; s < n - 1; s++) {
      pushQuadUv(
        positions,
        uvs,
        outerCols[i]![s]!,
        outerCols[i + 1]![s]!,
        outerCols[i + 1]![s + 1]!,
        outerCols[i]![s + 1]!,
        [uI(i), vS(s)],
        [uI(i + 1), vS(s)],
        [uI(i + 1), vS(s + 1)],
        [uI(i), vS(s + 1)],
      );
    }
  }

  // Inner skin (reversed winding for inward-facing normals)
  for (let i = 0; i < mc - 1; i++) {
    for (let s = 0; s < n - 1; s++) {
      pushQuadUv(
        positions,
        uvs,
        innerCols[i]![s]!,
        innerCols[i]![s + 1]!,
        innerCols[i + 1]![s + 1]!,
        innerCols[i + 1]![s]!,
        [uI(i), vS(s)],
        [uI(i), vS(s + 1)],
        [uI(i + 1), vS(s + 1)],
        [uI(i + 1), vS(s)],
      );
    }
  }

  // Bottom cap (s = 0 edge, seals visor side)
  for (let i = 0; i < mc - 1; i++) {
    pushQuadUv(
      positions,
      uvs,
      outerCols[i]![0]!,
      innerCols[i]![0]!,
      innerCols[i + 1]![0]!,
      outerCols[i + 1]![0]!,
      [uI(i), 0],
      [uI(i), 1],
      [uI(i + 1), 1],
      [uI(i + 1), 0],
    );
  }

  // Top cap (s = n−1 edge, seals crown side)
  for (let i = 0; i < mc - 1; i++) {
    pushQuadUv(
      positions,
      uvs,
      outerCols[i]![n - 1]!,
      outerCols[i + 1]![n - 1]!,
      innerCols[i + 1]![n - 1]!,
      innerCols[i]![n - 1]!,
      [uI(i), 0],
      [uI(i + 1), 0],
      [uI(i + 1), 1],
      [uI(i), 1],
    );
  }

  // End caps omitted — taper collapses the cross-section to zero at the tips.

  const geo = new THREE.BufferGeometry();
  if (positions.length > 0) {
    geo.setAttribute(
      "position",
      new THREE.Float32BufferAttribute(positions, 3),
    );
    geo.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
    geo.computeVertexNormals();
  }
  return geo;
}

// ---------------------------------------------------------------------------
// Visor tuck: ribbon that extends from the visor's inner rim upward along
// crown meridians, filling the gap between crown shell and sweatband.
// ---------------------------------------------------------------------------

/**
 * Small inward inset so the tuck sits just inside the crown shell,
 * visible when looking up through the gap below the shifted-down visor.
 */
/** Inward radial XY inset for tuck strip (bill rope end ladders match this). */
export const TUCK_INSET_M = CROWN_SHELL_THICKNESS_M * 0.3;
const TUCK_RINGS = 10;

/** Move a point toward the z-axis in XY by `dist`. */
function insetRadialXY(
  p: [number, number, number],
  dist: number,
): [number, number, number] {
  const L = Math.hypot(p[0], p[1]);
  if (L < 1e-12) return [p[0], p[1], p[2]];
  const s = 1 - dist / L;
  return [p[0] * s, p[1] * s, p[2]];
}

/**
 * Tuck ribbon: sits just inside the crown shell over the visor arc, from the
 * rim (k=0) up to `VISOR_TUCK_HEIGHT_M`. With the visor slab shifted down
 * beneath the crown, this strip is visible from below through the rim gap.
 */
export function buildVisorTuckGeometry(
  sk: BuiltSkeleton,
): THREE.BufferGeometry {
  if (sk.visorPolyline.length < 2) return new THREE.BufferGeometry();

  const spec = sk.spec;
  const v = spec.visor;
  const halfSpan = effectiveVisorHalfSpanRad(v, spec.nSeams, sk.angles);
  const c = v.attachAngleRad;
  const m = sk.visorPolyline.length;
  const M = crownArcSegments(spec);
  const N = crownVerticalRings(spec);

  const cols: [number, number, number][][] = [];

  for (let i = 0; i < m; i++) {
    const u = i / (m - 1);
    const theta = c - halfSpan + u * 2 * halfSpan;
    const kTuck = findKRingForDeltaZ(sk, theta, M, N, VISOR_TUCK_HEIGHT_M);

    const col: [number, number, number][] = [];
    for (let r = 0; r <= TUCK_RINGS; r++) {
      const kFloat = (r / TUCK_RINGS) * kTuck;
      const p = crownMeridianPointAtK(sk, theta, kFloat, M, N);
      col.push(insetRadialXY(p, TUCK_INSET_M));
    }

    cols.push(col);
  }

  const positions: number[] = [];
  const uvs: number[] = [];
  const ringCount = cols[0]!.length;

  for (let i = 0; i < m - 1; i++) {
    const u0 = i / (m - 1);
    const u1 = (i + 1) / (m - 1);
    for (let r = 0; r < ringCount - 1; r++) {
      const v0 = r / Math.max(1, ringCount - 1);
      const v1 = (r + 1) / Math.max(1, ringCount - 1);
      pushQuadUv(
        positions,
        uvs,
        cols[i]![r]!,
        cols[i + 1]![r]!,
        cols[i + 1]![r + 1]!,
        cols[i]![r + 1]!,
        [u0, v0],
        [u1, v0],
        [u1, v1],
        [u0, v1],
      );
    }
  }

  const geo = new THREE.BufferGeometry();
  if (positions.length > 0) {
    geo.setAttribute(
      "position",
      new THREE.Float32BufferAttribute(positions, 3),
    );
    geo.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
    geo.computeVertexNormals();
  }
  return geo;
}
