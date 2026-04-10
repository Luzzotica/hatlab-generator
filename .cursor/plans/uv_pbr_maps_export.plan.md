---
name: UV and PBR maps for GLB export
overview: Existing textures can be applied once UVs are authored; normal maps use the same UV channel as base color and roughness—they additionally require tangent vectors for correct shading, not a separate unwrap.
todos:
  - id: uv-crown-panels
    content: UVs for Crown Panel_* — outer/inner grids, rim and top bands, closure tunnel (crownMesh.ts)
  - id: uv-inner-front-rise
    content: UVs for InnerFrontRise_* — inner grid only (crownMesh buildInnerFrontRiseGeometries)
  - id: uv-sweatband
    content: UVs for Sweatband — strip unwrap arc×height (sweatbandMesh.ts)
  - id: uv-visor
    content: UVs for Visor_Top/Bottom/Fillet/Tuck — ruled (s,d) slab space (visorMesh.ts)
  - id: uv-ribbons
    content: UVs for SeamTape + Threading ribbons — u along path, v across width (seamTapeMesh, threadingMesh, curveUtils)
  - id: uv-bill-rope
    content: UVs for BillRope tube — u arc length, v around section (billRopeMesh.ts)
  - id: uv-closures
    content: UVs for Closure_Snapback_* submeshes — per-part projection (snapbackClosureMesh.ts)
  - id: uv-builtins
    content: Verify Eyelets (Torus) + TopButton (Lathe) — Three default UVs or override (eyeletMesh, buildHatGroup)
  - id: tangents
    content: After UVs, run BufferGeometryUtils.computeTangents for export meshes so normal maps light correctly in glTF viewers and DCC tools
  - id: bind-textures
    content: Assign user textures to MeshStandardMaterial (map, normalMap, roughnessMap, aoMap, etc.) on buildHatExportGroup
  - id: verify-glb
    content: Validate GLB in Blender/viewer—check UV islands, normal response, and map alignment
---

# UVs, textures, and normal maps (export)

## What you already have

You have **texture sets** ready to assign. The main build work is **good UVs** on each procedural mesh so those images line up (tiling, panel seams, brim direction, etc.).

## One UV set for all maps (including normals)

**Normal maps do not need a different UV layout from your albedo / roughness / AO maps.**

In PBR, every texture slot samples the **same `TEXCOORD_0`** (Three.js: the `uv` attribute). A “basic” unwrap—if it is **consistent and non-degenerate** (no zero-area triangles in UV space, sensible seams)—is exactly what you use for:

- `map` (base color)
- `normalMap`
- `roughnessMap` / `metalnessMap`
- `aoMap`

So the hard part is **authoring UVs once per mesh/part**, not maintaining two unwraps.

## What normal maps need *in addition* to UVs

Normal maps store **perturbations in tangent space** (relative to the surface). The shader needs a **tangent** (and bitangent) per vertex, not just UVs:

- **UVs** → tell you *where* to sample the normal-map texel.
- **Tangents** (with normals) → define the **frame** that turns that texel into a world-space perturbation.

Without tangents, exporters/viewers may guess or omit data; lighting on normal maps can look wrong or inconsistent across tools.

**Implementation:** after `position`, `normal`, and `uv` exist, call **`BufferGeometryUtils.computeTangents(geometry)`** on export geometry so glTF can carry a `TANGENT` accessor (standard path with Three.js + GLTFExporter).

So: **same UV workflow as “basic” texturing; add tangents for normal maps.**

## Summary

| Concern | Same as color/roughness UVs? | Extra step |
|--------|------------------------------|------------|
| Base color, roughness, AO | Yes — one unwrap | — |
| Normal map | Yes — same UVs | **Compute tangents** after UVs |

## Remaining risks (quality, not “won’t work”)

- **Seams:** texture paint across UV seams can show on color and normals alike; unwrap choices matter for fabric direction.
- **Scale:** tilable fabrics need UV scale consistent with texture resolution (material `repeat` / unwrap density).
- **Handedness:** glTF and Three use compatible tangent conventions when using `computeTangents`; avoid ad-hoc tangent hacks.

## Phasing

1. UVs per mesh family (below)—unblocks your existing textures.
2. `computeTangents` on export meshes.
3. Bind `map`, `normalMap`, and other slots on export materials; validate in Blender.

