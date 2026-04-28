/** @vitest-environment jsdom */
import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { createDefaultHatDocument } from "@/lib/hat/hatDocument";
import { buildHatExportGroup } from "@/lib/hat/buildHatGroup";
import { computeTangentsForExport } from "@/lib/export/prepareExportGeometry";
import { exportObjectToGLB } from "@/lib/export/gltf";
import { mergeHatSpecDefaults } from "@/lib/skeleton/types";

async function loadExportedScene(spec: ReturnType<typeof mergeHatSpecDefaults>) {
  const g = buildHatExportGroup(spec);
  computeTangentsForExport(g);
  const blob = await exportObjectToGLB(g);
  const buf = await blob.arrayBuffer();
  return new GLTFLoader().parseAsync(buf, "");
}

describe("GLB laser vertex attributes", () => {
  it("round-trips laserPlaneMm and laserEdgeDistMm on crown meshes (Three.js GLTFLoader names)", async () => {
    const doc = createDefaultHatDocument();
    const { scene } = await loadExportedScene(doc.spec);

    const attrNames = new Set<string>();
    let crownMeshCount = 0;
    scene.traverse((o) => {
      if (!(o instanceof THREE.Mesh) || !o.geometry) return;
      if (!o.name.startsWith("Crown_") && !o.name.startsWith("Panel_"))
        return;
      crownMeshCount++;
      for (const k of Object.keys(o.geometry.attributes)) attrNames.add(k);
    });

    expect(crownMeshCount).toBeGreaterThan(0);
    expect(attrNames.has("_laserplanemm")).toBe(true);
    expect(attrNames.has("_laseredgedistmm")).toBe(true);
  });

  for (const nSeams of [5, 6] as const) {
    it(`exports _laserplanemm on Crown_Front_Inner mesh (${nSeams}-panel)`, async () => {
      const doc = createDefaultHatDocument();
      const spec = mergeHatSpecDefaults({ ...doc.spec, nSeams });
      const { scene } = await loadExportedScene(spec);

      let frontInner: THREE.Mesh | undefined;
      scene.traverse((o) => {
        if (o instanceof THREE.Mesh && o.name === "Crown_Front_Inner") {
          frontInner = o;
        }
      });
      expect(frontInner, "Crown_Front_Inner mesh present").toBeDefined();
      const attrs = frontInner!.geometry.attributes;
      expect(Object.keys(attrs)).toContain("_laserplanemm");
      const lp = attrs._laserplanemm as THREE.BufferAttribute;
      expect(lp.itemSize).toBe(2);
      expect(lp.count).toBe(
        (attrs.position as THREE.BufferAttribute).count,
      );
    });
  }
});
