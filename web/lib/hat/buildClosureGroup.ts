import * as THREE from "three";
import type { HatClosureKind } from "@/lib/skeleton/types";
import type { BuiltSkeleton } from "@/lib/skeleton/geometry";
import { buildMetalSlideClosureGroup } from "@/lib/hat/metalSlideClosureMesh";
import { buildShockCordClosureGroup } from "@/lib/hat/shockCordClosureMesh";
import { buildSnapbackClosureGroup } from "@/lib/hat/snapbackClosureMesh";
import { buildStrapbackClosureGroup } from "@/lib/hat/strapbackClosureMesh";
import { buildVelcroClosureGroup } from "@/lib/hat/velcroClosureMesh";

/**
 * Default filter when limiting which closure kinds to build (e.g. previews). Unified GLB export
 * builds snapback and velcro separately (see `buildHatExportGroupModular` in `buildHatGroup.ts`).
 */
export const HAT_EXPORT_CLOSURE_HARDWARE_KINDS: readonly HatClosureKind[] = [
  "snapback",
  "velcro",
];

export type BuildClosureGroupOptions = {
  /** If set, only these closure kinds produce meshes. */
  allowedKinds?: readonly HatClosureKind[];
};

/**
 * Rear-opening closure hardware (strap, buckle, etc.). No-op unless `backClosureOpening`
 * and at least one entry in `spec.closures`.
 */
export function buildClosureGroup(
  sk: BuiltSkeleton,
  options?: BuildClosureGroupOptions,
): THREE.Group {
  const group = new THREE.Group();
  group.name = "Closures";
  if (!sk.spec.backClosureOpening || sk.spec.closures.length === 0) {
    return group;
  }

  const allowed = options?.allowedKinds;
  for (const c of sk.spec.closures) {
    if (allowed && !allowed.includes(c.type)) continue;
    if (c.type === "snapback") {
      group.add(buildSnapbackClosureGroup(sk));
    } else if (c.type === "velcro") {
      group.add(buildVelcroClosureGroup(sk));
    } else if (c.type === "strapback") {
      group.add(buildStrapbackClosureGroup(sk));
    } else if (c.type === "metalSlide") {
      group.add(buildMetalSlideClosureGroup(sk));
    } else if (c.type === "shockCord") {
      group.add(buildShockCordClosureGroup(sk));
    }
  }

  return group;
}