---

## Export hierarchy (reference)

[`buildHatExportGroup`](web/lib/hat/buildHatGroup.ts) builds (in order):

`Hat` → `Crown` (`Panel_0`…`Panel_{n-1}`) → optional `Eyelets` → `InnerFrontRise` → `TopButton` → `Sweatband` → `SeamTape` → `Threading` → optional `Closures` → optional `Visor` + `BillRope`.

Debug line geometry is **not** exported.

---

## Per-group UV plan

Each row is a **material / shading region** that likely shares one texture set in DCC. UV strategy is what to implement in code so your existing textures line up.

### 1. Crown — `Crown` / `Panel_*`

| | |
|--|--|
| **Meshes** | One `BufferGeometry` per seam panel: outer shell grid, inner shell (except front-rise panels), rim edge band, top edge band, optional back-closure shell + tunnel wall. |
| **Primary file** | [`web/lib/mesh/crownMesh.ts`](web/lib/mesh/crownMesh.ts) (`buildCrownPanelGeometries`, closure helpers). |
| **UV strategy** | **Parametric patch per logical surface** using the same indices as the position builder: **outer/inner ruled grids:** `u = j / M` (meridian / seam-to-seam), `v = k / N` (rim → apex). **Rim and top wall quads:** `u` along the parallel direction around the panel edge, `v` across thickness (short span). **Closure-specific strips:** separate `(u,v)` sub-patches so tunnel and cut surfaces do not overlap in UV space (extra islands are OK). |
| **Notes** | Hardest mesh in the project: many triangle soup regions share one draw call per panel—every `pushTriangle` path must push **matching UV triples**. Expect several UV islands per panel. Front-rise panels omit inner from the main mesh; inner is duplicated under InnerFrontRise (below). |

### 2. Inner front rise — `InnerFrontRise` / `InnerFrontRise_*`

| | |
|--|--|
| **Meshes** | Inner surface only for front-rise panels (`buildInnerFrontRiseGeometries`). |
| **Primary file** | [`web/lib/mesh/crownMesh.ts`](web/lib/mesh/crownMesh.ts) (`pushInnerSurfaceQuads` path). |
| **UV strategy** | Same **(j/M, k/N)** mapping as the crown **inner** grid for those panels so fabric can match the crown interior shader. Align orientation with the outer crown if you want continuous grain across the V. |

### 3. Eyelets — `Eyelets` / `Eyelet_p{panel}`

| | |
|--|--|
| **Meshes** | `THREE.TorusGeometry` instances, transformed onto the crown. |
| **Primary file** | [`web/lib/hat/eyeletMesh.ts`](web/lib/hat/eyeletMesh.ts). |
| **UV strategy** | **Use Three’s built-in torus UVs** (already present on the geometry). Only adjust if your metal ring texture needs different major/minor seam placement—then remap or replace with a thin cylinder unwrap. |
| **Notes** | No change required unless art direction demands it. |

### 4. Top button — `TopButton`

| | |
|--|--|
| **Meshes** | `THREE.LatheGeometry` (domed button). |
| **Primary file** | [`web/lib/hat/buildHatGroup.ts`](web/lib/hat/buildHatGroup.ts) (`buildTopButtonMesh`). |
| **UV strategy** | **Built-in lathe UVs** (revolve = natural `u` around axis, `v` along profile). Good for a small circular trim sheet or radial brushed metal. |

### 5. Sweatband — `Sweatband`

| | |
|--|--|
| **Meshes** | Single merged strip (open or closed ellipse segment), vertical quads. |
| **Primary file** | [`web/lib/mesh/sweatbandMesh.ts`](web/lib/mesh/sweatbandMesh.ts) (`buildSweatbandGeometry`). |
| **UV strategy** | **Strip / cylinder style:** **`u`** = normalized distance along the sweatband path (rim polyline / front arc—match how you walk vertices in order). **`v`** = height from bottom to top of band (0 → 1). Closure gap: keep `u` continuous or add a seam with offset—pick one convention and document for texture authoring. |

### 6. Visor — `Visor` / `Visor_Top`, `Visor_Bottom`, `Visor_Fillet`, `Visor_Tuck`

