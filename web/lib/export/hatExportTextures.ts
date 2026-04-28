import * as THREE from "three";

export type HatExportTextureSlot = {
  map?: THREE.Texture;
  normalMap?: THREE.Texture;
  roughnessMap?: THREE.Texture;
  metalnessMap?: THREE.Texture;
  aoMap?: THREE.Texture;
};

/** Optional PBR map paths (under `public/`). */
export type HatExportTexturePaths = {
  crown?: Partial<
    Record<
      "map" | "normalMap" | "roughnessMap" | "metalnessMap" | "aoMap",
      string
    >
  >;
  sweatband?: Partial<
    Record<"map" | "normalMap" | "roughnessMap" | "aoMap", string>
  >;
  visorTop?: Partial<
    Record<"map" | "normalMap" | "roughnessMap" | "aoMap", string>
  >;
  visorBottom?: Partial<
    Record<"map" | "normalMap" | "roughnessMap" | "aoMap", string>
  >;
};

export type HatExportTexturesLoaded = {
  crown: HatExportTextureSlot;
  sweatband: HatExportTextureSlot;
  visorTop: HatExportTextureSlot;
  visorBottom: HatExportTextureSlot;
};

function loadTexture(
  loader: THREE.TextureLoader,
  url: string | undefined,
  colorSpace: THREE.ColorSpace,
): Promise<THREE.Texture | undefined> {
  if (!url) return Promise.resolve(undefined);
  return new Promise((resolve) => {
    loader.load(
      url,
      (tex) => {
        tex.colorSpace = colorSpace;
        tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
        resolve(tex);
      },
      undefined,
      () => resolve(undefined),
    );
  });
}

/**
 * Loads optional maps; missing URLs resolve to `undefined` (solid colors remain).
 */
export async function loadHatExportTextures(
  paths: HatExportTexturePaths = defaultHatExportTexturePaths,
): Promise<HatExportTexturesLoaded> {
  const loader = new THREE.TextureLoader();
  const p = paths;

  const [
    crownMap,
    crownNor,
    crownRough,
    crownMetal,
    crownAo,
    sbMap,
    sbNor,
    sbRough,
    sbAo,
    vtMap,
    vtNor,
    vtRough,
    vtAo,
    vbMap,
    vbNor,
    vbRough,
    vbAo,
  ] = await Promise.all([
    loadTexture(loader, p.crown?.map, THREE.SRGBColorSpace),
    loadTexture(loader, p.crown?.normalMap, THREE.LinearSRGBColorSpace),
    loadTexture(loader, p.crown?.roughnessMap, THREE.LinearSRGBColorSpace),
    loadTexture(loader, p.crown?.metalnessMap, THREE.LinearSRGBColorSpace),
    loadTexture(loader, p.crown?.aoMap, THREE.LinearSRGBColorSpace),
    loadTexture(loader, p.sweatband?.map, THREE.SRGBColorSpace),
    loadTexture(loader, p.sweatband?.normalMap, THREE.LinearSRGBColorSpace),
    loadTexture(loader, p.sweatband?.roughnessMap, THREE.LinearSRGBColorSpace),
    loadTexture(loader, p.sweatband?.aoMap, THREE.LinearSRGBColorSpace),
    loadTexture(loader, p.visorTop?.map, THREE.SRGBColorSpace),
    loadTexture(loader, p.visorTop?.normalMap, THREE.LinearSRGBColorSpace),
    loadTexture(loader, p.visorTop?.roughnessMap, THREE.LinearSRGBColorSpace),
    loadTexture(loader, p.visorTop?.aoMap, THREE.LinearSRGBColorSpace),
    loadTexture(loader, p.visorBottom?.map, THREE.SRGBColorSpace),
    loadTexture(loader, p.visorBottom?.normalMap, THREE.LinearSRGBColorSpace),
    loadTexture(loader, p.visorBottom?.roughnessMap, THREE.LinearSRGBColorSpace),
    loadTexture(loader, p.visorBottom?.aoMap, THREE.LinearSRGBColorSpace),
  ]);

  return {
    crown: {
      map: crownMap,
      normalMap: crownNor,
      roughnessMap: crownRough,
      metalnessMap: crownMetal,
      aoMap: crownAo,
    },
    sweatband: {
      map: sbMap,
      normalMap: sbNor,
      roughnessMap: sbRough,
      aoMap: sbAo,
    },
    visorTop: {
      map: vtMap,
      normalMap: vtNor,
      roughnessMap: vtRough,
      aoMap: vtAo,
    },
    visorBottom: {
      map: vbMap,
      normalMap: vbNor,
      roughnessMap: vbRough,
      aoMap: vbAo,
    },
  };
}

