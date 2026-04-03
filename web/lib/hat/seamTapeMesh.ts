import * as THREE from "three";
import {
  crossSeamTapeIndices,
  frontCenterSeamIndex,
  rearCenterSeamIndex,
  sampleSeamWireframeTo,
  type BuiltSkeleton,
} from "@/lib/skeleton/geometry";
import type { HatSkeletonSpec } from "@/lib/skeleton/types";
import {
  BACK_CLOSURE_STRAIGHT_EDGE_M,
  BACK_CLOSURE_TAPE_MARGIN_M,
  BACK_CLOSURE_WIDTH_M,
  getBackClosureOpeningFrame,
} from "@/lib/mesh/backClosureSubtract";
import {
  CROWN_SHELL_THICKNESS_M,
  crownArcSegments,
  crownMeridianPointAtK,
  crownVerticalRings,
  findKRingForDeltaZ,
} from "@/lib/mesh/crownMesh";
import { rimWorldXYToSweatbandTheta } from "@/lib/mesh/sweatbandMesh";
import {
  outwardCrownNormalApprox,
  sampleOpenArchPath,
  segmentPolylineExcludingStadium,
  ribbonGeometryOpen,
  type Vec3,
} from "@/lib/hat/curveUtils";

/** Visible tape width (ribbon cross-section). */
export const SEAM_TAPE_WIDTH_M = 0.014;

const SEAM_TAPE_HALF_WIDTH_M = SEAM_TAPE_WIDTH_M * 0.5;

/** Offset along the outward surface normal (clears the shell into the interior). */
const SEAM_TAPE_NORMAL_OFFSET_M = CROWN_SHELL_THICKNESS_M + 0.0007;

/** Additional radial XY pull (prevents ribbon edges from poking through near the apex). */
const SEAM_TAPE_RADIAL_OFFSET_M = 0.0005;

/** Extra pull at the rim (sweatband) anchor: inward in XY toward the crown axis (0 = no skew vs seam). */
const SEAM_TAPE_ANCHOR_BASE_INWARD_M = 0;

/** Move the crown end of the tape slightly down along the seam (toward the rim). */
const SEAM_TAPE_ANCHOR_TOP_ALONG_SEAM_M = 0.0005;

/** Rear seam tape only: run closer to the button (user asked not to shorten this further). */
const SEAM_TAPE_U_MAX_REAR = 0.97;

/** Front center seam tape: same u-range as rear. */
const SEAM_TAPE_U_MAX_FRONT = 0.97;

/**
 * Cross / diameter tapes: end a bit lower toward the rim than the rear strip (stays off the button area).
 */
const SEAM_TAPE_U_MAX_CROSS = 0.91;

const SEAM_CURVE_SEGMENTS = 40;

function crownNormalFn(spec: HatSkeletonSpec) {
  return (p: Vec3) => outwardCrownNormalApprox(p, spec);
}

function nudgeBaseInwardXY(
  p: [number, number, number],
  delta: number,
): [number, number, number] {
  const rho = Math.hypot(p[0], p[1]);
  if (rho < 1e-12) return p;
  const s = delta / rho;
  return [p[0] - s * p[0], p[1] - s * p[1], p[2]];
}

/** Rim → top strip: pull rim anchor in; lower the top anchor slightly along the seam. */
function applySeamTapeAnchorsOpenStrip(
  points: [number, number, number][],
): void {
  if (points.length < 2) return;
  points[0] = nudgeBaseInwardXY(points[0]!, SEAM_TAPE_ANCHOR_BASE_INWARD_M);
  const last = points.length - 1;
  const a = points[last]!;
  const prev = points[last - 1]!;
  const dx = prev[0] - a[0];
  const dy = prev[1] - a[1];
  const dz = prev[2] - a[2];
  const L = Math.hypot(dx, dy, dz);
  if (L > 1e-12) {
    const s = SEAM_TAPE_ANCHOR_TOP_ALONG_SEAM_M / L;
    points[last] = [a[0] + s * dx, a[1] + s * dy, a[2] + s * dz];
  }
}

/**
 * Diameter path: both rim ends pulled in; apex (max z) nudged down along the seam toward the rim.
 */
