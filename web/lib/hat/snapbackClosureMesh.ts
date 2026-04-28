import * as THREE from "three";
import type { BuiltSkeleton } from "@/lib/skeleton/geometry";
import { sweatbandPoint, sweatbandTangentTheta } from "@/lib/skeleton/geometry";
import {
  BACK_CLOSURE_TAPE_MARGIN_M,
  BACK_CLOSURE_WIDTH_M,
  getBackClosureOpeningFrame,
} from "@/lib/mesh/backClosureSubtract";
import {
  crownArcSegments,
  crownVerticalRings,
  findKRingForDeltaZ,
} from "@/lib/mesh/crownMesh";
import {
  buildCrownFollowingTab,
  CLOSURE_BACK_TAB_RADIAL_NUDGE_M,
  CLOSURE_EXTEND_RIM_M,
  CLOSURE_TAB_ARC_SEGMENTS,
  CLOSURE_TAB_DEPTH_M,
  CLOSURE_TAB_FREE_END_INSET_M,
  CLOSURE_TAB_H_M,
  CLOSURE_TAB_INSET_M,
  CLOSURE_TAB_LAYER_GAP_M,
  CLOSURE_TAB_OVERLAP_FRAC,
  CLOSURE_TAB_RIM_DEPTH_DEFAULT_M,
  crownMeridianPointAtKBridged,
  seamBridgeForTab,
  type SeamBridgeParams,
} from "@/lib/hat/closureTabMesh";
import {
  offsetInwardXY,
  rimWorldXYToSweatbandTheta,
  sweatbandRearArcStartAndSpan,
} from "@/lib/mesh/sweatbandMesh";
import { BASE_THREAD_Z_OFFSET_M } from "@/lib/hat/threadingMesh";

const TAB_H_M = CLOSURE_TAB_H_M;
const TAB_DEPTH_M = CLOSURE_TAB_DEPTH_M;
const TAB_LAYER_GAP_M = CLOSURE_TAB_LAYER_GAP_M;
const BACK_TAB_RADIAL_NUDGE_M = CLOSURE_BACK_TAB_RADIAL_NUDGE_M;
const TAB_OVERLAP_FRAC = CLOSURE_TAB_OVERLAP_FRAC;
const CLOSURE_INSET_M = CLOSURE_TAB_INSET_M;
const TAB_FREE_END_INSET_M = CLOSURE_TAB_FREE_END_INSET_M;
const SNAP_EQUATOR_R_M = TAB_H_M * 0.11;
const SNAP_FLATTEN_Y = 0.42;
const SNAP_STEM_R_M = SNAP_EQUATOR_R_M * 0.28;
const SNAP_STEM_H_M = 0.00034;
const SNAP_COUNT = 6;
const SNAP_ARCLEN_SAMPLES = 192;
const ARC_SEGMENTS = CLOSURE_TAB_ARC_SEGMENTS;
const CLOSURE_EXTEND_RIM_M_LOCAL = CLOSURE_EXTEND_RIM_M;

const TAB_RENDER_ORDER = 4;
const SNAP_RENDER_ORDER = 5;

function closureTabMaterial(): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({
    color: 0x8e8e8e,
    flatShading: false,
    side: THREE.DoubleSide,
    metalness: 0.08,
    roughness: 0.78,
  });
}

function snapMaterial(): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({
    color: 0xa8a8a8,
    flatShading: false,
    side: THREE.DoubleSide,
    metalness: 0.28,
    roughness: 0.52,
  });
}

function snapThetasEvenArcAlongBackOuter(
  sk: BuiltSkeleton,
  snapA: number,
  snapB: number,
  M: number,
  N: number,
  backInset: number,
  seamBridge: SeamBridgeParams,
  snapCount: number,
): number[] {
  const snapSpan = snapB - snapA;
  if (snapCount <= 0) return [];
  if (snapSpan <= 1e-12) {
    const mid = (snapA + snapB) * 0.5;
    return Array.from({ length: snapCount }, () => mid);
  }

  const n = SNAP_ARCLEN_SAMPLES;
  const pts: [number, number, number][] = [];
  for (let j = 0; j <= n; j++) {
    const theta = snapA + (j / n) * snapSpan;
    const kMid = findKRingForDeltaZ(sk, theta, M, N, TAB_H_M * 0.5);
    const pMid = crownMeridianPointAtKBridged(
      sk,
      theta,
      kMid,
      M,
      N,
      seamBridge,
    );
    pts.push(offsetInwardXY(pMid, backInset));
  }

  const dist: number[] = [0];
  for (let j = 1; j <= n; j++) {
    const a = pts[j - 1]!;
    const b = pts[j]!;
    dist.push(dist[j - 1]! + Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]));
  }
  const total = dist[n]!;
  if (total < 1e-12) {
    return Array.from(
      { length: snapCount },
      (_, k) => snapA + ((k + 0.5) / snapCount) * snapSpan,
    );
  }

  const result: number[] = [];
  for (let k = 0; k < snapCount; k++) {
    const targetS = ((k + 0.5) / snapCount) * total;
    let j = 0;
    while (j < n && dist[j + 1]! < targetS) j++;
    j = Math.min(j, n - 1);
    const d0 = dist[j]!;
    const d1 = dist[j + 1]!;
    const t = d1 > d0 + 1e-12 ? (targetS - d0) / (d1 - d0) : 0;
    const theta = snapA + ((j + t) / n) * snapSpan;
    result.push(theta);
  }
  return result;
}

