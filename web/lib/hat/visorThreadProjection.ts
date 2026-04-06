import * as THREE from "three";

/**
 * Top/bottom slab geometries from {@link buildVisorTopBottomGeometries}, in skeleton space
 * (+Z up). Used to lift XY planform samples onto the actual visor mesh via vertical rays.
 */
export type VisorThreadingGeometries = {
  top: THREE.BufferGeometry;
  bottom: THREE.BufferGeometry;
};

/** DoubleSide so vertical rays register hits on either face of the slab (FrontSide misses ~all). */
const _dummyMat = new THREE.MeshBasicMaterial({
  side: THREE.DoubleSide,
});
const _raycaster = new THREE.Raycaster();
const _origin = new THREE.Vector3();
const _dirDown = new THREE.Vector3(0, 0, -1);
const _dirUp = new THREE.Vector3(0, 0, 1);

/** World-space AABB of geometry positions (skeleton coordinates). */
export function computeGeometryAabb(geom: THREE.BufferGeometry): THREE.Box3 {
  if (!geom.boundingBox) {
    geom.computeBoundingBox();
  }
  return geom.boundingBox!.clone();
}

/**
 * Cast a vertical ray through (px, py) onto one visor mesh: from above (+Z) for the top slab,
 * from below (−Z) for the bottom slab. Ray extent is derived from the mesh AABB so origins sit
 * outside the volume and hits are not from inside the bill.
 */
export function projectXyOntoVisorMesh(
  geom: THREE.BufferGeometry,
  px: number,
  py: number,
  fromAbove: boolean,
): THREE.Vector3 | null {
  geom.computeBoundingSphere();
  const box = computeGeometryAabb(geom);
  const extentZ = Math.max(1e-6, box.max.z - box.min.z);
  const margin = Math.max(0.03, extentZ * 0.75 + 0.02);
  const z0 = fromAbove ? box.max.z + margin : box.min.z - margin;
  _origin.set(px, py, z0);
  const dir = fromAbove ? _dirDown : _dirUp;
  _raycaster.set(_origin, dir);

  const mesh = new THREE.Mesh(geom, _dummyMat);
  mesh.updateMatrixWorld(true);
  const hits = _raycaster.intersectObject(mesh, false);
  if (hits.length === 0) {
    return null;
  }
  return hits[0]!.point.clone();
}

/**
 * Reusable ray helpers (one per geometry × direction) to avoid allocating Meshes per sample.
 */
export class VisorMeshRayHelper {
  private readonly mesh: THREE.Mesh;
  private readonly box: THREE.Box3;
  private readonly fromAbove: boolean;

  constructor(geom: THREE.BufferGeometry, fromAbove: boolean) {
    geom.computeBoundingSphere();
    this.mesh = new THREE.Mesh(geom, _dummyMat);
    this.mesh.updateMatrixWorld(true);
    this.box = computeGeometryAabb(geom);
    this.fromAbove = fromAbove;
  }

  project(px: number, py: number): THREE.Vector3 | null {
    const extentZ = Math.max(1e-6, this.box.max.z - this.box.min.z);
    const margin = Math.max(0.03, extentZ * 0.75 + 0.02);
    const z0 = this.fromAbove
      ? this.box.max.z + margin
      : this.box.min.z - margin;
    _origin.set(px, py, z0);
    const dir = this.fromAbove ? _dirDown : _dirUp;
    _raycaster.set(_origin, dir);
    const hits = _raycaster.intersectObject(this.mesh, false);
    if (hits.length === 0) {
      return null;
    }
    return hits[0]!.point.clone();
  }
}
