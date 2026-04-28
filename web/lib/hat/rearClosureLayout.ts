import type { BuiltSkeleton } from "@/lib/skeleton/geometry";
import {
  BACK_CLOSURE_TAPE_MARGIN_M,
  BACK_CLOSURE_WIDTH_M,
  getBackClosureOpeningFrame,
} from "@/lib/mesh/backClosureSubtract";
import { CLOSURE_EXTEND_RIM_M } from "@/lib/hat/closureTabMesh";
import {
  rimWorldXYToSweatbandTheta,
  sweatbandRearArcStartAndSpan,
} from "@/lib/mesh/sweatbandMesh";

export type RearClosureRimThetaRange = {
  thetaL: number;
  thetaR: number;
  rear: { start: number; span: number };
  a0: number;
  a1: number;
  center: number;
  avgR: number;
};

/**
 * Sweatband rim theta range for the rear closure rail (left/right rail) and extended arc
 * (same as {@link buildVelcroClosureGroup} / snapback tab placement).
 */
export function computeRearClosureRimThetaRange(
  sk: BuiltSkeleton,
): RearClosureRimThetaRange {
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
  const dThetaExt = CLOSURE_EXTEND_RIM_M / Math.max(avgR, 1e-6);
  const a0 = rear.start - dThetaExt;
  const a1 = rear.start + rear.span + dThetaExt;
  const span = a1 - a0;
  const center = a0 + span * 0.5;

  return { thetaL, thetaR, rear, a0, a1, center, avgR };
}
