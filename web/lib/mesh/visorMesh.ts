import * as THREE from "three";
import type { BuiltSkeleton } from "@/lib/skeleton/geometry";
import {
  effectiveVisorHalfSpanRad,
  sweatbandPoint,
} from "@/lib/skeleton/geometry";

/** Brim slab thickness (skeleton units ≈ metres → 2 mm). */
export const VISOR_THICKNESS_M = 0.002;

const FILLET_SEGMENTS = 5;

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

/** Inward XY direction from point toward centroid (visor interior). */
function inwardXY(
  p: [number, number, number],
  cx: number,
  cy: number
): [number, number, number] {
  const dx = cx - p[0];
  const dy = cy - p[1];
  const L = Math.hypot(dx, dy);
  if (L < 1e-12) return [0, 0, 0];
  return [dx / L, dy / L, 0];
}

/**
 * Top fillet: quarter-circle from (p, z=t-R) curving inward to (p+N*R, z=t).
 * Returns FILLET_SEGMENTS+1 points (θ = 0 … π/2).
 */
function filletArcTop(
  p: [number, number, number],
  N: [number, number, number],
  R: number,
  t: number,
  steps: number
): [number, number, number][] {
  const z0 = t - R;
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
 * Bottom fillet: quarter-circle from (p+N*R, z=0) curving outward to (p, z=R).
 * Returns FILLET_SEGMENTS+1 points (θ = 0 … π/2).
 */
function filletArcBot(
  p: [number, number, number],
  N: [number, number, number],
  R: number,
  steps: number
): [number, number, number][] {
  const out: [number, number, number][] = [];
  for (let k = 0; k <= steps; k++) {
    const theta = (k / steps) * (0.5 * Math.PI);
    const inward = R * Math.cos(theta);
    const dz = R * Math.sin(theta);
    out.push([p[0] + N[0] * inward, p[1] + N[1] * inward, dz]);
  }
  return out;
}

/** Shared intermediate data for visor geometry construction. */
interface VisorSlabData {
  m: number;
  t: number;
  R: number;
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
    rim.push(sweatbandPoint(theta, spec.semiAxisX, spec.semiAxisY, spec.yawRad));
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

  return {
    m,
    t,
    R,
    rim,
    outer: outer as [number, number, number][],
    rimBotFlat: rim.map((p, i) => {
      const N = Nrim[i]!;
      return [p[0] + N[0] * R, p[1] + N[1] * R, 0] as [number, number, number];
    }),
    outerBotFlat: outer.map((p, i) => {
      const N = Nout[i]!;
      return [p[0] + N[0] * R, p[1] + N[1] * R, 0] as [number, number, number];
    }),
    rimTopFlat: rim.map((p, i) => {
      const N = Nrim[i]!;
      return [p[0] + N[0] * R, p[1] + N[1] * R, t] as [number, number, number];
    }),
    outerTopFlat: outer.map((p, i) => {
      const N = Nout[i]!;
      return [p[0] + N[0] * R, p[1] + N[1] * R, t] as [number, number, number];
    }),
    rimFilletBot: rim.map((p, i) => filletArcBot(p, Nrim[i]!, R, FILLET_SEGMENTS)),
    rimFilletTop: rim.map((p, i) => filletArcTop(p, Nrim[i]!, R, t, FILLET_SEGMENTS)),
    outerFilletBot: outer.map((p, i) => filletArcBot(p, Nout[i]!, R, FILLET_SEGMENTS)),
    outerFilletTop: outer.map((p, i) => filletArcTop(p, Nout[i]!, R, t, FILLET_SEGMENTS)),
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
  const botAttr = bottom.getAttribute("position") as THREE.BufferAttribute | null;
  const allPositions: number[] = [];
  if (botAttr) for (let i = 0; i < botAttr.count * 3; i++) allPositions.push(botAttr.array[i]!);
  if (topAttr) for (let i = 0; i < topAttr.count * 3; i++) allPositions.push(topAttr.array[i]!);
  top.dispose();
  bottom.dispose();
  if (allPositions.length > 0) {
    merged.setAttribute("position", new THREE.Float32BufferAttribute(allPositions, 3));
    merged.computeVertexNormals();
  }
  return merged;
}

/** Shell above the bottom plane: top face, all fillets, and all vertical edge walls. */
export function buildVisorTopGeometry(sk: BuiltSkeleton): THREE.BufferGeometry {
  return buildVisorTopBottomGeometries(sk).top;
}

/** Underside plane only (rim–outer strip at z≈0); no edge wrap. */
export function buildVisorBottomGeometry(sk: BuiltSkeleton): THREE.BufferGeometry {
  return buildVisorTopBottomGeometries(sk).bottom;
}

export function buildVisorTopBottomGeometries(
  sk: BuiltSkeleton,
): { top: THREE.BufferGeometry; bottom: THREE.BufferGeometry } {
  const data = computeVisorSlabData(sk);
  if (!data) {
    return { top: new THREE.BufferGeometry(), bottom: new THREE.BufferGeometry() };
  }

  const {
    m, t, R, rim, outer,
    rimBotFlat, outerBotFlat, rimTopFlat, outerTopFlat,
    rimFilletBot, rimFilletTop, outerFilletBot, outerFilletTop,
  } = data;

  const zBotWall = R;
  const zTopWall = t - R;

  const topPos: number[] = [];
  const botPos: number[] = [];

  // Bottom mesh: flat underside only (meets hat at rim inset; outer edge inset).
  for (let i = 0; i < m - 1; i++) {
    pushTriangle(botPos, rimBotFlat[i]!, outerBotFlat[i]!, rimBotFlat[i + 1]!);
    pushTriangle(botPos, rimBotFlat[i + 1]!, outerBotFlat[i]!, outerBotFlat[i + 1]!);
  }

  // Top mesh: top face + entire perimeter (all fillets and walls); one material to the edge.
  for (let i = 0; i < m - 1; i++) {
    pushTriangle(topPos, rimTopFlat[i]!, rimTopFlat[i + 1]!, outerTopFlat[i]!);
    pushTriangle(topPos, rimTopFlat[i + 1]!, outerTopFlat[i + 1]!, outerTopFlat[i]!);
  }

  // --- Inner rim edge ---
  for (let i = 0; i < m - 1; i++) {
    for (let k = 0; k < FILLET_SEGMENTS; k++) {
      pushQuad(topPos,
        rimFilletBot[i]![k]!, rimFilletBot[i + 1]![k]!,
        rimFilletBot[i + 1]![k + 1]!, rimFilletBot[i]![k + 1]!);
    }
  }
  for (let i = 0; i < m - 1; i++) {
    const r0b: [number, number, number] = [rim[i]![0], rim[i]![1], zBotWall];
    const r1b: [number, number, number] = [rim[i + 1]![0], rim[i + 1]![1], zBotWall];
    const r0t: [number, number, number] = [rim[i]![0], rim[i]![1], zTopWall];
    const r1t: [number, number, number] = [rim[i + 1]![0], rim[i + 1]![1], zTopWall];
    pushQuad(topPos, r0b, r1b, r1t, r0t);
  }
  for (let i = 0; i < m - 1; i++) {
    for (let k = 0; k < FILLET_SEGMENTS; k++) {
      pushQuad(topPos,
        rimFilletTop[i]![k]!, rimFilletTop[i + 1]![k]!,
        rimFilletTop[i + 1]![k + 1]!, rimFilletTop[i]![k + 1]!);
    }
  }

  // --- Outer edge ---
  for (let i = 0; i < m - 1; i++) {
    for (let k = 0; k < FILLET_SEGMENTS; k++) {
      pushQuad(topPos,
        outerFilletBot[i]![k]!, outerFilletBot[i]![k + 1]!,
        outerFilletBot[i + 1]![k + 1]!, outerFilletBot[i + 1]![k]!);
    }
  }
  for (let i = 0; i < m - 1; i++) {
    const o0b: [number, number, number] = [outer[i]![0], outer[i]![1], zBotWall];
    const o1b: [number, number, number] = [outer[i + 1]![0], outer[i + 1]![1], zBotWall];
    const o0t: [number, number, number] = [outer[i]![0], outer[i]![1], zTopWall];
    const o1t: [number, number, number] = [outer[i + 1]![0], outer[i + 1]![1], zTopWall];
    pushQuad(topPos, o0b, o1b, o1t, o0t);
  }
  for (let i = 0; i < m - 1; i++) {
    for (let k = 0; k < FILLET_SEGMENTS; k++) {
      pushQuad(topPos,
        outerFilletTop[i]![k]!, outerFilletTop[i]![k + 1]!,
        outerFilletTop[i + 1]![k + 1]!, outerFilletTop[i + 1]![k]!);
    }
  }

  // --- End caps (left & right tips of visor) ---
  for (const side of [0, m - 1] as const) {
    for (let k = 0; k < FILLET_SEGMENTS; k++) {
      pushQuad(topPos,
        rimFilletBot[side]![k]!, outerFilletBot[side]![k]!,
        outerFilletBot[side]![k + 1]!, rimFilletBot[side]![k + 1]!);
    }
    const rb: [number, number, number] = [rim[side]![0], rim[side]![1], zBotWall];
    const ob: [number, number, number] = [outer[side]![0], outer[side]![1], zBotWall];
    const rt: [number, number, number] = [rim[side]![0], rim[side]![1], zTopWall];
    const ot: [number, number, number] = [outer[side]![0], outer[side]![1], zTopWall];
    pushQuad(topPos, rb, ob, ot, rt);
    for (let k = 0; k < FILLET_SEGMENTS; k++) {
      pushQuad(topPos,
        rimFilletTop[side]![k]!, outerFilletTop[side]![k]!,
        outerFilletTop[side]![k + 1]!, rimFilletTop[side]![k + 1]!);
    }
  }

  const topGeo = new THREE.BufferGeometry();
  topGeo.setAttribute("position", new THREE.Float32BufferAttribute(topPos, 3));
  topGeo.computeVertexNormals();

  const botGeo = new THREE.BufferGeometry();
  botGeo.setAttribute("position", new THREE.Float32BufferAttribute(botPos, 3));
  botGeo.computeVertexNormals();

  return { top: topGeo, bottom: botGeo };
}
