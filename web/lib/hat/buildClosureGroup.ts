import * as THREE from "three";
import type { BuiltSkeleton } from "@/lib/skeleton/geometry";
import { buildSnapbackClosureGroup } from "@/lib/hat/snapbackClosureMesh";

/**
 * Rear-opening closure hardware (strap, buckle, etc.). No-op unless `backClosureOpening`
 * and at least one entry in `spec.closures`.
 */
export function buildClosureGroup(sk: BuiltSkeleton): THREE.Group {
  const group = new THREE.Group();
  group.name = "Closures";
  if (!sk.spec.backClosureOpening || sk.spec.closures.length === 0) {
    return group;
  }

  for (const c of sk.spec.closures) {
    if (c.type === "snapback") {
      group.add(buildSnapbackClosureGroup(sk));
    }
  }

  return group;
}
