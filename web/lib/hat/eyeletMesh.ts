import * as THREE from "three";
import type { BuiltSkeleton } from "@/lib/skeleton/geometry";
import { eyeletPanelIndices } from "@/lib/skeleton/geometry";
import type { EyeletStyle } from "@/lib/skeleton/types";
import { getCrownMeshResolution } from "@/lib/mesh/crownMesh";
import {
  closestPointAndNormalOnGeometries,
  pointAlongPolylineByArcLengthFromTop,
  samplePanelMidMeridian,
} from "@/lib/hat/hatSurfaceAnchor";

/** Push eyelets slightly off the crown shell to reduce z-fighting (cf. bill rope). */
const EYELET_OUTWARD_M = 0.00015;

const TORUS_MAJOR_R = 0.002;
const TORUS_TUBE_R = 0.0007;

export function buildEyeletGeometry(): THREE.TorusGeometry {
  return new THREE.TorusGeometry(TORUS_MAJOR_R, TORUS_TUBE_R, 12, 24);
}

function eyeletMaterial(
  style: Exclude<EyeletStyle, "none">,
): THREE.MeshStandardMaterial {
  if (style === "metal") {
    return new THREE.MeshStandardMaterial({
      color: 0x9ca3af,
      metalness: 0.75,
      roughness: 0.35,
      flatShading: false,
      side: THREE.DoubleSide,
    });
  }
  return new THREE.MeshStandardMaterial({
    color: 0x4b5563,
    metalness: 0.06,
    roughness: 0.88,
    flatShading: false,
    side: THREE.DoubleSide,
  });
}

/**
 * Vent eyelets on crown panels. Uses the same torus geometry for cloth and metal; materials differ.
 * `crownPanelGeometries` must match the crown panel meshes (positions + vertex normals).
 */
export function buildEyeletGroup(
  sk: BuiltSkeleton,
  crownPanelGeometries: readonly THREE.BufferGeometry[],
): THREE.Group {
  const group = new THREE.Group();
  group.name = "Eyelets";
  const style = sk.spec.eyeletStyle;
  if (style === "none") return group;

  const mat = eyeletMaterial(style);
  const { M, N } = getCrownMeshResolution(sk);
  const drop = sk.spec.eyeletDropFromTopM;
  const sharedGeo = buildEyeletGeometry();
  const panels = eyeletPanelIndices(sk.spec);

  const nVec = new THREE.Vector3();
  const zAxis = new THREE.Vector3(0, 0, 1);
  const quat = new THREE.Quaternion();

  for (const panel of panels) {
    const mid = samplePanelMidMeridian(sk, panel, M, N);
    const candidate = pointAlongPolylineByArcLengthFromTop(mid, drop);
    const hit = closestPointAndNormalOnGeometries(
      candidate,
      crownPanelGeometries,
      sk.spec,
    );
    if (!hit) continue;

    const mesh = new THREE.Mesh(sharedGeo, mat);
    mesh.name = `Eyelet_p${panel}`;

    nVec.set(hit.normal[0], hit.normal[1], hit.normal[2]);
    if (nVec.lengthSq() < 1e-12) nVec.set(0, 0, 1);
    else nVec.normalize();
    quat.setFromUnitVectors(zAxis, nVec);
    mesh.quaternion.copy(quat);
    mesh.position.set(hit.point[0], hit.point[1], hit.point[2]);
    mesh.position.addScaledVector(nVec, EYELET_OUTWARD_M);
    group.add(mesh);
  }

  return group;
}
