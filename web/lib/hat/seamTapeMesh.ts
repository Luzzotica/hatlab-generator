import * as THREE from "three";
import {
  crossSeamTapeIndices,
  rearCenterSeamIndex,
  sampleSeamWireframeTo,
  type BuiltSkeleton,
} from "@/lib/skeleton/geometry";
import type { HatSkeletonSpec } from "@/lib/skeleton/types";
import {
  BACK_CLOSURE_STRAIGHT_EDGE_M,
  BACK_CLOSURE_TAPE_MARGIN_M,
  BACK_CLOSURE_WIDTH_M,
  buildStadiumShape,
  getBackClosureOpeningFrame,
} from "@/lib/mesh/backClosureSubtract";

/** Visible tape width (ribbon cross-section). */
export const SEAM_TAPE_WIDTH_M = 0.014;

const SEAM_TAPE_HALF_WIDTH_M = SEAM_TAPE_WIDTH_M * 0.5;

/** Radial pull toward crown axis so tape sits slightly under the inner shell (not visible outside). */
const SEAM_TAPE_INWARD_OFFSET_M = 0.0016;

/** Offset along −n from opening plane for arch tape (kept in step with seam tape). */
const ARCH_TAPE_INWARD_ALONG_N_M = 0.00165;

/** Extra pull at the rim (sweatband) anchor: inward in XY toward the crown axis (0 = no skew vs seam). */
const SEAM_TAPE_ANCHOR_BASE_INWARD_M = 0;

/** Move the crown end of the tape slightly down along the seam (toward the rim). */
const SEAM_TAPE_ANCHOR_TOP_ALONG_SEAM_M = 0.0005;

/** Remove duplicate consecutive samples (e.g. apex join) so tangents stay well-defined. */
const POLY_DEDUPE_EPS_M = 1e-5;

/** Rear seam tape only: run closer to the button (user asked not to shorten this further). */
const SEAM_TAPE_U_MAX_REAR = 0.97;

/**
 * Cross / diameter tapes: end a bit lower toward the rim than the rear strip (stays off the button area).
 */
const SEAM_TAPE_U_MAX_CROSS = 0.91;

const SEAM_CURVE_SEGMENTS = 40;

function dot(
  a: readonly [number, number, number],
  b: readonly [number, number, number]
): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function nudgeBaseInwardXY(p: [number, number, number], delta: number): [number, number, number] {
  const rho = Math.hypot(p[0], p[1]);
  if (rho < 1e-12) return p;
  const s = delta / rho;
  return [p[0] - s * p[0], p[1] - s * p[1], p[2]];
}

