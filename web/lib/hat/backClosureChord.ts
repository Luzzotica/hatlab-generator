import type { BuiltSkeleton } from "@/lib/skeleton/geometry";
import {
  buildBackClosureCutSpec,
  closureProjectToCrownOpening,
  type BackClosureCutSpec,
} from "@/lib/mesh/crownMesh";
import {
  cross3,
  dot3,
  norm3,
  outwardCrownNormalApprox,
  type Vec3,
} from "@/lib/hat/curveUtils";

export type BackClosureChordFrame = {
  cut: BackClosureCutSpec;
  /** Bottom chord endpoints of the arch on the actual crown surface. */
  left: Vec3;
  right: Vec3;
  /** Top center of the stadium arch on the crown. */
  apex: Vec3;
  /** Midpoint of the bottom chord. */
  mid: Vec3;
  /** Unit along the chord (left → right). */
  tW: Vec3;
  /** Unit toward the arch apex, orthogonal to `tW` in the opening plane. */
  tH: Vec3;
  /** Outward from the crown at `mid`. */
  n: Vec3;
  chordLen: number;
};

function sub3(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

/**
 * Builds an orthonormal frame from the **bottom chord** of the rear closure arch (projected onto
 * the crown) and the **apex** of the arch — same projection as the closure tunnel in
 * {@link closureProjectToCrownOpening}, not the flat subtract plane alone.
 */
export function getBackClosureChordFrame(
  sk: BuiltSkeleton,
): BackClosureChordFrame | null {
  if (!sk.spec.backClosureOpening) return null;
  const cut = buildBackClosureCutSpec(sk);
  const { widthM, straightM } = cut;
  const halfW = widthM * 0.5;
  const left = closureProjectToCrownOpening(sk, cut, -halfW, 0);
  const right = closureProjectToCrownOpening(sk, cut, halfW, 0);
  const lhApex = straightM + halfW;
  const apex = closureProjectToCrownOpening(sk, cut, 0, lhApex);
  const mid: Vec3 = [
    (left[0] + right[0]) * 0.5,
    (left[1] + right[1]) * 0.5,
    (left[2] + right[2]) * 0.5,
  ];
  const chordVec = sub3(right, left);
  const chordLen = Math.hypot(chordVec[0], chordVec[1], chordVec[2]);
  if (chordLen < 1e-8) return null;

  const tW = norm3(chordVec);
  const nRef = outwardCrownNormalApprox(mid, sk.spec);
  let up = sub3(apex, mid);
  const d = dot3(up, tW);
  up = [up[0] - d * tW[0], up[1] - d * tW[1], up[2] - d * tW[2]];
  const upLen = Math.hypot(up[0], up[1], up[2]);

  let tH: Vec3;
  if (upLen > 1e-8) {
    tH = norm3(up);
  } else {
    let t0 = cross3(nRef, tW);
    if (Math.hypot(t0[0], t0[1], t0[2]) < 1e-10) {
      t0 = cross3(tW, nRef);
    }
    tH = norm3(t0);
  }

  let n = norm3(cross3(tW, tH));
  if (dot3(n, nRef) < 0) {
    n = [-n[0], -n[1], -n[2]];
  }

  return {
    cut,
    left,
    right,
    apex,
    mid,
    tW,
    tH,
    n,
    chordLen,
  };
}