function applySeamTapeAnchorsDiameter(
  points: [number, number, number][],
): void {
  if (points.length < 2) return;
  points[0] = nudgeBaseInwardXY(points[0]!, SEAM_TAPE_ANCHOR_BASE_INWARD_M);
  const last = points.length - 1;
  points[last] = nudgeBaseInwardXY(
    points[last]!,
    SEAM_TAPE_ANCHOR_BASE_INWARD_M,
  );

  let iMax = 0;
  let zMax = points[0]![2];
  for (let i = 1; i < points.length; i++) {
    const z = points[i]![2];
    if (z > zMax) {
      zMax = z;
      iMax = i;
    }
  }
  if (iMax <= 0 || iMax >= points.length - 1) return;
  const p = points[iMax]!;
  const left = points[iMax - 1]!;
  const right = points[iMax + 1]!;
  const d = SEAM_TAPE_ANCHOR_TOP_ALONG_SEAM_M;
  if (left[2] < p[2]) {
    const dx = left[0] - p[0];
    const dy = left[1] - p[1];
    const dz = left[2] - p[2];
    const L = Math.hypot(dx, dy, dz);
    if (L > 1e-12) {
      const s = d / L;
      points[iMax] = [p[0] + s * dx, p[1] + s * dy, p[2] + s * dz];
    }
  } else if (right[2] < p[2]) {
    const dx = right[0] - p[0];
    const dy = right[1] - p[1];
    const dz = right[2] - p[2];
    const L = Math.hypot(dx, dy, dz);
    if (L > 1e-12) {
      const s = d / L;
      points[iMax] = [p[0] + s * dx, p[1] + s * dy, p[2] + s * dz];
    }
  }
}

/**
 * Push tape inside the crown shell: first along the outward surface normal (clears the
 * shell at any elevation), then radially in XY (extra margin so ribbon edges don't
 * protrude near the apex where the surface is nearly horizontal).
 */
function offsetSeamTapeAlongSurface(
  p: [number, number, number],
  spec: HatSkeletonSpec,
): [number, number, number] {
  const n = outwardCrownNormalApprox(p, spec);
  let x = p[0] - n[0] * SEAM_TAPE_NORMAL_OFFSET_M;
  let y = p[1] - n[1] * SEAM_TAPE_NORMAL_OFFSET_M;
  const z = p[2] - n[2] * SEAM_TAPE_NORMAL_OFFSET_M;
  const rho = Math.hypot(x, y);
  if (rho > 1e-12) {
    const s = SEAM_TAPE_RADIAL_OFFSET_M / rho;
    x -= x * s;
    y -= y * s;
  }
  return [x, y, z];
}

/**
 * Arch closure ribbon: samples the outer tape boundary as an open arch (no bottom bar),
 * projects each point onto the crown surface, then builds a uniform-width ribbon using
 * ribbonGeometryOpen (which computes perpendicular offsets in the surface tangent plane).
 */
function buildArchClosureRibbonGeometry(
  sk: BuiltSkeleton,
): THREE.BufferGeometry {
  const { tW, tH, n, rimAnchor } = getBackClosureOpeningFrame(sk);
  const outerW = BACK_CLOSURE_WIDTH_M + BACK_CLOSURE_TAPE_MARGIN_M;
  const outerS = BACK_CLOSURE_STRAIGHT_EDGE_M + BACK_CLOSURE_TAPE_MARGIN_M;

  // Offset the arch centerline one tape half-width outside the cutter so
  // the ribbon's inner edge aligns with the cutout boundary.
  // For a semicircular stadium the parallel offset is another semicircular
  // stadium with R' = R + d and the same straight-section height:
  //   R = H/2 + W²/(8H)   (general circular arch)
  //   semicircle ⇒ H = R = W/2, offset d ⇒ R' = W/2 + d, H' = R'
  const d = SEAM_TAPE_WIDTH_M * 1.2;
  const archHalfW = outerW * 0.5 + d;
  const archRise = outerW * 0.5 + SEAM_TAPE_HALF_WIDTH_M;
  const archStraight = outerS;

  const archPts2D = sampleOpenArchPath(archHalfW, archStraight, 56, archRise);

  const M = crownArcSegments(sk.spec);
  const N = crownVerticalRings(sk.spec);

  function projectToCrown(lx: number, ly: number): [number, number, number] {
    const wx = rimAnchor[0] + lx * tW[0] + ly * tH[0];
    const wy = rimAnchor[1] + lx * tW[1] + ly * tH[1];
    const wz = rimAnchor[2] + lx * tW[2] + ly * tH[2];
    const theta = rimWorldXYToSweatbandTheta(sk.spec, wx, wy);
    const deltaZ = Math.max(wz, 0);
    const k = findKRingForDeltaZ(sk, theta, M, N, deltaZ);
    const cp = crownMeridianPointAtK(sk, theta, k, M, N);
    return offsetSeamTapeAlongSurface(cp, sk.spec);
  }

  const centerline = archPts2D.map(([lx, ly]) => projectToCrown(lx, ly));
  const geo = ribbonGeometryOpen(centerline, SEAM_TAPE_HALF_WIDTH_M, crownNormalFn(sk.spec));

  const pos = geo.getAttribute("position") as THREE.BufferAttribute;
  if (pos) {
    const arr = pos.array as Float32Array;
    for (let i = 2; i < arr.length; i += 3) {
      if (arr[i]! < 0) arr[i] = 0;
    }
    pos.needsUpdate = true;
    geo.computeVertexNormals();
  }
  return geo;
}

