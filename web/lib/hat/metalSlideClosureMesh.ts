import * as THREE from "three";
import type { BuiltSkeleton } from "@/lib/skeleton/geometry";
import { sweatbandPoint, sweatbandTangentTheta } from "@/lib/skeleton/geometry";
import {
  crownArcSegments,
  crownVerticalRings,
  findKRingForDeltaZ,
} from "@/lib/mesh/crownMesh";
import {
  buildCrownFollowingTab,
  CLOSURE_BACK_TAB_RADIAL_NUDGE_M,
  CLOSURE_TAB_ARC_SEGMENTS,
  CLOSURE_TAB_DEPTH_M,
  CLOSURE_TAB_FREE_END_INSET_M,
  CLOSURE_TAB_INSET_M,
  CLOSURE_TAB_LAYER_GAP_M,
  crownMeridianPointAtKBridged,
  seamBridgeForTab,
} from "@/lib/hat/closureTabMesh";
import { computeRearClosureRimThetaRange } from "@/lib/hat/rearClosureLayout";
import { offsetInwardXY } from "@/lib/mesh/sweatbandMesh";
import { BASE_THREAD_Z_OFFSET_M } from "@/lib/hat/threadingMesh";

const TAB_DEPTH_M = CLOSURE_TAB_DEPTH_M;
const TAB_LAYER_GAP_M = CLOSURE_TAB_LAYER_GAP_M;
const BACK_TAB_RADIAL_NUDGE_M = CLOSURE_BACK_TAB_RADIAL_NUDGE_M;
const CLOSURE_INSET_M = CLOSURE_TAB_INSET_M;
const TAB_FREE_END_INSET_M = CLOSURE_TAB_FREE_END_INSET_M;
const ARC_SEGMENTS = CLOSURE_TAB_ARC_SEGMENTS;

/** Narrow overlap at the slide so two strap segments meet at the adjuster. */
const METAL_SLIDE_OVERLAP_FRAC = 0.045;

const TAB_RENDER_ORDER = 4;
const SLIDE_RENDER_ORDER = 6;

function fabricMat(): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({
    color: 0x85888f,
    flatShading: false,
    side: THREE.DoubleSide,
    metalness: 0.05,
    roughness: 0.88,
  });
}

function metalMat(): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({
    color: 0xc0c4cc,
    flatShading: false,
    side: THREE.DoubleSide,
    metalness: 0.55,
    roughness: 0.35,
  });
}

/**
 * Two fabric straps meeting at a rear tri-glide style metal slide (simplified box geometry).
 */
