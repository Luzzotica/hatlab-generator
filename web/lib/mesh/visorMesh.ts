import * as THREE from "three";
import type { BuiltSkeleton } from "@/lib/skeleton/geometry";
import {
  effectiveVisorHalfSpanRad,
  sweatbandPoint,
} from "@/lib/skeleton/geometry";

/** Brim slab thickness (skeleton units ≈ metres → 2 mm). */
export const VISOR_THICKNESS_M = 0.002;

/** Fillet radius (m) on top outer / inner rim; capped relative to thickness. */
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

function offsetZ(p: [number, number, number], dz: number): [number, number, number] {
  return [p[0], p[1], p[2] + dz];
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
 * Fillet arc from (p, z0) vertical to (p + N*R, z1) with quarter-circle in (N, Z).
 * z0 = t - R, z1 = t. Returns FILLET_SEGMENTS + 1 points (θ = 0 … π/2).
 */
function filletArcPoints(
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
    out.push([
      p[0] + N[0] * inward,
      p[1] + N[1] * inward,
      z0 + dz,
    ]);
  }
  return out;
}

/**
 * Filled visor: bottom at z=0 (sweatband plane), slab extends upward to z=THICKNESS.
 * Top outer rim and inner rim edges are rounded with fillets toward the patch centroid.
 */
export function buildVisorGeometry(sk: BuiltSkeleton): THREE.BufferGeometry {
  const outer = sk.visorPolyline;
  const m = outer.length;
  const geo = new THREE.BufferGeometry();
  if (m < 2) return geo;

  const spec = sk.spec;
  const v = spec.visor;
  const halfSpan = effectiveVisorHalfSpanRad(v, spec.nSeams, sk.angles);
  const c = v.attachAngleRad;
  const t = VISOR_THICKNESS_M;
  const R = Math.min(0.00055, t * 0.35);
  const positions: number[] = [];

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

  const Nrim: [number, number, number][] = rim.map((p) => inwardXY(p, cx, cy));
  const Nout: [number, number, number][] = outer.map((p) => inwardXY(p, cx, cy));

  const rimBot = rim;
  const outerBot = outer;
  const rimTopFlat: [number, number, number][] = rim.map((p, i) => {
    const N = Nrim[i]!;
    return [p[0] + N[0] * R, p[1] + N[1] * R, t];
  });
  const outerTopFlat: [number, number, number][] = outer.map((p, i) => {
    const N = Nout[i]!;
    return [p[0] + N[0] * R, p[1] + N[1] * R, t];
  });

  const rimFillet = rim.map((p, i) => filletArcPoints(p, Nrim[i]!, R, t, FILLET_SEGMENTS));
  const outerFillet = outer.map((p, i) => filletArcPoints(p, Nout[i]!, R, t, FILLET_SEGMENTS));

  // Bottom face (z=0, normal -Z)
  for (let i = 0; i < m - 1; i++) {
    const r0 = rimBot[i]!;
    const r1 = rimBot[i + 1]!;
    const o0 = outerBot[i]!;
    const o1 = outerBot[i + 1]!;
    pushTriangle(positions, r0, o0, r1);
    pushTriangle(positions, r1, o0, o1);
  }

  // Top flat (between inset boundaries, +Z)
  for (let i = 0; i < m - 1; i++) {
    const r0 = rimTopFlat[i]!;
    const r1 = rimTopFlat[i + 1]!;
    const o0 = outerTopFlat[i]!;
    const o1 = outerTopFlat[i + 1]!;
    pushTriangle(positions, r0, r1, o0);
    pushTriangle(positions, r1, o1, o0);
  }

  // Inner rim: vertical wall z=0 to z=t-R, then fillet strips between consecutive vertices
  const zWall = t - R;
  for (let i = 0; i < m - 1; i++) {
    const r0b = rimBot[i]!;
    const r1b = rimBot[i + 1]!;
    const r0w = offsetZ(rimBot[i]!, zWall);
    const r1w = offsetZ(rimBot[i + 1]!, zWall);
    pushQuad(positions, r0b, r1b, r1w, r0w);
  }
  for (let i = 0; i < m - 1; i++) {
    for (let k = 0; k < FILLET_SEGMENTS; k++) {
      const a0 = rimFillet[i]![k]!;
      const a1 = rimFillet[i + 1]![k]!;
      const c1 = rimFillet[i + 1]![k + 1]!;
      const c0 = rimFillet[i]![k + 1]!;
      pushQuad(positions, a0, a1, c1, c0);
    }
  }

  // Outer edge: vertical wall + fillet
  for (let i = 0; i < m - 1; i++) {
    const o0b = outerBot[i]!;
    const o1b = outerBot[i + 1]!;
    const o0w = offsetZ(outerBot[i]!, zWall);
    const o1w = offsetZ(outerBot[i + 1]!, zWall);
    pushQuad(positions, o0b, o0w, o1w, o1b);
  }
  for (let i = 0; i < m - 1; i++) {
    for (let k = 0; k < FILLET_SEGMENTS; k++) {
      const a0 = outerFillet[i]![k]!;
      const a1 = outerFillet[i+1]![k]!;
      const c1 = outerFillet[i+1]![k + 1]!;
      const c0 = outerFillet[i]![k + 1]!;
      pushQuad(positions, a0, a1, c1, c0);
    }
  }

  // End caps: vertical wall + fillet quads between rim and outer columns
  for (const side of [0, m - 1] as const) {
    const rb = rimBot[side]!;
    const ob = outerBot[side]!;
    const rw = offsetZ(rimBot[side]!, zWall);
    const ow = offsetZ(outerBot[side]!, zWall);
    pushQuad(positions, rb, ob, ow, rw);
    for (let k = 0; k < FILLET_SEGMENTS; k++) {
      const a0 = rimFillet[side]![k]!;
      const a1 = outerFillet[side]![k]!;
      const b1 = outerFillet[side]![k + 1]!;
      const b0 = rimFillet[side]![k + 1]!;
      pushQuad(positions, a0, a1, b1, b0);
    }
  }

  geo.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geo.computeVertexNormals();
  return geo;
}
