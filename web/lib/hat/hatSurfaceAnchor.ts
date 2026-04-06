import * as THREE from "three";
import type { BuiltSkeleton } from "@/lib/skeleton/geometry";
import type { HatSkeletonSpec } from "@/lib/skeleton/types";
import { outwardCrownNormalApprox } from "@/lib/hat/curveUtils";
import { samplePanelMeridian } from "@/lib/mesh/crownMesh";

export type SurfaceAnchorVec3 = [number, number, number];

const _tri = new THREE.Triangle();
const _p = new THREE.Vector3();
const _closest = new THREE.Vector3();
const _bary = new THREE.Vector3();
const _n0 = new THREE.Vector3();
const _n1 = new THREE.Vector3();
const _n2 = new THREE.Vector3();
const _nSum = new THREE.Vector3();

/**
 * Vertical samples on the outer crown between the two seams of `panel`, at the arc midpoint
 * (`jArc = floor(M/2)`). `pts[0]` is rim (`k=0`), `pts[pts.length - 1]` is crown top (`k=N`).
 */
export function samplePanelMidMeridian(
  sk: BuiltSkeleton,
  panel: number,
  M: number,
  N: number,
): SurfaceAnchorVec3[] {
  const jMid = Math.floor(M / 2);
  return samplePanelMeridian(sk, panel, jMid, M, N);
}

/**
 * Walk from the crown **top** (last sample) toward the rim along the polyline until `distanceDownM`
 * arc length is consumed. If the polyline is shorter than `distanceDownM`, returns the rim point.
 */
export function pointAlongPolylineByArcLengthFromTop(
  pts: ReadonlyArray<SurfaceAnchorVec3>,
  distanceDownM: number,
): SurfaceAnchorVec3 {
  if (pts.length === 0) return [0, 0, 0];
  if (pts.length === 1) return [pts[0]![0], pts[0]![1], pts[0]![2]];
  let remaining = Math.max(0, distanceDownM);
  for (let i = pts.length - 1; i > 0; i--) {
    const a = pts[i]!;
    const b = pts[i - 1]!;
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const dz = b[2] - a[2];
    const segLen = Math.hypot(dx, dy, dz);
    if (segLen < 1e-15) continue;
    if (remaining <= segLen) {
      const t = remaining / segLen;
      return [a[0] + t * dx, a[1] + t * dy, a[2] + t * dz];
    }
    remaining -= segLen;
  }
  const rim = pts[0]!;
  return [rim[0], rim[1], rim[2]];
}

/**
 * Closest point on the union of crown panel meshes (non-indexed triangle soup with `position` +
 * `normal` per vertex) and interpolated vertex normal at that point. Normals are flipped to match
 * {@link outwardCrownNormalApprox} when winding disagrees.
 */
export function closestPointAndNormalOnGeometries(
  queryPoint: SurfaceAnchorVec3,
  geometries: readonly THREE.BufferGeometry[],
  spec: HatSkeletonSpec,
): { point: SurfaceAnchorVec3; normal: SurfaceAnchorVec3 } | null {
  _p.set(queryPoint[0], queryPoint[1], queryPoint[2]);
  let bestD2 = Infinity;
  let bestPoint: SurfaceAnchorVec3 = queryPoint;
  let bestNormal: SurfaceAnchorVec3 = [0, 0, 1];

  for (const geo of geometries) {
    const pos = geo.getAttribute("position") as THREE.BufferAttribute | undefined;
    const nrm = geo.getAttribute("normal") as THREE.BufferAttribute | undefined;
    if (!pos || !nrm || pos.count < 3) continue;

    for (let i = 0; i + 2 < pos.count; i += 3) {
      _tri.a.set(pos.getX(i), pos.getY(i), pos.getZ(i));
      _tri.b.set(pos.getX(i + 1), pos.getY(i + 1), pos.getZ(i + 1));
      _tri.c.set(pos.getX(i + 2), pos.getY(i + 2), pos.getZ(i + 2));
      _tri.closestPointToPoint(_p, _closest);
      const d2 = _closest.distanceToSquared(_p);
      if (d2 >= bestD2) continue;
      bestD2 = d2;

      const bc = THREE.Triangle.getBarycoord(
        _closest,
        _tri.a,
        _tri.b,
        _tri.c,
        _bary,
      );
      _n0.set(nrm.getX(i), nrm.getY(i), nrm.getZ(i));
      _n1.set(nrm.getX(i + 1), nrm.getY(i + 1), nrm.getZ(i + 1));
      _n2.set(nrm.getX(i + 2), nrm.getY(i + 2), nrm.getZ(i + 2));
      if (bc === null) {
        _tri.getNormal(_nSum);
      } else {
        _nSum
          .set(0, 0, 0)
          .addScaledVector(_n0, _bary.x)
          .addScaledVector(_n1, _bary.y)
          .addScaledVector(_n2, _bary.z);
        if (_nSum.lengthSq() < 1e-20) {
          _tri.getNormal(_nSum);
        } else {
          _nSum.normalize();
        }
      }

      const pArr: SurfaceAnchorVec3 = [_closest.x, _closest.y, _closest.z];
      const approx = outwardCrownNormalApprox(pArr, spec);
      if (
        _nSum.x * approx[0] +
          _nSum.y * approx[1] +
          _nSum.z * approx[2] <
        0
      ) {
        _nSum.negate();
      }

      bestPoint = pArr;
      bestNormal = [_nSum.x, _nSum.y, _nSum.z];
    }
  }

  if (bestD2 === Infinity) return null;
  return { point: bestPoint, normal: bestNormal };
}