/** Rim → top strip: pull rim anchor in; lower the top anchor slightly along the seam. */
function applySeamTapeAnchorsOpenStrip(points: [number, number, number][]): void {
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
function applySeamTapeAnchorsDiameter(points: [number, number, number][]): void {
  if (points.length < 2) return;
  points[0] = nudgeBaseInwardXY(points[0]!, SEAM_TAPE_ANCHOR_BASE_INWARD_M);
  const last = points.length - 1;
  points[last] = nudgeBaseInwardXY(points[last]!, SEAM_TAPE_ANCHOR_BASE_INWARD_M);

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
 * Outward normal of a dome-like ellipsoid (rim ellipse × crown height) — matches crown curvature
 * better than a purely horizontal offset so tape sits in the tangent plane.
 */
function outwardCrownNormalApprox(p: [number, number, number], spec: HatSkeletonSpec): [number, number, number] {
  const [x, y, z] = p;
  const sx = spec.semiAxisX;
  const sy = spec.semiAxisY;
  const H = spec.crownHeight;
  if (H < 1e-10) return [0, 0, 1];
  const gx = x / (sx * sx);
  const gy = y / (sy * sy);
  const gz = z / (H * H);
  return norm3([gx, gy, gz]);
}

/** Move tape slightly into the cavity along −n (outward surface normal). */
function offsetSeamTapeAlongSurface(
  p: [number, number, number],
  spec: HatSkeletonSpec
): [number, number, number] {
  const n = outwardCrownNormalApprox(p, spec);
  const d = SEAM_TAPE_INWARD_OFFSET_M;
  return [p[0] - n[0] * d, p[1] - n[1] * d, p[2] - n[2] * d];
}

/** Filled stadium region in closure local (lw, lh) matching {@link buildStadiumShape}. */
function pointInStadiumLocal(lw: number, lh: number, widthM: number, straightM: number): boolean {
  const halfW = widthM * 0.5;
  const R = halfW;
  const h = straightM;
  const topH = h + R;
  if (lh < -1e-6 || lh > topH + 1e-5) return false;
  if (lh <= h) {
    return Math.abs(lw) <= halfW + 1e-5;
  }
  const dy = lh - h;
  if (dy > R + 1e-5) return false;
  return lw * lw + dy * dy <= R * R + 1e-7;
}

function segmentPolylineExcludingStadium(
  points: [number, number, number][],
  rimAnchor: [number, number, number],
  tW: [number, number, number],
  tH: [number, number, number],
  stadiumW: number,
  stadiumS: number
): [number, number, number][][] {
  const segments: [number, number, number][][] = [];
  let cur: [number, number, number][] = [];
  for (const p of points) {
    const vx = p[0] - rimAnchor[0];
    const vy = p[1] - rimAnchor[1];
    const vz = p[2] - rimAnchor[2];
    const lw = vx * tW[0] + vy * tW[1] + vz * tW[2];
    const lh = vx * tH[0] + vy * tH[1] + vz * tH[2];
    if (pointInStadiumLocal(lw, lh, stadiumW, stadiumS)) {
      if (cur.length >= 2) segments.push(cur);
      cur = [];
    } else {
      cur.push(p);
    }
  }
  if (cur.length >= 2) segments.push(cur);
  return segments;
}

function norm3(v: [number, number, number]): [number, number, number] {
  const L = Math.hypot(v[0], v[1], v[2]);
  if (L < 1e-15) return [0, 0, 1];
  return [v[0] / L, v[1] / L, v[2] / L];
}

function cross3(
  a: [number, number, number],
  b: [number, number, number]
): [number, number, number] {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}

function dedupeConsecutivePoints(
  points: [number, number, number][],
  eps: number
): [number, number, number][] {
  const out: [number, number, number][] = [];
  for (const p of points) {
    if (out.length === 0) {
      out.push(p);
      continue;
    }
    const q = out[out.length - 1]!;
    const d = Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
    if (d > eps) out.push(p);
  }
  return out;
}

/**
 * Flat ribbon in the surface tangent plane: width = tangent × outward normal (continuity via sign flip).
 */
function ribbonGeometryOpen(
  pointsIn: [number, number, number][],
  halfWidth: number,
  spec: HatSkeletonSpec
): THREE.BufferGeometry {
  const points = dedupeConsecutivePoints(pointsIn, POLY_DEDUPE_EPS_M);
  const n = points.length;
  if (n < 2) {
    return new THREE.BufferGeometry();
  }

  const tangents: [number, number, number][] = [];
  for (let i = 0; i < n; i++) {
    const p = points[i]!;
    let t: [number, number, number];
    if (i === 0) {
      t = norm3([
        points[1]![0] - p[0],
        points[1]![1] - p[1],
        points[1]![2] - p[2],
      ]);
    } else if (i === n - 1) {
      t = norm3([
        p[0] - points[i - 1]![0],
        p[1] - points[i - 1]![1],
        p[2] - points[i - 1]![2],
      ]);
    } else {
      const t0 = norm3([
        p[0] - points[i - 1]![0],
        p[1] - points[i - 1]![1],
        p[2] - points[i - 1]![2],
      ]);
      const t1 = norm3([
        points[i + 1]![0] - p[0],
        points[i + 1]![1] - p[1],
        points[i + 1]![2] - p[2],
      ]);
      t = norm3([t0[0] + t1[0], t0[1] + t1[1], t0[2] + t1[2]]);
    }
    tangents.push(t);
  }

  const widths: [number, number, number][] = [];
  for (let i = 0; i < n; i++) {
    const ti = tangents[i]!;
    const ni = outwardCrownNormalApprox(points[i]!, spec);
    let w = cross3(ti, ni);
    let len = Math.hypot(w[0], w[1], w[2]);
    if (len < 1e-10) {
      w = cross3(ti, [0, 0, 1]);
      len = Math.hypot(w[0], w[1], w[2]);
    }
    if (len < 1e-10) {
      w = [1, 0, 0];
    } else {
      w = [w[0] / len, w[1] / len, w[2] / len];
    }
    if (i > 0 && dot(w, widths[i - 1]!) < 0) {
      w = [-w[0], -w[1], -w[2]];
    }
    widths.push(w);
  }

  const positions: number[] = [];
  const indices: number[] = [];
  const hw = halfWidth;
  for (let i = 0; i < n; i++) {
    const p = points[i]!;
    const w = widths[i]!;
    positions.push(
      p[0] + w[0] * hw,
      p[1] + w[1] * hw,
      p[2] + w[2] * hw,
      p[0] - w[0] * hw,
      p[1] - w[1] * hw,
      p[2] - w[2] * hw
    );
  }

  for (let i = 0; i < n - 1; i++) {
    const a = i * 2;
    const b = a + 1;
    const c = a + 2;
    const d = a + 3;
    indices.push(a, b, c, b, d, c);
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geo.setIndex(indices);
  geo.computeVertexNormals();
  return geo;
}

function local2ToWorldOpening(
  v: THREE.Vector2,
  rimAnchor: [number, number, number],
  tW: [number, number, number],
  tH: [number, number, number],
  n: [number, number, number],
  inwardAlongN: number
): [number, number, number] {
  const lx = v.x;
  const ly = v.y;
  return [
    rimAnchor[0] +
      lx * tW[0] +
      ly * tH[0] -
      n[0] * inwardAlongN,
    rimAnchor[1] +
      lx * tW[1] +
      ly * tH[1] -
      n[1] * inwardAlongN,
    rimAnchor[2] +
      lx * tW[2] +
      ly * tH[2] -
      n[2] * inwardAlongN,
  ];
}

/** Flat annulus in the opening plane (outer / inner stadium loops), slightly offset into the crown. */
function buildArchClosureRibbonGeometry(sk: BuiltSkeleton): THREE.BufferGeometry {
  const { tW, tH, n, rimAnchor } = getBackClosureOpeningFrame(sk);
  const outerW = BACK_CLOSURE_WIDTH_M + BACK_CLOSURE_TAPE_MARGIN_M;
  const outerS = BACK_CLOSURE_STRAIGHT_EDGE_M + BACK_CLOSURE_TAPE_MARGIN_M;
  const outerShape = buildStadiumShape(outerW, outerS);
  const innerShape = buildStadiumShape(BACK_CLOSURE_WIDTH_M, BACK_CLOSURE_STRAIGHT_EDGE_M);
  const divisions = 72;
  const outer2 = outerShape.getPoints(divisions);
  const inner2 = innerShape.getPoints(divisions);
  const inward = ARCH_TAPE_INWARD_ALONG_N_M;
  const outer3 = outer2.map((v) => local2ToWorldOpening(v, rimAnchor, tW, tH, n, inward));
  const inner3 = inner2.map((v) => local2ToWorldOpening(v, rimAnchor, tW, tH, n, inward));
  return ribbonAnnulusLoop(outer3, inner3);
}

function ribbonAnnulusLoop(
  outer: [number, number, number][],
  inner: [number, number, number][]
): THREE.BufferGeometry {
  const n = outer.length;
  if (n < 3 || inner.length !== n) {
    return new THREE.BufferGeometry();
  }
  const positions: number[] = [];
  const indices: number[] = [];
  for (let i = 0; i < n; i++) {
    const o = outer[i]!;
    const inn = inner[i]!;
    positions.push(o[0], o[1], o[2], inn[0], inn[1], inn[2]);
  }
  for (let i = 0; i < n; i++) {
    const next = (i + 1) % n;
    const a = i * 2;
    const b = a + 1;
    const c = next * 2;
    const d = c + 1;
    indices.push(a, b, c, b, d, c);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geo.setIndex(indices);
  geo.computeVertexNormals();
  return geo;
}

function seamWireframePointsRaw(
  sk: BuiltSkeleton,
  seamIdx: number,
  segments: number,
  uMax: number
): [number, number, number][] {
  return sampleSeamWireframeTo(sk.seamControls[seamIdx]!, segments, uMax).map((p) =>
    offsetSeamTapeAlongSurface(p, sk.spec)
  );
}

function seamWireframeOffset(
  sk: BuiltSkeleton,
  seamIdx: number,
  segments: number
): [number, number, number][] {
  const pts = seamWireframePointsRaw(sk, seamIdx, segments, SEAM_TAPE_U_MAX_CROSS);
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
  segments: number
): [number, number, number][] {
  const stripA = seamWireframePointsRaw(sk, a, segments, SEAM_TAPE_U_MAX_CROSS);
  const stripB = seamWireframePointsRaw(sk, b, segments, SEAM_TAPE_U_MAX_CROSS);
  if (stripA.length < 2 || stripB.length < 2) return stripA;
  const apexA = stripA[stripA.length - 1]!;
  const apexB = stripB[stripB.length - 1]!;
  const dApex = Math.hypot(apexA[0] - apexB[0], apexA[1] - apexB[1], apexA[2] - apexB[2]);
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
  segments: number
): [number, number, number][][] {
  if (isOppositeSeamPair(sk.spec.nSeams, a, b)) {
    return [joinOppositeSeamDiameter(sk, a, b, segments)];
  }
  return [seamWireframeOffset(sk, a, segments), seamWireframeOffset(sk, b, segments)];
}

/**
 * Interior seam tape: rear seam (split around closure), two cross diameters on seam lines, optional arch annulus.
 */
export function buildSeamTapeGroup(sk: BuiltSkeleton): THREE.Group {
  const group = new THREE.Group();
  group.name = "SeamTape";
  group.renderOrder = 2;

  const mat = new THREE.MeshStandardMaterial({
    color: 0x1f2937,
    flatShading: true,
    side: THREE.DoubleSide,
    metalness: 0.05,
    roughness: 0.9,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
    depthWrite: true,
  });

  const rearIdx = rearCenterSeamIndex(sk.spec.nSeams);
  const rearRaw = sampleSeamWireframeTo(
    sk.seamControls[rearIdx]!,
    SEAM_CURVE_SEGMENTS,
    SEAM_TAPE_U_MAX_REAR
  ).map((p) => offsetSeamTapeAlongSurface(p, sk.spec));
  applySeamTapeAnchorsOpenStrip(rearRaw);

  if (sk.spec.backClosureOpening) {
    const frame = getBackClosureOpeningFrame(sk);
    const segments = segmentPolylineExcludingStadium(
      rearRaw,
      frame.rimAnchor,
      frame.tW,
      frame.tH,
      BACK_CLOSURE_WIDTH_M,
      BACK_CLOSURE_STRAIGHT_EDGE_M
    );
    let i = 0;
    for (const seg of segments) {
      const g = ribbonGeometryOpen(seg, SEAM_TAPE_HALF_WIDTH_M, sk.spec);
      const m = new THREE.Mesh(g, mat);
      m.name = `Tape_Rear_${i++}`;
      group.add(m);
    }
  } else {
    const rearGeo = ribbonGeometryOpen(rearRaw, SEAM_TAPE_HALF_WIDTH_M, sk.spec);
    const rearMesh = new THREE.Mesh(rearGeo, mat);
    rearMesh.name = "Tape_Rear";
    group.add(rearMesh);
  }

  const [[a0, b0], [a1, b1]] = crossSeamTapeIndices(sk.spec.nSeams);
  const paths0 = crossTapePolylinesForPair(sk, a0, b0, SEAM_CURVE_SEGMENTS);
  for (let k = 0; k < paths0.length; k++) {
    const meshCross0 = new THREE.Mesh(
      ribbonGeometryOpen(paths0[k]!, SEAM_TAPE_HALF_WIDTH_M, sk.spec),
      mat
    );
    meshCross0.name = paths0.length > 1 ? `Tape_Cross_BL_FR_seam_${k === 0 ? a0 : b0}` : "Tape_Cross_BL_FR";
    group.add(meshCross0);
  }

  const paths1 = crossTapePolylinesForPair(sk, a1, b1, SEAM_CURVE_SEGMENTS);
  for (let k = 0; k < paths1.length; k++) {
    const meshCross1 = new THREE.Mesh(
      ribbonGeometryOpen(paths1[k]!, SEAM_TAPE_HALF_WIDTH_M, sk.spec),
      mat
    );
    meshCross1.name = paths1.length > 1 ? `Tape_Cross_BR_FL_seam_${k === 0 ? a1 : b1}` : "Tape_Cross_BR_FL";
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
