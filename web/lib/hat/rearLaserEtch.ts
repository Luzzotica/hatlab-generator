import * as THREE from "three";

/** Viewer-only: alpha-map or procedural patterns on non-front-rise crown panels (side + rear; matches Crown_Side and Crown_Rear in export). */
export type RearLaserEtchMode =
  | "none"
  | "mesh"
  | "circle1mm"
  | "circle2mm"
  | "teardrop"
  | "diamond";

export const REAR_LASER_ETCH_LABELS: Record<RearLaserEtchMode, string> = {
  none: "None",
  mesh: "Mesh (net)",
  circle1mm: "1mm circles",
  circle2mm: "2mm circles",
  teardrop: "Teardrops",
  diamond: "Diamonds",
};

/** Circle, teardrop, diamond, and mesh (net) use the procedural fragment shader (see proceduralLaserEtch.ts). */
export function usesProceduralLaserEtch(mode: RearLaserEtchMode): boolean {
  return (
    mode === "circle1mm" ||
    mode === "circle2mm" ||
    mode === "teardrop" ||
    mode === "diamond" ||
    mode === "mesh"
  );
}

/** Paths under `public/` (Next.js serves from `/`). */
export function textureUrlForRearLaserEtchMode(
  mode: RearLaserEtchMode,
): string | null {
  switch (mode) {
    case "none":
      return null;
    case "mesh":
      return null;
    case "circle1mm":
      return "/textures/hat/laser-etch/laser_etch_1mm_circle_alpha.png";
    case "circle2mm":
      return "/textures/hat/laser-etch/laser_etch_2mm_circle_alpha.png";
    case "teardrop":
      return "/textures/hat/laser-etch/laser_etch_teardrop_alpha.png";
    case "diamond":
      return "/textures/hat/laser-etch/laser_etch_diamond_alpha.png";
    default:
      return null;
  }
}

/**
 * Laser PNGs are white motifs on transparent gaps. For alphaTest cutouts we want fabric = opaque
 * and holes = discarded, so invert the alpha channel (net/mesh textures are already correct).
 */
export function invertTextureAlpha(tex: THREE.Texture): void {
  const img = tex.image as HTMLImageElement | HTMLCanvasElement | undefined;
  if (!img || !("width" in img) || img.width <= 0) return;
  const w = img.width;
  const h = img.height;
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.drawImage(img as CanvasImageSource, 0, 0);
  const d = ctx.getImageData(0, 0, w, h);
  for (let i = 0; i < d.data.length; i += 4) {
    d.data[i + 3] = 255 - d.data[i + 3]!;
  }
  ctx.putImageData(d, 0, 0);
  tex.image = canvas;
  tex.needsUpdate = true;
}

export function shouldInvertAlphaForMode(mode: RearLaserEtchMode): boolean {
  return mode !== "none" && mode !== "mesh";
}

/**
 * MeshStandardMaterial's `alphaMap` uses grayscale from the texture's **RGB** (see
 * alphamap_fragment.glsl.js), not the PNG alpha channel. Our PNGs often keep RGB white while
 * storing transparency only in alpha; holes look opaque to the shader until we copy A to R/G/B.
 */
export function packAlphaChannelIntoRgbForAlphaMap(tex: THREE.Texture): void {
  const img = tex.image as HTMLImageElement | HTMLCanvasElement | undefined;
  if (!img || !("width" in img) || img.width <= 0) return;
  const w = img.width;
  const h = img.height;
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.drawImage(img as CanvasImageSource, 0, 0);
  const d = ctx.getImageData(0, 0, w, h);
  for (let i = 0; i < d.data.length; i += 4) {
    const a = d.data[i + 3]!;
    d.data[i] = a;
    d.data[i + 1] = a;
    d.data[i + 2] = a;
    d.data[i + 3] = 255;
  }
  ctx.putImageData(d, 0, 0);
  tex.image = canvas;
  tex.needsUpdate = true;
}
