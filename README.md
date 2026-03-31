# hatlab-generator

Browser-based **parametric hat wireframe** and **crown mesh** built with **Next.js**, **TypeScript**, and **Three.js** (React Three Fiber).

## Convention

- Base plane: **z = 0**; sweatband ellipse center at origin.
- **+Z** is up toward the crown in the skeleton math.
- **+Y** is forward (visor attaches at the front).
- The viewer and GLB apply a **−90° rotation about X** so the hat is **Y-up** in Three.js (brim horizontal, crown along +Y), which matches typical tooling and a natural on-screen orientation.
- Seams end on a **small top ellipse** (`topRimFraction` of the sweatband size at `z = crownHeight`) so panel lines meet **flat** under the button instead of pinching to a single vertex.

**Panels:** only **5** or **6** seams are supported. Default layout (ellipse parameter θ, before `yawRad`): **5-panel** centers the **front panel** on +Y (no seam on the nose); **6-panel** puts a **seam** on +Y so the visor splits at a ridge. The visor attach arc is **inset** from the front side seams (`rimInsetBehindSeamRad`) so the brim meets the crown slightly behind those seams. **5-panel** can show a **partial center seam** from the apex (button) toward the front rim (`fivePanelCenterSeamLength`).

**Seam bulge (UI):** **6-panel** — optional grouped controls: **front** (center seam at +Y), **side-front** (the two seams next to it), **back** (the other three). **5-panel** — optional **split** along the two front panel edges: **visor** segment (rim→split) and **crown** segment (split→button), plus **split position** along the seam. Per-seam `seamSquarenessOverrides` still win when set.

The crown mesh samples the sweatband ellipse along each panel arc, keeps edges on the seam curves (simple or split quadratics), and fills interiors with blended bulge.

## Run the app

```bash
cd web
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000). Drag to orbit. Use **Download GLB** to export the crown mesh plus line geometry (sweatband, seams, visor, apex cross).

## Scripts (in `web/`)

| Command       | Description        |
| ------------- | ------------------ |
| `npm run dev` | Development server |
| `npm run build` | Production build |
| `npm run test` | Vitest (skeleton math) |

## Project layout

- [`web/lib/skeleton/`](web/lib/skeleton/) — Ellipse rim, quadratic Bézier seams to apex, superellipse visor polyline.
- [`web/lib/mesh/crownMesh.ts`](web/lib/mesh/crownMesh.ts) — Crown mesh: sweatband ellipse arc per panel; edges = seam Béziers; interior = same quadratic bulge as seams (blended squareness), not linear rim→apex.
- [`web/lib/hat/buildHatGroup.ts`](web/lib/hat/buildHatGroup.ts) — Assembles `THREE.Group` for the scene and export.
- [`web/components/HatViewer.tsx`](web/components/HatViewer.tsx) — Single-page UI + canvas.

## Reference assets

- [`models/`](models/) — Master GLBs (optional reference).
- [`techpacks/`](techpacks/) — PDF tech packs (optional reference).
