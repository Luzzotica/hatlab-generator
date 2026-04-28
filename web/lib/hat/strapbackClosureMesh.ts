import * as THREE from "three";
import type { BuiltSkeleton } from "@/lib/skeleton/geometry";
import { sweatbandTangentTheta } from "@/lib/skeleton/geometry";
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
  CLOSURE_TAB_H_M,
  CLOSURE_TAB_INSET_M,
  CLOSURE_TAB_LAYER_GAP_M,
  CLOSURE_TAB_OVERLAP_FRAC,
  crownMeridianPointAtKBridged,
  seamBridgeForTab,
} from "@/lib/hat/closureTabMesh";
import { computeRearClosureRimThetaRange } from "@/lib/hat/rearClosureLayout";
import { offsetInwardXY } from "@/lib/mesh/sweatbandMesh";
import { BASE_THREAD_Z_OFFSET_M } from "@/lib/hat/threadingMesh";

const TAB_DEPTH_M = CLOSURE_TAB_DEPTH_M;
const TAB_LAYER_GAP_M = CLOSURE_TAB_LAYER_GAP_M;
const BACK_TAB_RADIAL_NUDGE_M = CLOSURE_BACK_TAB_RADIAL_NUDGE_M;
const TAB_OVERLAP_FRAC = CLOSURE_TAB_OVERLAP_FRAC;
const CLOSURE_INSET_M = CLOSURE_TAB_INSET_M;
const TAB_FREE_END_INSET_M = CLOSURE_TAB_FREE_END_INSET_M;
const ARC_SEGMENTS = CLOSURE_TAB_ARC_SEGMENTS;

/** Extra arc (rad) past the usual right-rail end so the strap runs farther along the rim. */
const STRAPBACK_EXTRA_RIGHT_RAD = 0.13;
/**
 * On the extended segment only (past {@link a1}): reduce inward inset so the tail rides on the
 * outside of the crown shell (positive = more offset outward from the inner surface).
 */
const STRAPBACK_OUTWARD_EXTEND_M = 0.0048;
/** Minimum inset (m) so vertices do not blow past the outer shell. */
const STRAPBACK_MIN_INSET_M = 0.00012;

/** Torus major/minor radii for the entry clip (wraps the strap cross-section). */
const STRAPBACK_CLIP_TORUS_R_MAJOR = 0.0068;
const STRAPBACK_CLIP_TORUS_R_MINOR = 0.0011;
const STRAPBACK_CLIP_OUTWARD_NUDGE_M = 0.00055;

const TAB_RENDER_ORDER = 4;
const CLIP_RENDER_ORDER = 6;

function strapbackTabMaterial(): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({
    color: 0x7d8088,
    flatShading: false,
    side: THREE.DoubleSide,
    metalness: 0.04,
    roughness: 0.9,
  });
}

function clipMaterial(): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({
    color: 0xa8acb5,
    flatShading: false,
    side: THREE.DoubleSide,
    metalness: 0.35,
    roughness: 0.42,
  });
}

function smoothstep01(t: number): number {
  const x = THREE.MathUtils.clamp(t, 0, 1);
  return x * x * (3 - 2 * x);
}

/**
 * Two stacked straps; the front strap extends past the usual rear-arc end. The extension sits
 * slightly outside the crown. A small metal clip wraps the strap at the rim where that extension
 * begins (original rear-arc end {@link a1}).
 */
