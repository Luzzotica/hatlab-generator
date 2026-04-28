/**
 * Single GLB with four visor branches (`{model}_{flat_curve|…}`). Each branch is one modular export:
 * `Crown_Outer` / `Crown_Inner` + swappable rear panels (outer + inner each) + dual sweatbands /
 * seam tape / threading + hardware + eyelets (see {@link buildHatExportGroupModular}).
 */
import * as THREE from "three";
import { buildHatExportGroupModular } from "@/lib/hat/buildHatGroup";
import type { HatDocument } from "@/lib/hat/hatDocument";
import type { VisorShapeIndex } from "@/lib/hat/hatDocument";
import { computeTangentsForExport } from "@/lib/export/prepareExportGeometry";
import {
  childNamePrefix,
  visorGroupKey,
  visorRootGroupName,
} from "@/lib/export/hatExportNaming";
import { deepCloneMeshResources } from "@/lib/export/disposeExportObject3D";

export interface UnifiedHatExportOptions {
  /** Default `m1` (model id in DCC). */
  modelPrefix?: string;
}

function slugifyPartName(name: string): string {
  return name
    .replace(/([a-z])([A-Z])/g, "$1_$2")
    .replace(/[\s]+/g, "_")
    .toLowerCase();
}

/**
 * Prefix every descendant name with `{basePrefix}_{parent1}_{parent2}_{…}_{slug}` so nested groups
 * like `Fitted/Crown_Rear` stay unique from `Closure/Crown_Rear`.
 */
export function applyExportNamePrefixToChildren(
  root: THREE.Object3D,
  basePrefix: string,
): void {
  const originalNames = new Map<THREE.Object3D, string>();
  root.traverse((o) => {
    originalNames.set(o, o.name);
  });
  root.traverse((obj) => {
    if (obj === root) return;
    const segments: string[] = [];
    let p: THREE.Object3D | null = obj;
    while (p && p !== root) {
      segments.unshift(slugifyPartName(originalNames.get(p)! || "unnamed"));
      p = p.parent;
    }
    obj.name = [basePrefix, ...segments].join("_");
  });
}

/**
 * One GLB root: four top-level groups (one per visor curve). Each contains one modular hat with
 * stable slot names under `{model}_{visor}_*`.
 */
export function buildFullHatExportRoot(
  doc: HatDocument,
  options?: UnifiedHatExportOptions,
): THREE.Group {
  const modelPrefix = options?.modelPrefix ?? "m1";

  const root = new THREE.Group();
  root.name = slugifyPartName(doc.name || "hat_export");

  for (let i = 0; i < 4; i++) {
    const visorIndex = i as VisorShapeIndex;
    const vKey = visorGroupKey(visorIndex);
    const visorRoot = new THREE.Group();
    visorRoot.name = visorRootGroupName(modelPrefix, vKey);
    const basePrefix = childNamePrefix(modelPrefix, vKey);

    const modular = buildHatExportGroupModular(doc, visorIndex);
    modular.name = `${basePrefix}_root`;
    applyExportNamePrefixToChildren(modular, basePrefix);
    deepCloneMeshResources(modular);
    visorRoot.add(modular);

    root.add(visorRoot);
  }

  computeTangentsForExport(root);
  return root;
}