function createSnapDomeGeometry(): THREE.SphereGeometry {
  const g = new THREE.SphereGeometry(SNAP_EQUATOR_R_M, 16, 12);
  g.scale(1, SNAP_FLATTEN_Y, 1);
  return g;
}

function outwardXY(
  p: readonly [number, number, number],
): [number, number, number] {
  const L = Math.hypot(p[0], p[1]);
  if (L < 1e-12) return [0, 0, 0];
  return [p[0] / L, p[1] / L, 0];
}

export function buildSnapbackClosureGroup(sk: BuiltSkeleton): THREE.Group {
  const group = new THREE.Group();
  group.name = "Closure_Snapback";

  if (!sk.spec.backClosureOpening) return group;

  const spec = sk.spec;
  const { tW, rimAnchor } = getBackClosureOpeningFrame(sk);
  const halfW =
    (BACK_CLOSURE_WIDTH_M + BACK_CLOSURE_TAPE_MARGIN_M) * 0.5 + 0.01;

  const left: [number, number, number] = [
    rimAnchor[0] - halfW * tW[0],
    rimAnchor[1] - halfW * tW[1],
    rimAnchor[2] - halfW * tW[2],
  ];
  const right: [number, number, number] = [
    rimAnchor[0] + halfW * tW[0],
    rimAnchor[1] + halfW * tW[1],
    rimAnchor[2] + halfW * tW[2],
  ];

  const thetaL = rimWorldXYToSweatbandTheta(spec, left[0], left[1]);
  const thetaR = rimWorldXYToSweatbandTheta(spec, right[0], right[1]);
  const rear = sweatbandRearArcStartAndSpan(thetaL, thetaR);

  const avgR = (spec.semiAxisX + spec.semiAxisY) * 0.5;
  const dThetaExt = CLOSURE_EXTEND_RIM_M_LOCAL / Math.max(avgR, 1e-6);
  const a0 = rear.start - dThetaExt;
  const a1 = rear.start + rear.span + dThetaExt;
  const span = a1 - a0;
  const center = a0 + span * 0.5;
  const overlapRad = span * TAB_OVERLAP_FRAC;
  const backEnd = Math.min(a1, center + overlapRad);
  const frontStart = Math.max(a0, center - overlapRad);

  const backInset = CLOSURE_INSET_M + BACK_TAB_RADIAL_NUDGE_M;
  const frontInset = backInset + TAB_DEPTH_M + TAB_LAYER_GAP_M;

  const backTabInset =
    frontStart - a0 > 1e-8
      ? (theta: number) => {
          if (theta >= frontStart) return backInset;
          const t = (theta - a0) / (frontStart - a0);
          const w = THREE.MathUtils.smoothstep(t, 0, 1);
          return TAB_FREE_END_INSET_M + w * (backInset - TAB_FREE_END_INSET_M);
        }
      : backInset;

  const frontTabInset =
    a1 - backEnd > 1e-8
      ? (theta: number) => {
          if (theta <= backEnd) return frontInset;
          const t = (theta - backEnd) / (a1 - backEnd);
          const w = THREE.MathUtils.smoothstep(t, 0, 1);
          return frontInset + w * (TAB_FREE_END_INSET_M - frontInset);
        }
      : frontInset;

  const snapA = Math.max(a0, frontStart);
  const snapB = Math.min(backEnd, a1);

  const seamBridgeBack = seamBridgeForTab(center, a0, backEnd);
  const seamBridgeFront = seamBridgeForTab(center, frontStart, a1);
  const seamBridgeSnaps = seamBridgeForTab(center, snapA, snapB);

  const tabOpts = {
    endCapStyle: "semicircle" as const,
    tabRimDepthM: CLOSURE_TAB_RIM_DEPTH_DEFAULT_M,
  };

  const backGeo = buildCrownFollowingTab(
    sk,
    a0,
    backEnd,
    ARC_SEGMENTS,
    backTabInset,
    false,
    true,
    seamBridgeBack,
    tabOpts,
  );
  const backTab = new THREE.Mesh(backGeo, closureTabMaterial());
  backTab.name = "Closure_Snapback_Tab_Back";
  backTab.renderOrder = TAB_RENDER_ORDER;
  group.add(backTab);

  const frontGeo = buildCrownFollowingTab(
    sk,
    frontStart,
    a1,
    ARC_SEGMENTS,
    frontTabInset,
    true,
    false,
    seamBridgeFront,
    tabOpts,
  );
  const frontTab = new THREE.Mesh(frontGeo, closureTabMaterial());
  frontTab.name = "Closure_Snapback_Tab_Front";
  frontTab.renderOrder = TAB_RENDER_ORDER + 1;
  group.add(frontTab);

  const sMat = snapMaterial();
  const sharedStemGeom = new THREE.CylinderGeometry(
    SNAP_STEM_R_M,
    SNAP_STEM_R_M,
    SNAP_STEM_H_M,
    10,
    1,
    false,
  );
  const snapBasis = new THREE.Matrix4();
  const M = crownArcSegments(spec);
  const N = crownVerticalRings(spec);

  const sy = SNAP_FLATTEN_Y;
  const domeCenterYBack = SNAP_STEM_H_M + SNAP_EQUATOR_R_M * sy;
  const domeCenterYFront = -SNAP_EQUATOR_R_M * sy;

  const snapThetas = snapThetasEvenArcAlongBackOuter(
    sk,
    snapA,
    snapB,
    M,
    N,
    backInset,
    seamBridgeSnaps,
    SNAP_COUNT,
  );

  for (let k = 0; k < SNAP_COUNT; k++) {
    const theta = snapThetas[k]!;
    const pRim = sweatbandPoint(
      theta,
      spec.semiAxisX,
      spec.semiAxisY,
      spec.yawRad,
    );
    const out = outwardXY(pRim);
    const kMid = findKRingForDeltaZ(sk, theta, M, N, TAB_H_M * 0.5);
    const pMid = crownMeridianPointAtKBridged(
      sk,
      theta,
      kMid,
      M,
      N,
      seamBridgeSnaps,
    );
    const pBackOuter = offsetInwardXY(pMid, backInset);

    const tang = sweatbandTangentTheta(
      theta,
      spec.semiAxisX,
      spec.semiAxisY,
      spec.yawRad,
    );
    const tangLen = Math.hypot(tang[0], tang[1], tang[2]);
    const tNorm: [number, number, number] =
      tangLen > 1e-12
        ? [tang[0] / tangLen, tang[1] / tangLen, tang[2] / tangLen]
        : [0, 1, 0];
    snapBasis.makeBasis(
      new THREE.Vector3(tNorm[0], tNorm[1], tNorm[2]),
      new THREE.Vector3(out[0], out[1], out[2]),
      new THREE.Vector3(0, 0, 1),
    );

    const backSnap = new THREE.Group();
    backSnap.name = `Closure_Snapback_Snap_Back_${k}`;
    backSnap.renderOrder = SNAP_RENDER_ORDER;
    backSnap.position.set(pBackOuter[0], pBackOuter[1], pBackOuter[2]);
    backSnap.setRotationFromMatrix(snapBasis);

    const stem = new THREE.Mesh(sharedStemGeom, sMat);
    stem.name = `Closure_Snapback_Snap_Back_Stem_${k}`;
    stem.renderOrder = SNAP_RENDER_ORDER;
    stem.position.y = SNAP_STEM_H_M * 0.5;

    const domeGeom = createSnapDomeGeometry();
    const domeBack = new THREE.Mesh(domeGeom, sMat);
    domeBack.name = `Closure_Snapback_Snap_Back_Dome_${k}`;
    domeBack.renderOrder = SNAP_RENDER_ORDER;
    domeBack.position.y = domeCenterYBack;

    backSnap.add(stem);
    backSnap.add(domeBack);
    group.add(backSnap);

    const pFrontOuter = offsetInwardXY(pMid, frontInset);
    const frontSnap = new THREE.Group();
    frontSnap.name = `Closure_Snapback_Snap_Front_${k}`;
    frontSnap.renderOrder = SNAP_RENDER_ORDER;
    frontSnap.position.set(pFrontOuter[0], pFrontOuter[1], pFrontOuter[2]);
    frontSnap.setRotationFromMatrix(snapBasis);

    const domeGeomFront = createSnapDomeGeometry();
    const domeFront = new THREE.Mesh(domeGeomFront, sMat);
    domeFront.name = `Closure_Snapback_Snap_Front_Dome_${k}`;
    domeFront.renderOrder = SNAP_RENDER_ORDER;
    domeFront.position.y = domeCenterYFront;

    frontSnap.add(domeFront);
    group.add(frontSnap);
  }

  group.position.z = BASE_THREAD_Z_OFFSET_M;

  return group;
}
