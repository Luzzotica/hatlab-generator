import * as THREE from "three";
import type { HatDocument } from "@/lib/hat/hatDocument";
import {
  addCrownDecalToExportFrame,
  findCrownPanelMesh,
  loadTextureFromDataUrl,
} from "@/lib/decal/crownDecal";

/**
 * Appends a projected decal mesh to the simple export (`buildHatExportGroup`).
 * Call **after** `neutralizeExportMaterialTree` (already applied inside build) so the decal keeps its map.
 * The decal mesh owns its texture; dispose it with the rest of the export graph.
 */
export async function appendHatDecalToSimpleExport(
  hatRoot: THREE.Group,
  doc: HatDocument,
): Promise<void> {
  const d = doc.decal;
  if (!d?.imageDataUrl) return;
  const tex = await loadTextureFromDataUrl(d.imageDataUrl);
  const frame = hatRoot.getObjectByName("HatExportFrame") as THREE.Group | undefined;
  const panel = frame
    ? findCrownPanelMesh(frame, d.panelIndex, doc.spec.nSeams)
    : undefined;
  if (frame && panel) addCrownDecalToExportFrame(frame, panel, d, tex);
}

/**
 * Appends the same decal to each visor branch of the unified full-hat export (four modular trees).
 * Uses a **clone** of the loaded texture per branch so each material can dispose independently.
 * Returns the **base** texture from the loader (never assigned to a mesh) — dispose it after
 * {@link disposeExportObject3D} so image memory is freed without double-disposing GPU textures on meshes.
 */
export async function appendHatDecalToFullExport(
  unifiedRoot: THREE.Group,
  doc: HatDocument,
): Promise<THREE.Texture | null> {
  const d = doc.decal;
  if (!d?.imageDataUrl) return null;
  const base = await loadTextureFromDataUrl(d.imageDataUrl);
  for (let i = 0; i < 4; i++) {
    const visorRoot = unifiedRoot.children[i];
    if (!visorRoot) continue;
    const modular = visorRoot.children[0];
    if (!modular) continue;
    const frame = modular.getObjectByName("HatExportFrame") as
      | THREE.Group
      | undefined;
    const panel = frame
      ? findCrownPanelMesh(frame, d.panelIndex, doc.spec.nSeams)
      : undefined;
    if (!frame || !panel) continue;
    const branchTex = base.clone();
    branchTex.needsUpdate = true;
    addCrownDecalToExportFrame(frame, panel, d, branchTex);
  }
  return base;
}
