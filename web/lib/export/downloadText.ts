import { downloadBlob } from "./gltf";

export function downloadTextFile(
  text: string,
  filename: string,
  mimeType = "application/json",
): void {
  downloadBlob(new Blob([text], { type: mimeType }), filename);
}