export function buildMetalSlideClosureGroup(sk: BuiltSkeleton): THREE.Group {
  const group = new THREE.Group();
  group.name = "Closure_MetalSlide";

  if (!sk.spec.backClosureOpening) return group;

  const spec = sk.spec;
  const { a0, a1, center } = computeRearClosureRimThetaRange(sk);

  const span = a1 - a0;
  const overlapRad = span * METAL_SLIDE_OVERLAP_FRAC;
  const leftEnd = center - overlapRad;
  const rightStart = center + overlapRad;

  const backInset = CLOSURE_INSET_M + BACK_TAB_RADIAL_NUDGE_M;
  const frontInset = backInset + TAB_DEPTH_M + TAB_LAYER_GAP_M;

  const seamBridgeLeft = seamBridgeForTab(center, a0, leftEnd);
  const seamBridgeRight = seamBridgeForTab(center, rightStart, a1);

  const tabOpts = {
    endCapStyle: "roundedRect" as const,
    roundedRectCornerFrac: 0.11,
    tabRimDepthM: 0.00008,
  };

  const leftTabInset =
    leftEnd - a0 > 1e-8
      ? (theta: number) => {
          if (theta >= leftEnd - 1e-9) return backInset;
          const t = (theta - a0) / (leftEnd - a0);
          const w = THREE.MathUtils.smoothstep(t, 0, 1);
          return TAB_FREE_END_INSET_M + w * (backInset - TAB_FREE_END_INSET_M);
        }
      : backInset;

  const rightTabInset =
    a1 - rightStart > 1e-8
      ? (theta: number) => {
          if (theta <= rightStart + 1e-9) return frontInset;
          const t = (theta - rightStart) / (a1 - rightStart);
          const w = THREE.MathUtils.smoothstep(t, 0, 1);
          return frontInset + w * (TAB_FREE_END_INSET_M - frontInset);
        }
      : frontInset;

  const leftGeo = buildCrownFollowingTab(
    sk,
    a0,
    leftEnd,
    ARC_SEGMENTS,
    leftTabInset,
    false,
    true,
    seamBridgeLeft,
    tabOpts,
  );
  const leftTab = new THREE.Mesh(leftGeo, fabricMat());
  leftTab.name = "Closure_MetalSlide_Tab_Left";
  leftTab.renderOrder = TAB_RENDER_ORDER;
  group.add(leftTab);

  const rightGeo = buildCrownFollowingTab(
    sk,
    rightStart,
    a1,
    ARC_SEGMENTS,
    rightTabInset,
    true,
    false,
    seamBridgeRight,
    tabOpts,
  );
  const rightTab = new THREE.Mesh(rightGeo, fabricMat());
  rightTab.name = "Closure_MetalSlide_Tab_Right";
  rightTab.renderOrder = TAB_RENDER_ORDER + 1;
  group.add(rightTab);

  const M = crownArcSegments(spec);
  const N = crownVerticalRings(spec);
  const seamBridgeSlide = seamBridgeForTab(center, leftEnd, rightStart);
  const kMid = findKRingForDeltaZ(sk, center, M, N, 0.012);
  const pMer = crownMeridianPointAtKBridged(
    sk,
    center,
    kMid,
    M,
    N,
    seamBridgeSlide,
  );
  const pRim = sweatbandPoint(
    center,
    spec.semiAxisX,
    spec.semiAxisY,
    spec.yawRad,
  );
  const outward = new THREE.Vector3(pRim[0], pRim[1], 0);
  if (outward.lengthSq() < 1e-14) outward.set(1, 0, 0);
  outward.normalize();

  const pSurf = offsetInwardXY(pMer, CLOSURE_TAB_INSET_M - 0.0009);

  const tang = sweatbandTangentTheta(
    center,
    spec.semiAxisX,
    spec.semiAxisY,
    spec.yawRad,
  );
  const tVec = new THREE.Vector3(tang[0], tang[1], tang[2]).normalize();
  const up = new THREE.Vector3(0, 0, 1);

  const slide = new THREE.Group();
  slide.name = "Closure_MetalSlide_Adjuster";

  const frameW = 0.019;
  const frameH = 0.0065;
  const frameD = 0.0028;
  const frame = new THREE.Mesh(
    new THREE.BoxGeometry(frameW, frameH, frameD),
    metalMat(),
  );
  frame.name = "Closure_MetalSlide_Frame";
  frame.renderOrder = SLIDE_RENDER_ORDER;

  const barW = frameW * 0.92;
  const barH = 0.0014;
  const bar = new THREE.Mesh(
    new THREE.BoxGeometry(barW, barH, frameD * 1.05),
    metalMat(),
  );
  bar.name = "Closure_MetalSlide_Bar";
  bar.renderOrder = SLIDE_RENDER_ORDER;
  bar.position.y = -frameH * 0.15;

  slide.add(frame);
  slide.add(bar);

  const basis = new THREE.Matrix4();
  basis.makeBasis(tVec, outward, up);
  slide.setRotationFromMatrix(basis);
  slide.position.set(pSurf[0], pSurf[1], pSurf[2]);

  group.add(slide);

  group.position.z = BASE_THREAD_Z_OFFSET_M;

  return group;
}