| | |
|--|--|
| **Meshes** | Ruled bill: top slab, bottom slab, edge fillet, tuck under. |
| **Primary file** | [`web/lib/mesh/visorMesh.ts`](web/lib/mesh/visorMesh.ts) (`buildVisorTopBottomGeometries`, `buildVisorFilletGeometry`, `buildVisorTuckGeometry`). |
| **UV strategy** | Align with the **ruled surface parameters** already used for positions: **`u` = span parameter `s` (tip to tip, 0–1)**, **`v` = depth `d` (rim toward outer, 0–1)** — same as `evalVisorRuledPointWorld(sk, s, d)` semantics. Fillet and tuck are offset surfaces; derive `(u,v)` from the same `(s,d)` or from arc-length on boundary curves so plastic/leather textures follow the brim direction. |
| **Notes** | Best candidate for **shared “bill” texture** across top/bottom if `v` is consistent (underside can mirror `v` in material if needed). |

### 7. Seam tape — `SeamTape` / `Tape_Rear*`, `Tape_Front`, `Tape_Cross*`, `Tape_ArchClosure`

| | |
|--|--|
| **Meshes** | Open ribbons along seam curves (`ribbonGeometryOpen` and related in [`curveUtils`](web/lib/hat/curveUtils.ts)). |
| **Primary file** | [`web/lib/hat/seamTapeMesh.ts`](web/lib/hat/seamTapeMesh.ts). |
| **UV strategy** | **Ribbon standard:** **`u`** = 0–1 along the tape centerline (prefer **arc length** normalization so texture repeats at constant world scale). **`v`** = 0–1 across tape width (one edge = 0, other = 1). Each tape strip is its own island; that matches how tape is authored in Substance. |

### 8. Threading — `Threading` / `Thread_Seam*`, `Thread_Base`, `Thread_Visor_*`, `Thread_Sweatband_*`

| | |
|--|--|
| **Meshes** | Very thin dashed ribbons on crown seams, visor rows, sweatband rows; stitch tubes may be flattened ribbons. |
| **Primary file** | [`web/lib/hat/threadingMesh.ts`](web/lib/hat/threadingMesh.ts) (uses [`dashedRibbonGeometry`](web/lib/hat/curveUtils.ts), etc.). |
| **UV strategy** | Same **ribbon `(u along path, v across width)`** as seam tape. For **dashed** geometry, either tile `u` so one thread texture repeats, or keep `u` in world arc-length and set material **`repeat`** to match stitch spacing. |

### 9. Bill rope — `BillRope`

| | |
|--|--|
| **Meshes** | Tubular mesh along a 3D centerline with varying radius (`buildBillRopeGroup` / tube builder). |
| **Primary file** | [`web/lib/hat/billRopeMesh.ts`](web/lib/hat/billRopeMesh.ts). |
| **UV strategy** | **Tube mapping:** **`u`** = normalized arc length along the rope centerline (0–1 or repeat >1 for twist). **`v`** = angle around the cross-section (0–1). Matches braided/rope tilable textures. |

### 10. Closures (snapback) — `Closures` / `Closure_Snapback_*`

| | |
|--|--|
| **Meshes** | Strap tabs (fields + rims), snap studs, stems, domes—multiple extrusion-like pieces. |
| **Primary file** | [`web/lib/hat/snapbackClosureMesh.ts`](web/lib/hat/snapbackClosureMesh.ts). |
| **UV strategy** | **Per submesh type:** **flat tabs** → planar projection or simple **box** unwrap in local space; **cylindrical snaps** → **`u` around hoop, `v` along height**; small **domes** → spherical cap or lathe-like `(u,v)`. Keep islands separate per named mesh so you can assign different trim textures. |

---

## Suggested implementation order

1. **Visor** (clean `(s,d)` mapping; single “bill” material story).  
2. **Sweatband** (one mesh, clear strip topology).  
3. **Crown panels + inner front rise** (largest surface area, most triangles).  
4. **Ribbon helpers** in `curveUtils` (seam tape + threading share patterns).  
5. **Bill rope** (tube).  
6. **Snapback** (assorted parts).  
7. **Verify** torus + lathe primitives.  

Then run **`computeTangents`** once per finalized geometry used in export.
