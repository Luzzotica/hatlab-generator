import * as THREE from "three";

/**
 * `Object3D.clone(true)` still shares {@link THREE.BufferGeometry} and materials with the source.
 * Call this on the clone before disposing the original so GLB export does not read disposed data.
 */
export function deepCloneMeshResources(root: THREE.Object3D): void {
  root.traverse((obj) => {
    if (obj instanceof THREE.Mesh) {
      obj.geometry = obj.geometry.clone();
      const m = obj.material;
      if (Array.isArray(m)) {
        obj.material = m.map((mat) => mat.clone());
      } else if (m) {
        obj.material = m.clone();
      }
    }
    if (obj instanceof THREE.Line || obj instanceof THREE.LineSegments) {
      obj.geometry = obj.geometry.clone();
      const mat = obj.material as THREE.Material | THREE.Material[];
      if (Array.isArray(mat)) {
        obj.material = mat.map((x) => x.clone());
      } else if (mat) {
        obj.material = mat.clone();
      }
    }
  });
}

/** Dispose geometries and materials under a built export group. */
export function disposeExportObject3D(root: THREE.Object3D): void {
  root.traverse((obj) => {
    if (obj instanceof THREE.Mesh) {
      obj.geometry.dispose();
      const m = obj.material;
      if (Array.isArray(m)) m.forEach((x) => x.dispose());
      else m.dispose();
    }
    if (obj instanceof THREE.Line || obj instanceof THREE.LineSegments) {
      obj.geometry.dispose();
      (obj.material as THREE.Material).dispose();
    }
  });
}
