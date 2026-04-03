import * as THREE from "three";
import { mergeVertices } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { Brush, Evaluator, HOLLOW_SUBTRACTION } from "three-bvh-csg";
import type { BuiltSkeleton } from "@/lib/skeleton/geometry";
import {
  evalSeamCurve,
  rearCenterSeamIndex,
  sweatbandTangentTheta,
  type SeamCurve,
} from "@/lib/skeleton/geometry";

/** 3 in — opening width (along circumferential / rim tangent). */
export const BACK_CLOSURE_WIDTH_M = 3 * 0.0254;
/** Kept for reference; profile is straight sides + semicircle (see total height below). */
export const BACK_CLOSURE_HEIGHT_M = 2.75 * 0.0254;

/** Vertical straight run on left/right (closure rails), then semicircular arc (diameter = width). */
export const BACK_CLOSURE_STRAIGHT_EDGE_M = 0.025;

/** Overall height = {@link BACK_CLOSURE_STRAIGHT_EDGE_M} + width/2 (semicircle on top). */
export const BACK_CLOSURE_TOTAL_HEIGHT_M =
  BACK_CLOSURE_STRAIGHT_EDGE_M + BACK_CLOSURE_WIDTH_M * 0.5;

/**
 * Thin slab along +surface normal only — must not extend deep into the interior or CSG
 * removes the front of the shell too. Straddles the outer surface with a small inward bias.
 */
const CLOSURE_CUT_DEPTH_M = 0.08;
const CLOSURE_CUT_INWARD_BIAS_M = 0.04;

/**
 * Move the opening toward the brim along −tH (from seam rim toward band). The seam sample at u=0
 * can sit slightly above where the sweatband polyline reads visually on screen.
 */
const BACK_CLOSURE_DROP_TOWARD_BRIM_M = 0.02;

/** Extra width + straight leg on arch tape relative to cutout (pattern margin). */
export const BACK_CLOSURE_TAPE_MARGIN_M = 0.01;

function cross(
  a: readonly [number, number, number],
  b: readonly [number, number, number],
): [number, number, number] {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}

function dot(
  a: readonly [number, number, number],
  b: readonly [number, number, number],
): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function norm(v: readonly [number, number, number]): [number, number, number] {
  const L = Math.hypot(v[0], v[1], v[2]);
  if (L < 1e-15) throw new Error("degenerate vector");
  return [v[0] / L, v[1] / L, v[2] / L];
}

