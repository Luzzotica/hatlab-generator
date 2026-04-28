import * as THREE from "three";
import type { BuiltSkeleton } from "@/lib/skeleton/geometry";
import { sweatbandPoint } from "@/lib/skeleton/geometry";
import { computeRearClosureRimThetaRange } from "@/lib/hat/rearClosureLayout";
import { offsetInwardXY } from "@/lib/mesh/sweatbandMesh";
import { BASE_THREAD_Z_OFFSET_M } from "@/lib/hat/threadingMesh";

const CORD_RADIUS_M = 0.00055;
const CORD_TUBULAR_SEG = 56;
const CORD_RADIAL_SEG = 6;

const CLIP_RENDER_ORDER = 5;

function cordMat(): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({
    color: 0x3a3d42,
    flatShading: false,
    side: THREE.DoubleSide,
    metalness: 0.02,
    roughness: 0.95,
  });
}

function plasticMat(): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({
    color: 0x6a9cbd,
    flatShading: false,
    side: THREE.DoubleSide,
    metalness: 0.06,
    roughness: 0.55,
  });
}

function clipMetalMat(): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({
    color: 0xb8bcc4,
    flatShading: false,
    side: THREE.DoubleSide,
    metalness: 0.45,
    roughness: 0.4,
  });
}

function lerp3(
  a: [number, number, number],
  b: [number, number, number],
  t: number,
): [number, number, number] {
  return [
    a[0] + (b[0] - a[0]) * t,
    a[1] + (b[1] - a[1]) * t,
    a[2] + (b[2] - a[2]) * t,
  ];
}

function add3(
  a: [number, number, number],
  b: [number, number, number],
): [number, number, number] {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}

function scale3(
  a: [number, number, number],
  s: number,
): [number, number, number] {
  return [a[0] * s, a[1] * s, a[2] * s];
}

/** Horizontal inward (toward z-axis) in XY from a rim point. */
function radialInwardXY3(p: [number, number, number]): [number, number, number] {
  const L = Math.hypot(p[0], p[1]);
  if (L < 1e-12) return [0, 0, 0];
  return [-p[0] / L, -p[1] / L, 0];
}

/**
 * Shock cord: cubic Bezier between closure rails, tube along the curve, plastic + metal clip at mid-span.
 */
export function buildShockCordClosureGroup(sk: BuiltSkeleton): THREE.Group {
  const group = new THREE.Group();
  group.name = "Closure_ShockCord";

  if (!sk.spec.backClosureOpening) return group;

  const spec = sk.spec;
  const { thetaL, thetaR, center } = computeRearClosureRimThetaRange(sk);

  const pL0 = sweatbandPoint(
    thetaL,
    spec.semiAxisX,
    spec.semiAxisY,
    spec.yawRad,
  );
  const pR0 = sweatbandPoint(
    thetaR,
    spec.semiAxisX,
    spec.semiAxisY,
    spec.yawRad,
  );

  const attachIn = 0.0022;
  const p0 = offsetInwardXY(
    [pL0[0], pL0[1], pL0[2]] as [number, number, number],
    attachIn,
  );
  const p3 = offsetInwardXY(
    [pR0[0], pR0[1], pR0[2]] as [number, number, number],
    attachIn,
  );

  const pMidRim = sweatbandPoint(
    center,
    spec.semiAxisX,
    spec.semiAxisY,
    spec.yawRad,
  );
  const inward = radialInwardXY3([pMidRim[0], pMidRim[1], pMidRim[2]]);
  const lift: [number, number, number] = [0, 0, 0.014];

  const p1 = add3(
    add3(lerp3(p0, p3, 0.28), lift),
    scale3(inward, 0.022),
  );
  const p2 = add3(
    add3(lerp3(p0, p3, 0.72), lift),
    scale3(inward, 0.022),
  );

  const curve = new THREE.CubicBezierCurve3(
    new THREE.Vector3(p0[0], p0[1], p0[2]),
    new THREE.Vector3(p1[0], p1[1], p1[2]),
    new THREE.Vector3(p2[0], p2[1], p2[2]),
    new THREE.Vector3(p3[0], p3[1], p3[2]),
  );

  const tube = new THREE.Mesh(
    new THREE.TubeGeometry(
      curve,
      CORD_TUBULAR_SEG,
      CORD_RADIUS_M,
      CORD_RADIAL_SEG,
      false,
    ),
    cordMat(),
  );
  tube.name = "Closure_ShockCord_Cord";
  group.add(tube);

  const tMid = 0.5;
  const pos = curve.getPointAt(tMid);
  const tan = curve.getTangentAt(tMid).normalize();
  const out = new THREE.Vector3(pos.x, pos.y, 0);
  if (out.lengthSq() < 1e-14) out.set(1, 0, 0);
  out.normalize();
  const worldUp = new THREE.Vector3(0, 0, 1);

  const clip = new THREE.Group();
  clip.name = "Closure_ShockCord_Clip";

  const body = new THREE.Mesh(
    new THREE.BoxGeometry(0.012, 0.005, 0.009),
    plasticMat(),
  );
  body.name = "Closure_ShockCord_Clip_Body";
  body.renderOrder = CLIP_RENDER_ORDER;

  const pin = new THREE.Mesh(
    new THREE.BoxGeometry(0.013, 0.0012, 0.003),
    clipMetalMat(),
  );
  pin.name = "Closure_ShockCord_Clip_Pin";
  pin.renderOrder = CLIP_RENDER_ORDER;
  pin.position.y = 0.0008;

  clip.add(body);
  clip.add(pin);

  const rot = new THREE.Matrix4();
  rot.makeBasis(tan, out, worldUp);
  clip.setRotationFromMatrix(rot);
  clip.position.set(pos.x, pos.y, pos.z);

  group.add(clip);

  group.position.z = BASE_THREAD_Z_OFFSET_M;

  return group;
}
