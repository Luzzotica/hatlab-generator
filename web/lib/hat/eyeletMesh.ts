import * as THREE from "three";
import type { BuiltSkeleton } from "@/lib/skeleton/geometry";
import { eyeletPanelIndices } from "@/lib/skeleton/geometry";
import type { EyeletStyle } from "@/lib/skeleton/types";
import { getCrownMeshResolution } from "@/lib/mesh/crownMesh";
import { outwardCrownNormalApprox } from "@/lib/hat/curveUtils";
import {
  pointAlongPolylineByArcLengthFromTop,
  samplePanelMidMeridian,
} from "@/lib/hat/hatSurfaceAnchor";

/**
 * Offset along the crown outward normal (meters). Negative nudges the torus into the shell so the
 * ring reads from the interior; too far negative can z-fight the outer surface.
 */
const EYELET_RADIAL_OFFSET_M = -0.001;

const TORUS_MAJOR_R = 0.002;
const TORUS_TUBE_R = 0.0007;

/**
 * TorusGeometry uses +Z as the hole axis; we align that to the crown outward normal. Scale Z
 * elongates the tube cross-section through the shell (visible from inside without as deep an offset).
 */
const EYELET_NORMAL_AXIS_SCALE = 2.75;

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

/** Torus lies in XY with +Z through the hole; align local +Z to outward unit normal `nUnit`. */
function setQuaternionFromZToNormal(
  quat: THREE.Quaternion,
  nUnit: THREE.Vector3,
  zAxis: THREE.Vector3,
): void {
  quat.setFromUnitVectors(zAxis, nUnit);
  if (
    !Number.isFinite(quat.x) ||
    !Number.isFinite(quat.y) ||
    !Number.isFinite(quat.z) ||
    !Number.isFinite(quat.w)
  ) {
    quat.identity();
  }
}

/**
 * Vent eyelets on crown panels. Uses the same torus geometry for cloth and metal; materials differ.
 *
 * Placement uses the skeleton mid-meridian + analytic outward normal — not closest-point on the
 * triangulated panel. Closure cutouts and tunnel walls can produce bad or NaN interpolated
 * vertex normals on one panel; projecting from mesh normals made that eyelet invisible (NaN
 * quaternion). Snapping to the full crown union also stole eyelets onto the wrong panel at seams.
 */
export function buildEyeletGroup(
  sk: BuiltSkeleton,
  _crownPanelGeometries: readonly THREE.BufferGeometry[],
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

    if (
      !Number.isFinite(candidate[0]) ||
      !Number.isFinite(candidate[1]) ||
      !Number.isFinite(candidate[2])
    ) {
      continue;
    }

    const normal = outwardCrownNormalApprox(candidate, sk.spec);
    nVec.set(normal[0], normal[1], normal[2]);
    if (
      !Number.isFinite(nVec.x) ||
      !Number.isFinite(nVec.y) ||
      !Number.isFinite(nVec.z) ||
      nVec.lengthSq() < 1e-20
    ) {
      nVec.set(0, 0, 1);
    } else {
      nVec.normalize();
    }

    const mesh = new THREE.Mesh(sharedGeo, mat);
    mesh.name = `Eyelet_p${panel}`;

    setQuaternionFromZToNormal(quat, nVec, zAxis);
    mesh.quaternion.copy(quat);
    mesh.scale.set(1, 1, EYELET_NORMAL_AXIS_SCALE);
    mesh.position.set(candidate[0], candidate[1], candidate[2]);
    mesh.position.addScaledVector(nVec, EYELET_RADIAL_OFFSET_M);

    group.add(mesh);
  }

  return group;
}
