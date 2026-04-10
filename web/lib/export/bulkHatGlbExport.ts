import JSZip from "jszip";
import type { HatDocument } from "@/lib/hat/hatDocument";
import { validateSpec } from "@/lib/skeleton/types";
import { disposeExportObject3D } from "@/lib/export/disposeExportObject3D";
import { exportObjectToGLB } from "@/lib/export/gltf";
import { resolveExportModelPrefix } from "@/lib/export/hatExportNaming";
import { buildFullHatExportRoot } from "@/lib/export/unifiedHatExport";

/** Folder-safe segment for `{name}/{name}.glb` paths (matches single-hat export slug rules). */
export function slugifyHatFolderName(name: string): string {
  return name.replace(/[^\w\-]+/g, "-").replace(/^-|-$/g, "") || "hat";
}

/** Unique slug per batch (duplicate names ? `hat-2`, etc.). */
export function buildUniqueSlug(name: string, used: Set<string>): string {
  const base = slugifyHatFolderName(name);
  let s = base;
  let i = 2;
  while (used.has(s)) {
    s = `${base}-${i++}`;
  }
  used.add(s);
  return s;
}

export type BulkHatGlbResult = {
  errors: string[];
  exportedCount: number;
};

async function glbBlobForHat(hat: HatDocument): Promise<Blob> {
  const root = buildFullHatExportRoot(hat, {
    modelPrefix: resolveExportModelPrefix(hat.name),
  });
  const blob = await exportObjectToGLB(root);
  disposeExportObject3D(root);
  return blob;
}

/**
 * One ZIP: each hat as `{slug}/{slug}.glb`. Skips hats that fail {@link validateSpec}.
 */
export async function buildAllHatsZipBlob(
  hats: HatDocument[],
): Promise<{ blob: Blob } & BulkHatGlbResult> {
  const zip = new JSZip();
  const used = new Set<string>();
  const errors: string[] = [];
  let exportedCount = 0;
  for (const hat of hats) {
    try {
      validateSpec(hat.spec);
    } catch {
      errors.push(hat.name);
      continue;
    }
    const folder = buildUniqueSlug(hat.name, used);
    const blob = await glbBlobForHat(hat);
    zip.file(`${folder}/${folder}.glb`, blob);
    exportedCount++;
  }
  const blob = await zip.generateAsync({ type: "blob" });
  return { blob, errors, exportedCount };
}

export function isFolderExportSupported(): boolean {
  return typeof window !== "undefined" && "showDirectoryPicker" in window;
}

/**
 * Writes `{pick}/{slug}/{slug}.glb` for each valid hat using the
 * [File System Access API](https://developer.mozilla.org/en-US/docs/Web/API/File_System_Access_API)
 * (Chrome, Edge, etc.). User chooses the parent folder.
 */
export async function exportAllHatsToPickedDirectory(
  hats: HatDocument[],
): Promise<BulkHatGlbResult> {
  const w = window as Window & {
    showDirectoryPicker?: (options?: {
      mode?: "read" | "readwrite";
    }) => Promise<FileSystemDirectoryHandle>;
  };
  if (!w.showDirectoryPicker) {
    throw new Error("Folder export is not supported in this browser.");
  }
  const dirHandle = await w.showDirectoryPicker({ mode: "readwrite" });
  const used = new Set<string>();
  const errors: string[] = [];
  let exportedCount = 0;
  for (const hat of hats) {
    try {
      validateSpec(hat.spec);
    } catch {
      errors.push(hat.name);
      continue;
    }
    const folder = buildUniqueSlug(hat.name, used);
    const blob = await glbBlobForHat(hat);
    const subdir = await dirHandle.getDirectoryHandle(folder, { create: true });
    const fileHandle = await subdir.getFileHandle(`${folder}.glb`, {
      create: true,
    });
    const writable = await fileHandle.createWritable();
    await writable.write(blob);
    await writable.close();
    exportedCount++;
  }
  return { errors, exportedCount };
}