export function applyTexturesToStandardMaterial(
  mat: THREE.MeshStandardMaterial,
  slot: HatExportTextureSlot,
): void {
  if (slot.map) mat.map = slot.map;
  if (slot.normalMap) {
    mat.normalMap = slot.normalMap;
    mat.normalScale.set(1, 1);
  }
  if (slot.roughnessMap) mat.roughnessMap = slot.roughnessMap;
  if (slot.metalnessMap) mat.metalnessMap = slot.metalnessMap;
  if (slot.aoMap) mat.aoMap = slot.aoMap;
  mat.needsUpdate = true;
}

/**
 * GLB export uses flat white base materials with no maps so hosts can assign color/texture in code.
 * Crown logo decals are appended **after** this step (see `appendHatDecalToSimpleExport`) so they keep `map`.
 */
export function neutralizeExportMaterialTree(root: THREE.Object3D): void {
  root.traverse((o) => {
    if (!(o instanceof THREE.Mesh)) return;
    if (o.geometry && o.geometry.getAttribute("color")) {
      o.geometry.deleteAttribute("color");
    }
    const m = o.material;
    const mats = Array.isArray(m) ? m : [m];
    for (const mat of mats) {
      neutralizeExportMaterial(mat);
    }
  });
}

function neutralizeExportMaterial(mat: THREE.Material): void {
  if (
    mat instanceof THREE.MeshStandardMaterial ||
    mat instanceof THREE.MeshPhysicalMaterial
  ) {
    mat.color.setHex(0xffffff);
    mat.emissive.setHex(0x000000);
    mat.emissiveIntensity = 0;
    mat.map = null;
    mat.lightMap = null;
    mat.normalMap = null;
    mat.roughnessMap = null;
    mat.metalnessMap = null;
    mat.aoMap = null;
    mat.emissiveMap = null;
    mat.alphaMap = null;
    mat.bumpMap = null;
    mat.displacementMap = null;
    mat.envMap = null;
    mat.roughness = 1;
    mat.metalness = 0;
    if (mat instanceof THREE.MeshPhysicalMaterial) {
      mat.clearcoatMap = null;
      mat.clearcoatNormalMap = null;
      mat.clearcoatRoughnessMap = null;
      mat.sheenColorMap = null;
      mat.specularIntensityMap = null;
      mat.specularColorMap = null;
      mat.transmissionMap = null;
      mat.thicknessMap = null;
      mat.anisotropyMap = null;
      mat.iridescenceMap = null;
      mat.iridescenceThicknessMap = null;
    }
    mat.needsUpdate = true;
    return;
  }
  if (mat instanceof THREE.MeshBasicMaterial) {
    mat.color.setHex(0xffffff);
    mat.map = null;
    mat.alphaMap = null;
    mat.envMap = null;
    mat.lightMap = null;
    mat.needsUpdate = true;
    return;
  }
  if (mat instanceof THREE.MeshLambertMaterial) {
    mat.color.setHex(0xffffff);
    mat.emissive.setHex(0x000000);
    mat.map = null;
    mat.emissiveMap = null;
    mat.envMap = null;
    mat.needsUpdate = true;
    return;
  }
  if (mat instanceof THREE.MeshPhongMaterial) {
    mat.color.setHex(0xffffff);
    mat.emissive.setHex(0x000000);
    mat.map = null;
    mat.emissiveMap = null;
    mat.normalMap = null;
    mat.envMap = null;
    mat.needsUpdate = true;
    return;
  }
  if (mat instanceof THREE.LineBasicMaterial) {
    mat.color.setHex(0xffffff);
    mat.needsUpdate = true;
  }
}

/** Default paths — add files under `web/public/textures/hat/` to pick them up. */
export const defaultHatExportTexturePaths: HatExportTexturePaths = {
  crown: {
    map: "/textures/hat/crown_color.png",
    normalMap: "/textures/hat/crown_normal.png",
    roughnessMap: "/textures/hat/crown_roughness.png",
    metalnessMap: "/textures/hat/crown_metalness.png",
    aoMap: "/textures/hat/crown_ao.png",
  },
  sweatband: {
    map: "/textures/hat/sweatband_color.png",
    normalMap: "/textures/hat/sweatband_normal.png",
    roughnessMap: "/textures/hat/sweatband_roughness.png",
    aoMap: "/textures/hat/sweatband_ao.png",
  },
  visorTop: {
    map: "/textures/hat/visor_top_color.png",
    normalMap: "/textures/hat/visor_top_normal.png",
    roughnessMap: "/textures/hat/visor_top_roughness.png",
    aoMap: "/textures/hat/visor_top_ao.png",
  },
  visorBottom: {
    map: "/textures/hat/visor_bottom_color.png",
    normalMap: "/textures/hat/visor_bottom_normal.png",
    roughnessMap: "/textures/hat/visor_bottom_roughness.png",
    aoMap: "/textures/hat/visor_bottom_ao.png",
  },
};
