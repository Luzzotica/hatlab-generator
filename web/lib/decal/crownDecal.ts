import * as THREE from "three";
import { DecalGeometry } from "three-stdlib";
import { getRearClosureAdjacentPanelIndices } from "@/lib/mesh/backClosureSubtract";
import { frontRisePanelIndices } from "@/lib/skeleton/geometry";
import type { PanelCount } from "@/lib/skeleton/types";

/**
 * GLB export merges all front-rise crown panels into one mesh so DCC tools can project
 * decals / textures onto a single surface.
 */
export const CROWN_FRONT_MERGED_MESH_NAME = "Crown_Front";

/** Rear closure-adjacent panels merged into one mesh in GLB export (two panels → one surface). */
export const CROWN_REAR_MERGED_MESH_NAME = "Crown_Rear";

/** Inner shell for front-rise panels (merged); export-only — decals target {@link CROWN_FRONT_MERGED_MESH_NAME}. */
export const CROWN_FRONT_INNER_MERGED_MESH_NAME = "Crown_Front_Inner";

/** Inner shell for rear closure-adjacent panels (merged). */
export const CROWN_REAR_INNER_MERGED_MESH_NAME = "Crown_Rear_Inner";

/** Matches @react-three/drei Decal when `rotation` is a number (radians). */
export function computeDecalEulerLocalLikeDrei(
  mesh: THREE.Mesh,
  localPosition: THREE.Vector3,
  zRotation: number,
): THREE.Euler {
  const o = new THREE.Object3D();
  o.position.copy(localPosition);
  const geom = mesh.geometry;
  if (!geom.getAttribute("normal")) geom.computeVertexNormals();
  const vertices = geom.attributes.position.array as Float32Array;
  const normals = geom.attributes.normal!.array as Float32Array;
  let distance = Infinity;
  let chosenIdx = -1;
  const ox = o.position.x;
  const oy = o.position.y;
  const oz = o.position.z;
  const vLength = vertices.length;
  for (let i = 0; i < vLength; i += 3) {
    const x = vertices[i]!;
    const y = vertices[i + 1]!;
    const z = vertices[i + 2]!;
    const xDiff = x - ox;
    const yDiff = y - oy;
    const zDiff = z - oz;
    const distSquared = xDiff * xDiff + yDiff * yDiff + zDiff * zDiff;
    if (distSquared < distance) {
      distance = distSquared;
      chosenIdx = i;
    }
  }
  const closestNormal = new THREE.Vector3(
    normals[chosenIdx]!,
    normals[chosenIdx + 1]!,
    normals[chosenIdx + 2]!,
  );
  o.lookAt(o.position.clone().add(closestNormal));
  o.rotateZ(Math.PI);
  o.rotateY(Math.PI);
  o.rotateZ(zRotation);
  return o.rotation.clone();
}

export function defaultDecalLocalCenter(mesh: THREE.Mesh): THREE.Vector3 {
  const g = mesh.geometry;
  if (!g.boundingBox) g.computeBoundingBox();
  const bb = g.boundingBox!;
  const c = new THREE.Vector3();
  bb.getCenter(c);
  return c;
}

export function loadTextureFromDataUrl(dataUrl: string): Promise<THREE.Texture> {
  const loader = new THREE.TextureLoader();
  return loader.loadAsync(dataUrl);
}

export interface HatDecalPersisted {
  panelIndex: number;
  /** Local position on `Panel_{panelIndex}` (metres). */
  position: [number, number, number];
  /** Extra roll around the decal normal (radians); matches drei `Decal` `rotation` when numeric. */
  zRotation: number;
  /** Projector box size in panel local space (metres). */
  scale: [number, number, number];
  imageDataUrl: string;
}

const DECAL_MESH_NAME = "Decal_Logo";

export function buildCrownDecalMesh(
  panelMesh: THREE.Mesh,
  decal: Pick<
    HatDecalPersisted,
    "position" | "zRotation" | "scale"
  >,
  texture: THREE.Texture,
): THREE.Mesh {
  texture.colorSpace = THREE.SRGBColorSpace;
  const pos = new THREE.Vector3().fromArray(decal.position);
  const euler = computeDecalEulerLocalLikeDrei(panelMesh, pos, decal.zRotation);
  const size = new THREE.Vector3().fromArray(decal.scale);
  const geo = new DecalGeometry(panelMesh, pos, euler, size);
  const mat = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    map: texture,
    transparent: true,
    roughness: 0.85,
    metalness: 0,
    side: THREE.DoubleSide,
    polygonOffset: true,
    polygonOffsetFactor: -4,
    depthWrite: true,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = DECAL_MESH_NAME;
  mesh.renderOrder = 10;
  return mesh;
}

/**
 * Finds the crown panel mesh for decal placement. Viewer uses `Panel_{index}`; GLB export merges
 * front-rise panels into {@link CROWN_FRONT_MERGED_MESH_NAME} on the **outer** shell (under `Crown_Outer`
 * in modular export). Inner shells use {@link CROWN_FRONT_INNER_MERGED_MESH_NAME} / `Panel_*_Inner`.
 */
export function findCrownPanelMesh(
  frame: THREE.Object3D,
  panelIndex: number,
  nSeams?: PanelCount,
): THREE.Mesh | undefined {
  const direct = frame.getObjectByName(`Panel_${panelIndex}`);
  if (direct instanceof THREE.Mesh) return direct;
  if (nSeams !== undefined) {
    const front = frontRisePanelIndices(nSeams);
    if (front.includes(panelIndex)) {
      const merged = frame.getObjectByName(CROWN_FRONT_MERGED_MESH_NAME);
      if (merged instanceof THREE.Mesh) return merged;
    }
    const { leftPanel, rightPanel } = getRearClosureAdjacentPanelIndices(nSeams);
    if (panelIndex === leftPanel || panelIndex === rightPanel) {
      const merged = frame.getObjectByName(CROWN_REAR_MERGED_MESH_NAME);
      if (merged instanceof THREE.Mesh) return merged;
    }
  }
  return undefined;
}

export function addCrownDecalToExportFrame(
  frame: THREE.Group,
  panelMesh: THREE.Mesh,
  decal: HatDecalPersisted,
  texture: THREE.Texture,
): void {
  const decalMesh = buildCrownDecalMesh(panelMesh, decal, texture);
  frame.add(decalMesh);
}