function seamWireframePointsRaw(
  sk: BuiltSkeleton,
  seamIdx: number,
  segments: number,
  uMax: number,
): [number, number, number][] {
  return sampleSeamWireframeTo(sk.seamControls[seamIdx]!, segments, uMax).map(
    (p) => offsetSeamTapeAlongSurface(p, sk.spec),
  );
}

function seamWireframeOffset(
  sk: BuiltSkeleton,
  seamIdx: number,
  segments: number,
): [number, number, number][] {
  const pts = seamWireframePointsRaw(
    sk,
    seamIdx,
    segments,
    SEAM_TAPE_U_MAX_CROSS,
  );
  applySeamTapeAnchorsOpenStrip(pts);
  return pts;
}

/** True when seam b is opposite seam a on an even panel count (e.g. 6-panel: i and i+3). */
function isOppositeSeamPair(nSeams: number, a: number, b: number): boolean {
  if (nSeams < 2 || nSeams % 2 !== 0) return false;
  return (a + nSeams / 2) % nSeams === b;
}

/**
 * One continuous polyline: seam a (rim→apex) then seam b reversed (apex→rim), matching the blue seam lines.
 * Apex points are de-duplicated when they coincide.
 */
function joinOppositeSeamDiameter(
  sk: BuiltSkeleton,
  a: number,
  b: number,
  segments: number,
): [number, number, number][] {
  const stripA = seamWireframePointsRaw(sk, a, segments, SEAM_TAPE_U_MAX_CROSS);
  const stripB = seamWireframePointsRaw(sk, b, segments, SEAM_TAPE_U_MAX_CROSS);
  if (stripA.length < 2 || stripB.length < 2) return stripA;
  const apexA = stripA[stripA.length - 1]!;
  const apexB = stripB[stripB.length - 1]!;
  const dApex = Math.hypot(
    apexA[0] - apexB[0],
    apexA[1] - apexB[1],
    apexA[2] - apexB[2],
  );
  const rb = stripB.slice().reverse();
  const skipFirst = dApex < 2e-3 ? 1 : 0;
  const joined = [...stripA, ...rb.slice(skipFirst)];
  applySeamTapeAnchorsDiameter(joined);
  return joined;
}

/**
 * Cross tape for one pair: on 6-panel, opposite seams form a full diameter (rim–apex–rim) on the same lines as the viewer.
 * On 5-panel, seams are not opposite — two separate ribbons, one per seam curve.
 */
function crossTapePolylinesForPair(
  sk: BuiltSkeleton,
  a: number,
  b: number,
  segments: number,
): [number, number, number][][] {
  if (isOppositeSeamPair(sk.spec.nSeams, a, b)) {
    return [joinOppositeSeamDiameter(sk, a, b, segments)];
  }
  return [
    seamWireframeOffset(sk, a, segments),
    seamWireframeOffset(sk, b, segments),
  ];
}

/**
 * Interior seam tape: rear seam (split around closure), two cross diameters on seam lines, optional arch annulus.
 */
