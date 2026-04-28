import * as THREE from "three";
import type { BuiltSkeleton } from "@/lib/skeleton/geometry";
import {
  buildCrownFollowingTab,
  CLOSURE_BACK_TAB_RADIAL_NUDGE_M,
  CLOSURE_TAB_ARC_SEGMENTS,
  CLOSURE_TAB_DEPTH_M,
  CLOSURE_TAB_FREE_END_INSET_M,
  CLOSURE_TAB_INSET_M,
  CLOSURE_TAB_LAYER_GAP_M,
  CLOSURE_TAB_OVERLAP_FRAC,
  seamBridgeForTab,
} from "@/lib/hat/closureTabMesh";
import { computeRearClosureRimThetaRange } from "@/lib/hat/rearClosureLayout";
import { BASE_THREAD_Z_OFFSET_M } from "@/lib/hat/threadingMesh";

const TAB_DEPTH_M = CLOSURE_TAB_DEPTH_M;
const TAB_LAYER_GAP_M = CLOSURE_TAB_LAYER_GAP_M;
const BACK_TAB_RADIAL_NUDGE_M = CLOSURE_BACK_TAB_RADIAL_NUDGE_M;
const TAB_OVERLAP_FRAC = CLOSURE_TAB_OVERLAP_FRAC;
const CLOSURE_INSET_M = CLOSURE_TAB_INSET_M;
const TAB_FREE_END_INSET_M = CLOSURE_TAB_FREE_END_INSET_M;
const ARC_SEGMENTS = CLOSURE_TAB_ARC_SEGMENTS;

/** Light edge roll without the deep snapback groove; keeps the strap reading as flat fabric. */
const VELCRO_TAB_EDGE_ROLL_M = 0.00009;

const TAB_RENDER_ORDER = 4;

function velcroTabMaterial(): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({
    color: 0x898c94,
    flatShading: false,
    side: THREE.DoubleSide,
    metalness: 0.03,
    roughness: 0.92,
  });
}

/**
 * Stacked rear straps like the snapback, but semicircular ends are replaced by slightly filleted
 * rectangles, there are no snaps, and the surface stays mostly flat with a light rolled edge.
 */
export function buildVelcroClosureGroup(sk: BuiltSkeleton): THREE.Group {
  const group = new THREE.Group();
  group.name = "Closure_Velcro";

  if (!sk.spec.backClosureOpening) return group;

  const { a0, a1, center } = computeRearClosureRimThetaRange(sk);

  const span = a1 - a0;
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

  const seamBridgeBack = seamBridgeForTab(center, a0, backEnd);
  const seamBridgeFront = seamBridgeForTab(center, frontStart, a1);

  const tabOpts = {
    endCapStyle: "roundedRect" as const,
    roundedRectCornerFrac: 0.13,
    tabRimDepthM: VELCRO_TAB_EDGE_ROLL_M,
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
  const backTab = new THREE.Mesh(backGeo, velcroTabMaterial());
  backTab.name = "Closure_Velcro_Tab_Back";
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
  const frontTab = new THREE.Mesh(frontGeo, velcroTabMaterial());
  frontTab.name = "Closure_Velcro_Tab_Front";
  frontTab.renderOrder = TAB_RENDER_ORDER + 1;
  group.add(frontTab);

  group.position.z = BASE_THREAD_Z_OFFSET_M;

  return group;
}