function sub(
  a: readonly [number, number, number],
  b: readonly [number, number, number],
): [number, number, number] {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

function scale(
  v: readonly [number, number, number],
  s: number,
): [number, number, number] {
  return [v[0] * s, v[1] * s, v[2] * s];
}

function seamTangentU(curve: SeamCurve, t: number): [number, number, number] {
  const eps = 1e-4;
  let t0 = t;
  let t1 = t + eps;
  if (t1 > 1) {
    t1 = t;
    t0 = Math.max(0, t - eps);
  }
  const p = evalSeamCurve(curve, t0);
  const q = evalSeamCurve(curve, t1);
  const d: [number, number, number] = [q[0] - p[0], q[1] - p[1], q[2] - p[2]];
  const L = Math.hypot(d[0], d[1], d[2]);
  if (L < 1e-12) return [0, 0, 1];
  return [d[0] / L, d[1] / L, d[2] / L];
}

/**
 * Orthonormal tangent frame: tW ≈ circumferential (width), tH ≈ up along seam (height),
 * n outward. Gram–Schmidt so width/height stay aligned with physical opening axes.
 */
function openingFrame(
  eTheta: [number, number, number],
  eU: [number, number, number],
  p: [number, number, number],
): {
  tW: [number, number, number];
  tH: [number, number, number];
  n: [number, number, number];
} {
  let nRaw = cross(eTheta, eU);
  if (Math.hypot(nRaw[0], nRaw[1], nRaw[2]) < 1e-10) {
    nRaw = cross(eTheta, [0, 0, 1]);
  }
  let n = norm(nRaw);
  const radial = norm([p[0], p[1], 0]);
  if (dot(n, radial) < 0) {
    n = [-n[0], -n[1], -n[2]];
  }

  let tW = sub(eTheta, scale(n, dot(eTheta, n)));
  const lenW = Math.hypot(tW[0], tW[1], tW[2]);
  if (lenW < 1e-8) {
    tW = norm(cross(eU, n));
  } else {
    tW = [tW[0] / lenW, tW[1] / lenW, tW[2] / lenW];
  }

  let tH = sub(eU, scale(n, dot(eU, n)));
  tH = sub(tH, scale(tW, dot(tH, tW)));
  const lenH = Math.hypot(tH[0], tH[1], tH[2]);
  if (lenH < 1e-8) {
    tH = norm(cross(n, tW));
  } else {
    tH = [tH[0] / lenH, tH[1] / lenH, tH[2] / lenH];
  }
  if (dot(tH, eU) < 0) {
    tH = [-tH[0], -tH[1], -tH[2]];
  }

  return { tW, tH, n };
}

/** Same frame as the closure cutter / CSG subtract — use for tape clipping and arch placement. */
export function getBackClosureOpeningFrame(sk: BuiltSkeleton): {
  tW: [number, number, number];
  tH: [number, number, number];
  n: [number, number, number];
  rimAnchor: [number, number, number];
} {
  const spec = sk.spec;
  const rearIdx = rearCenterSeamIndex(spec.nSeams);
  const theta = sk.angles[rearIdx]!;
  const seam = sk.seamControls[rearIdx]!;

  const pRim = evalSeamCurve(seam, 0);
  const uTiny = 1e-5;
  const eTheta = sweatbandTangentTheta(
    theta,
    spec.semiAxisX,
    spec.semiAxisY,
    spec.yawRad,
  );
  const eU = seamTangentU(seam, uTiny);

  const { tW, tH, n } = openingFrame(eTheta, eU, pRim);
  const rimAnchor = sub(pRim, scale(tH, BACK_CLOSURE_DROP_TOWARD_BRIM_M));
  return { tW, tH, n, rimAnchor };
}

function applyClosureBasisToGeometry(
  geo: THREE.BufferGeometry,
  tW: [number, number, number],
  tH: [number, number, number],
  n: [number, number, number],
  rimCenter: [number, number, number],
): void {
  const basis = new THREE.Matrix4();
  basis.makeBasis(
    new THREE.Vector3(tW[0], tW[1], tW[2]),
    new THREE.Vector3(tH[0], tH[1], tH[2]),
    new THREE.Vector3(n[0], n[1], n[2]),
  );
  const pos = new THREE.Matrix4().makeTranslation(
    rimCenter[0],
    rimCenter[1],
    rimCenter[2],
  );
  const transform = new THREE.Matrix4().multiplyMatrices(pos, basis);
  geo.applyMatrix4(transform);
}

/**
 * Stadium profile: flat bottom on rim, vertical sides for `straightM`, then semicircle (diameter = widthM).
 * Local 2D: x = width (circumferential), y = height along seam-up (tH). Total height = straightM + widthM/2.
 */
export function buildStadiumShape(
  widthM: number,
  straightM: number,
): THREE.Shape {
  const halfW = widthM * 0.5;
  const R = halfW;
  const h = straightM;
  const shape = new THREE.Shape();
  shape.moveTo(-halfW, 0);
  shape.lineTo(-halfW, h);
  shape.absarc(0, h, R, Math.PI, 0, true);
  shape.lineTo(halfW, 0);
  shape.lineTo(-halfW, 0);
  return shape;
}

/** Inner boundary for {@link buildStadiumShape}, opposite winding for use as `Shape.holes` entry. */
export function buildStadiumHolePath(
  widthM: number,
  straightM: number,
): THREE.Path {
  const halfW = widthM * 0.5;
  const R = halfW;
  const h = straightM;
  const hole = new THREE.Path();
  hole.moveTo(-halfW, 0);
  hole.lineTo(halfW, 0);
  hole.lineTo(halfW, h);
  hole.absarc(0, h, R, 0, Math.PI, false);
  hole.lineTo(-halfW, h);
  hole.lineTo(-halfW, 0);
  return hole;
}

function buildClosureCutterGeometry(
  widthM: number,
  straightM: number,
  depthM: number,
  inwardBiasM: number,
  tW: [number, number, number],
  tH: [number, number, number],
  n: [number, number, number],
  rimCenter: [number, number, number],
): THREE.BufferGeometry {
  const shape = buildStadiumShape(widthM, straightM);

  const geo = new THREE.ExtrudeGeometry(shape, {
    depth: depthM,
    bevelEnabled: false,
    steps: 1,
  });
  geo.translate(0, 0, -inwardBiasM);

  applyClosureBasisToGeometry(geo, tW, tH, n, rimCenter);
  return geo;
}

/** Debug: 3D outline of the stadium cutter profile in world space (for wireframe overlay). */
export function getClosureCutterOutline(
  sk: BuiltSkeleton,
): [number, number, number][] {
  const { tW, tH, rimAnchor } = getBackClosureOpeningFrame(sk);
  const w = BACK_CLOSURE_WIDTH_M + BACK_CLOSURE_TAPE_MARGIN_M;
  const s = BACK_CLOSURE_STRAIGHT_EDGE_M + BACK_CLOSURE_TAPE_MARGIN_M;
  const shape = buildStadiumShape(w, s);
  const pts2d = shape.getPoints(64);
  return pts2d.map((v) => {
    const lx = v.x;
    const ly = v.y;
    return [
      rimAnchor[0] + lx * tW[0] + ly * tH[0],
      rimAnchor[1] + lx * tW[1] + ly * tH[1],
      rimAnchor[2] + lx * tW[2] + ly * tH[2],
    ] as [number, number, number];
  });
}

/**
 * Hollow cut at the rear seam: crown is an open shell — use HOLLOW_SUBTRACTION (not SUBTRACTION)
 * to avoid spurious internal geometry. Cutter is a thin prism (flat bottom, straight sides, arc top).
 */
export function subtractBackClosureFromCrown(
  crownGeometry: THREE.BufferGeometry,
  sk: BuiltSkeleton,
): THREE.BufferGeometry {
  const { tW, tH, n, rimAnchor } = getBackClosureOpeningFrame(sk);

  const cutterGeo = buildClosureCutterGeometry(
    BACK_CLOSURE_WIDTH_M + BACK_CLOSURE_TAPE_MARGIN_M,
    BACK_CLOSURE_STRAIGHT_EDGE_M + BACK_CLOSURE_TAPE_MARGIN_M,
    CLOSURE_CUT_DEPTH_M,
    CLOSURE_CUT_INWARD_BIAS_M,
    tW,
    tH,
    n,
    rimAnchor,
  );

  const result = hollowSubtract(crownGeometry, cutterGeo);
  cutterGeo.dispose();
  return result;
}

/**
 * Apply back-closure CSG to per-panel geometries. Only the two panels adjacent to the
 * rear seam are cut; the rest are returned unchanged.
 */
export function subtractBackClosureFromPanels(
  panelGeos: THREE.BufferGeometry[],
  sk: BuiltSkeleton,
): THREE.BufferGeometry[] {
  const { tW, tH, n, rimAnchor } = getBackClosureOpeningFrame(sk);

  const cutterGeo = buildClosureCutterGeometry(
    BACK_CLOSURE_WIDTH_M + BACK_CLOSURE_TAPE_MARGIN_M,
    BACK_CLOSURE_STRAIGHT_EDGE_M + BACK_CLOSURE_TAPE_MARGIN_M,
    CLOSURE_CUT_DEPTH_M,
    CLOSURE_CUT_INWARD_BIAS_M,
    tW,
    tH,
    n,
    rimAnchor,
  );

  const nSeams = sk.spec.nSeams;
  const rearIdx = rearCenterSeamIndex(nSeams);
  const leftPanel = (rearIdx - 1 + nSeams) % nSeams;
  const rightPanel = rearIdx % nSeams;

  const result = panelGeos.map((geo, i) => {
    if (i !== leftPanel && i !== rightPanel) return geo;
    const cut = hollowSubtract(geo, cutterGeo);
    geo.dispose();
    return cut;
  });

  cutterGeo.dispose();
  return result;
}

function hollowSubtract(
  targetGeo: THREE.BufferGeometry,
  cutterGeo: THREE.BufferGeometry,
): THREE.BufferGeometry {
  const targetClone = targetGeo.clone();
  const merged = mergeVertices(targetClone, 1e-5);
  targetClone.dispose();
  merged.computeVertexNormals();

  const matA = new THREE.MeshStandardMaterial();
  const matB = new THREE.MeshStandardMaterial();
  const targetBrush = new Brush(merged, matA);
  const cutterBrush = new Brush(cutterGeo, matB);

  targetBrush.updateMatrixWorld();
  cutterBrush.updateMatrixWorld();

  const evaluator = new Evaluator();
  evaluator.attributes = ["position", "normal"];
  const out = evaluator.evaluate(targetBrush, cutterBrush, HOLLOW_SUBTRACTION);

  merged.dispose();
  matA.dispose();
  matB.dispose();

  out.geometry.computeVertexNormals();
  return out.geometry;
}