export function buildSeamTapeGroup(sk: BuiltSkeleton): THREE.Group {
  const group = new THREE.Group();
  group.name = "SeamTape";
  group.renderOrder = 2;

  const mat = new THREE.MeshStandardMaterial({
    color: 0x39ff14,
    flatShading: true,
    side: THREE.DoubleSide,
    metalness: 0.05,
    roughness: 0.9,
    polygonOffset: true,
    polygonOffsetFactor: 1,
    polygonOffsetUnits: 1,
    depthWrite: true,
  });

  const rearIdx = rearCenterSeamIndex(sk.spec.nSeams);
  const rearRaw = sampleSeamWireframeTo(
    sk.seamControls[rearIdx]!,
    SEAM_CURVE_SEGMENTS,
    SEAM_TAPE_U_MAX_REAR,
  ).map((p) => offsetSeamTapeAlongSurface(p, sk.spec));
  applySeamTapeAnchorsOpenStrip(rearRaw);

  if (sk.spec.backClosureOpening) {
    const frame = getBackClosureOpeningFrame(sk);
    const clipW =
      BACK_CLOSURE_WIDTH_M + BACK_CLOSURE_TAPE_MARGIN_M + SEAM_TAPE_WIDTH_M;
    const clipS = BACK_CLOSURE_STRAIGHT_EDGE_M + BACK_CLOSURE_TAPE_MARGIN_M;
    const segments = segmentPolylineExcludingStadium(
      rearRaw,
      frame.rimAnchor,
      frame.tW,
      frame.tH,
      clipW,
      clipS,
    );
    let i = 0;
    for (const seg of segments) {
      const g = ribbonGeometryOpen(seg, SEAM_TAPE_HALF_WIDTH_M, crownNormalFn(sk.spec));
      const m = new THREE.Mesh(g, mat);
      m.name = `Tape_Rear_${i++}`;
      group.add(m);
    }
  } else {
    const rearGeo = ribbonGeometryOpen(
      rearRaw,
      SEAM_TAPE_HALF_WIDTH_M,
      crownNormalFn(sk.spec),
    );
    const rearMesh = new THREE.Mesh(rearGeo, mat);
    rearMesh.name = "Tape_Rear";
    group.add(rearMesh);
  }

  // Front center seam tape — only in 6-panel mode (full front seam)
  if (sk.spec.fivePanelCenterSeamLength >= 1) {
    const frontIdx = frontCenterSeamIndex(sk.spec.nSeams);
    const frontRaw = sampleSeamWireframeTo(
      sk.seamControls[frontIdx]!,
      SEAM_CURVE_SEGMENTS,
      SEAM_TAPE_U_MAX_FRONT,
    ).map((p) => offsetSeamTapeAlongSurface(p, sk.spec));
    applySeamTapeAnchorsOpenStrip(frontRaw);
    const frontGeo = ribbonGeometryOpen(
      frontRaw,
      SEAM_TAPE_HALF_WIDTH_M,
      crownNormalFn(sk.spec),
    );
    const frontMesh = new THREE.Mesh(frontGeo, mat);
    frontMesh.name = "Tape_Front";
    group.add(frontMesh);
  }

  const [[a0, b0], [a1, b1]] = crossSeamTapeIndices(sk.spec.nSeams);
  const paths0 = crossTapePolylinesForPair(sk, a0, b0, SEAM_CURVE_SEGMENTS);
  for (let k = 0; k < paths0.length; k++) {
    const meshCross0 = new THREE.Mesh(
      ribbonGeometryOpen(paths0[k]!, SEAM_TAPE_HALF_WIDTH_M, crownNormalFn(sk.spec)),
      mat,
    );
    meshCross0.name =
      paths0.length > 1
        ? `Tape_Cross_BL_FR_seam_${k === 0 ? a0 : b0}`
        : "Tape_Cross_BL_FR";
    group.add(meshCross0);
  }

  const paths1 = crossTapePolylinesForPair(sk, a1, b1, SEAM_CURVE_SEGMENTS);
  for (let k = 0; k < paths1.length; k++) {
    const meshCross1 = new THREE.Mesh(
      ribbonGeometryOpen(paths1[k]!, SEAM_TAPE_HALF_WIDTH_M, crownNormalFn(sk.spec)),
      mat,
    );
    meshCross1.name =
      paths1.length > 1
        ? `Tape_Cross_BR_FL_seam_${k === 0 ? a1 : b1}`
        : "Tape_Cross_BR_FL";
    group.add(meshCross1);
  }

  if (sk.spec.backClosureOpening) {
    const archGeo = buildArchClosureRibbonGeometry(sk);
    const archMesh = new THREE.Mesh(archGeo, mat);
    archMesh.name = "Tape_ArchClosure";
    archMesh.renderOrder = 1;
    group.add(archMesh);
  }

  return group;
}
