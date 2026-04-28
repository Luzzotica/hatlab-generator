import JSZip from "jszip";
import type { HatDocument } from "@/lib/hat/hatDocument";
import { serializeHatDocument } from "@/lib/hat/hatDocument";
import { validateSpec } from "@/lib/skeleton/types";
import { buildUniqueSlug } from "@/lib/export/bulkHatGlbExport";

/**
 * One ZIP: each hat as `{slug}/{slug}.json`. Skips hats that fail {@link validateSpec}.
 */
export async function buildAllHatsJsonZipBlob(
  hats: HatDocument[],
): Promise<{ blob: Blob; errors: string[]; exportedCount: number }> {
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
    zip.file(`${folder}/${folder}.json`, serializeHatDocument(hat));
    exportedCount++;
  }
  const blob = await zip.generateAsync({ type: "blob" });
  return { blob, errors, exportedCount };
}
