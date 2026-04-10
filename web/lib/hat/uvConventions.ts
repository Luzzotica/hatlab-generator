/**
 * UV authoring conventions for procedural hat meshes (export + PBR).
 * All maps (base color, normal, roughness, AO) share TEXCOORD_0 (`uv`).
 *
 * - **Crown panels:** u = meridian j/M, v = rim→apex k/N on outer/inner shells;
 *   rim/top bands use u along seam, v across shell thickness (0–1).
 * - **Inner front rise:** same (j/M, k/N) as crown inner grid.
 * - **Sweatband:** u = arc length along strip (0–1), v = height up band (0–1).
 * - **Visor slabs / fillet / tuck:** u = span s (0–1), v = depth d (0–1) in ruled space.
 * - **Ribbons (tape, thread):** u along path (0–1 arc-length), v across width (0–1).
 * - **Bill rope:** u along centerline (0–1), v around tube (0–1).
 * - **Built-in primitives (lathe, torus):** Three.js default UVs.
 */

export type UV2 = readonly [number, number];

/** Interpolate UV for quad subdivision (matches 3D midpoint). */
export function midpointUV(a: UV2, b: UV2): [number, number] {
  return [0.5 * (a[0] + b[0]), 0.5 * (a[1] + b[1])];
}

/**
 * Planar UV projection onto XY for non-indexed triangle soup (one vertex per float triple).
 * Used where explicit UVs are not authored (e.g. closure hardware).
 */
export function planarUvFromPositionsXY(positions: number[]): Float32Array | null {
  const nVert = positions.length / 3;
  if (nVert < 1) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < positions.length; i += 3) {
    const x = positions[i]!;
    const y = positions[i + 1]!;
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  }
  const dx = maxX - minX;
  const dy = maxY - minY;
  if (dx < 1e-15 || dy < 1e-15) return null;
  const uv = new Float32Array(nVert * 2);
  for (let vi = 0, pi = 0; vi < nVert; vi++, pi += 3) {
    uv[vi * 2] = (positions[pi]! - minX) / dx;
    uv[vi * 2 + 1] = (positions[pi + 1]! - minY) / dy;
  }
  return uv;
}
