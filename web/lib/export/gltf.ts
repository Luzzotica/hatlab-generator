import * as THREE from "three";
import { GLTFExporter } from "three/examples/jsm/exporters/GLTFExporter.js";
import { sanitizeGeometriesForGLTFExport } from "@/lib/export/prepareExportGeometry";

export async function exportObjectToGLB(object: THREE.Object3D): Promise<Blob> {
  sanitizeGeometriesForGLTFExport(object);
  const exporter = new GLTFExporter();
  const result = await exporter.parseAsync(object, { binary: true });
  if (result instanceof ArrayBuffer) {
    return new Blob([result], { type: "model/gltf-binary" });
  }
  throw new Error("Expected binary GLB from GLTFExporter.parseAsync");
}

export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