export function buildStrapbackClosureGroup(sk: BuiltSkeleton): THREE.Group {
  const group = new THREE.Group();
  group.name = "Closure_Strapback";

  if (!sk.spec.backClosureOpening) return group;

  const spec = sk.spec;
  const { a0, a1, center } = computeRearClosureRimThetaRange(sk);

  const span = a1 - a0;
  const overlapRad = span * TAB_OVERLAP_FRAC;
  const backEnd = Math.min(a1, center + overlapRad);
  const frontStart = Math.max(a0, center - overlapRad);

  const a1Ext = a1 + STRAPBACK_EXTRA_RIGHT_RAD;

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

  const frontSpan = a1Ext - frontStart;
  const extLen = a1Ext - a1;

  const frontTabInset = (theta: number): number => {
    if (frontSpan <= 1e-8) return frontInset;
    const u = (theta - frontStart) / frontSpan;
    const w = THREE.MathUtils.smoothstep(u, 0, 1);
    let inset = frontInset + w * (TAB_FREE_END_INSET_M - frontInset);

    if (extLen > 1e-9 && theta > a1 + 1e-12) {
      const uExt = (theta - a1) / extLen;
      const wOut = smoothstep01(uExt);
      inset -= STRAPBACK_OUTWARD_EXTEND_M * wOut;
    }
    return Math.max(STRAPBACK_MIN_INSET_M, inset);
  };

  const seamBridgeBack = seamBridgeForTab(center, a0, backEnd);
  const seamBridgeFront = seamBridgeForTab(center, frontStart, a1Ext);

  const tabOpts = {
    endCapStyle: "roundedRect" as const,
    roundedRectCornerFrac: 0.12,
    tabRimDepthM: 0.0001,
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
  const backTab = new THREE.Mesh(backGeo, strapbackTabMaterial());
  backTab.name = "Closure_Strapback_Tab_Back";
  backTab.renderOrder = TAB_RENDER_ORDER;
  group.add(backTab);

  const frontGeo = buildCrownFollowingTab(
    sk,
    frontStart,
    a1Ext,
    ARC_SEGMENTS,
    frontTabInset,
    true,
    false,
    seamBridgeFront,
    tabOpts,
  );
  const frontTab = new THREE.Mesh(frontGeo, strapbackTabMaterial());
  frontTab.name = "Closure_Strapback_Tab_Front";
  frontTab.renderOrder = TAB_RENDER_ORDER + 1;
  group.add(frontTab);

  // Entry clip: rim point at original rear-arc end (where the outside tail begins).
  const M = crownArcSegments(spec);
  const N = crownVerticalRings(spec);
  const seamBridgeClip = seamBridgeForTab(center, frontStart, a1Ext);
  const kClip = findKRingForDeltaZ(sk, a1, M, N, CLOSURE_TAB_H_M * 0.52);
  const pMer = crownMeridianPointAtKBridged(
    sk,
    a1,
    kClip,
    M,
    N,
    seamBridgeClip,
  );
  const insetClip = frontTabInset(a1);
  let pSurf = offsetInwardXY(pMer, insetClip);
  const rimOut = new THREE.Vector3(pMer[0], pMer[1], 0);
  if (rimOut.lengthSq() > 1e-14) {
    rimOut.normalize();
    pSurf = [
      pSurf[0] + rimOut.x * STRAPBACK_CLIP_OUTWARD_NUDGE_M,
      pSurf[1] + rimOut.y * STRAPBACK_CLIP_OUTWARD_NUDGE_M,
      pSurf[2],
    ];
  }

  const tang = sweatbandTangentTheta(
    a1,
    spec.semiAxisX,
    spec.semiAxisY,
    spec.yawRad,
  );
  const tVec = new THREE.Vector3(tang[0], tang[1], tang[2]).normalize();
  const out = new THREE.Vector3(pMer[0], pMer[1], 0);
  if (out.lengthSq() < 1e-14) out.set(1, 0, 0);
  out.normalize();
  const outInPlane = out
    .clone()
    .sub(tVec.clone().multiplyScalar(out.dot(tVec)));
  if (outInPlane.lengthSq() < 1e-12) {
    outInPlane.copy(new THREE.Vector3(0, 0, 1));
  } else {
    outInPlane.normalize();
  }
  const side = new THREE.Vector3().crossVectors(tVec, outInPlane).normalize();

  const clip = new THREE.Mesh(
    new THREE.TorusGeometry(
      STRAPBACK_CLIP_TORUS_R_MAJOR,
      STRAPBACK_CLIP_TORUS_R_MINOR,
      10,
      28,
    ),
    clipMaterial(),
  );
  clip.name = "Closure_Strapback_EntryClip";
  clip.renderOrder = CLIP_RENDER_ORDER;

  const basis = new THREE.Matrix4();
  // Torus default: ring in local XY, hole axis +Z — map local Z to strap tangent so the clip wraps the strap cross-section.
  basis.makeBasis(outInPlane, side, tVec);
  clip.setRotationFromMatrix(basis);
  clip.position.set(pSurf[0], pSurf[1], pSurf[2]);

  group.add(clip);

  group.position.z = BASE_THREAD_Z_OFFSET_M;

  return group;
}
