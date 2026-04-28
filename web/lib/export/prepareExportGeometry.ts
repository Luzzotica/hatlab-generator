import * as THREE from "three";

/**
 * Vertex attributes allowed on exported glTF meshes. Most app-specific attrs are stripped so
 * Blender and other importers do not see mixed custom types across primitives.
 *
 * **Laser etch (crown):** `laserPlaneMm` (vec2) and `laserEdgeDistMm` (vec4) are kept for
 * downstream rendering (procedural holes + manufacturing masks). Meshes that never had them
 * are unchanged.
 *
 * **Three.js glTF name transform:** non-standard attribute names are prefixed with `_` and
 * uppercased in the file; `GLTFLoader` assigns geometry attributes in lowercase. After load,
 * expect `_laserplanemm` / `_laseredgedistmm` unless you rename back to `laserPlaneMm` /
 * `laserEdgeDistMm` for shader parity with HatLab.
 *
 * @see `web/docs/gltf-laser-vertex-attributes.md`
 */
const GLTF_PRESERVED_VERTEX_ATTRIBUTES = new Set([
  "position",
  "normal",
  "uv",
  "uv2",
  "color",
  "tangent",
  "laserPlaneMm",
  "laserEdgeDistMm",
]);

function attributeBackingArray(
  attr: THREE.BufferAttribute | THREE.InterleavedBufferAttribute,
): ArrayBufferView | undefined {
  if (attr instanceof THREE.InterleavedBufferAttribute) {
    return attr.data?.array;
  }
  return attr.array;
}

/**
 * GLTFExporter.processAccessor reads `attribute.array.constructor` before handling `count === 0`.
 * Strip attributes (and invalid index buffers) whose backing array is missing so export does not throw.
 */
export function sanitizeGeometriesForGLTFExport(root: THREE.Object3D): void {
  const toRemove: THREE.Object3D[] = [];

  root.traverse((obj) => {
    if (
      !(obj instanceof THREE.Mesh) &&
      !(obj instanceof THREE.Line) &&
      !(obj instanceof THREE.LineSegments) &&
      !(obj instanceof THREE.Points)
    ) {
      return;
    }
    const geom = obj.geometry as THREE.BufferGeometry;
    if (!geom) {
      toRemove.push(obj);
      return;
    }

    const keys = Object.keys(geom.attributes);
    for (const key of keys) {
      if (!GLTF_PRESERVED_VERTEX_ATTRIBUTES.has(key)) {
        geom.deleteAttribute(key);
        continue;
      }
      const attr = geom.getAttribute(key);
      if (!attr) {
        geom.deleteAttribute(key);
        continue;
      }
      const arr = attributeBackingArray(
        attr as THREE.BufferAttribute | THREE.InterleavedBufferAttribute,
      );
      if (arr == null) {
        geom.deleteAttribute(key);
      }
    }

    const idx = geom.index;
    if (idx && idx.array == null) {
      geom.setIndex(null);
    }

    const pos = geom.getAttribute("position");
    const posArr = pos
      ? attributeBackingArray(
          pos as THREE.BufferAttribute | THREE.InterleavedBufferAttribute,
        )
      : undefined;
    if (!pos || posArr == null) {
      toRemove.push(obj);
    }
  });

  for (const o of toRemove) {
    o.parent?.remove(o);
  }
}

/**
 * Computes tangents for every mesh under `root` that has `position`, `normal`, and `uv`.
 * Non-indexed geometries are given a trivial index buffer so `BufferGeometry.computeTangents` can run.
 *
 * For glTF normal maps, MikkTSpace is ideal; Three's built-in tangents are sufficient for consistent export.
 */
export function computeTangentsForExport(root: THREE.Object3D): void {
  root.traverse((obj) => {
    if (!(obj instanceof THREE.Mesh)) return;
    const g = obj.geometry;
    if (
      !g.getAttribute("uv") ||
      !g.getAttribute("position") ||
      !g.getAttribute("normal")
    ) {
      return;
    }
    try {
      if (g.index === null) {
        const n = g.getAttribute("position").count;
        const idx = new Uint32Array(n);
        for (let i = 0; i < n; i++) idx[i] = i;
        g.setIndex(idx);
      }
      g.computeTangents();
    } catch {
      /* skip meshes where tangents cannot be computed */
    }
  });
}
