// =============================================================================
// Procedural laser etch - Three.js MeshStandardMaterial onBeforeCompile snippets
// =============================================================================
// Copy this file into another app and wire the sections as described below.
//
// Geometry (crown mesh):
//   attribute vec4 laserEdgeDistMm;  // x=left seam mm, y=right, z=rim, w=closure arch
//   attribute vec2 laserPlaneMm;     // physical panel plane in mm (for isotropic tiling)
//
// Uniforms (set in JS):
//   uLaserProcMode int     // 0 circle1mm, 1 circle2mm, 2 teardrop, 3 diamond, 4 mesh (orthogonal net)
//   uLaserPitchMm float    // center-to-center pitch in mm (mode-specific; mesh uses 4mm in TS)
//   uLaserSeamExcludeMm, uLaserRimExcludeMm, uLaserClosureExcludeMm float
//
// Integration:
//   1) After #include <common> in vertex shader: paste VERTEX_AFTER_COMMON
//   2) After #include <uv_vertex> in vertex shader: paste VERTEX_AFTER_UV_VERTEX
//   3) After #include <common> in fragment shader: paste FRAGMENT_AFTER_COMMON
//   4) Replace #include <color_fragment> in fragment shader: paste FRAGMENT_COLOR_FRAGMENT
//
// Mode 4 — mesh / orthogonal net (hardcoded for portability):
//   uLaserProcMode = 4
//   uLaserPitchMm  = 4.0   (repeat every 4 mm in panel plane; set in TS as NET_MESH_PITCH_MM)
//   In cell UV [0,1]^2: strut width t = 0.11 (11% of cell); solid where near edges, hole in center.
//   Fabric color: base diffuse from material; only alpha is modified here.
// =============================================================================

// HATLAB_SECTION_BEGIN vertex_after_common
attribute vec4 laserEdgeDistMm;
attribute vec2 laserPlaneMm;
varying vec4 vLaserEdgeDistMm;
varying vec2 vLaserPlaneMm;
// HATLAB_SECTION_END vertex_after_common

// HATLAB_SECTION_BEGIN vertex_after_uv_vertex
vLaserEdgeDistMm = laserEdgeDistMm;
vLaserPlaneMm = laserPlaneMm;
// HATLAB_SECTION_END vertex_after_uv_vertex

// HATLAB_SECTION_BEGIN fragment_after_common
varying vec4 vLaserEdgeDistMm;
varying vec2 vLaserPlaneMm;
uniform int uLaserProcMode;
uniform float uLaserPitchMm;
uniform float uLaserSeamExcludeMm;
uniform float uLaserRimExcludeMm;
uniform float uLaserClosureExcludeMm;
// HATLAB_SECTION_END fragment_after_common

// HATLAB_SECTION_BEGIN fragment_color_fragment
vec2 cellUv = fract( vLaserPlaneMm / uLaserPitchMm );
vec2 q = cellUv - 0.5;
float procAlpha = 1.0;
float rHole = 1.0 / 6.0;
if (uLaserProcMode == 0 || uLaserProcMode == 1) {
  procAlpha = step(rHole, length(q));
} else if (uLaserProcMode == 2) {
  vec2 u = (cellUv - 0.5) * 3.0 + 0.5;
  if (u.x < 0.0 || u.x > 1.0 || u.y < 0.0 || u.y > 1.0) {
    procAlpha = 1.0;
  } else {
  float cx = 0.5;
  float cy = 0.58;
  float R = 0.36;
  float distC = length(u - vec2(cx, cy));
  float inC = 1.0 - step(R, distC);
  float tipY = 0.06;
  float baseY = cy - R * 0.35;
  float hw = R * 1.15;
  vec2 ta = vec2(cx, tipY);
  vec2 tb = vec2(cx - hw, baseY);
  vec2 tc = vec2(cx + hw, baseY);
  vec2 v0 = tc - ta;
  vec2 v1 = tb - ta;
  vec2 v2 = u - ta;
  float dot00 = dot(v0, v0);
  float dot01 = dot(v0, v1);
  float dot02 = dot(v0, v2);
  float dot11 = dot(v1, v1);
  float dot12 = dot(v1, v2);
  float denom = dot00 * dot11 - dot01 * dot01;
  float invD = abs(denom) > 1e-8 ? (1.0 / denom) : 0.0;
  float fu = (dot11 * dot02 - dot01 * dot12) * invD;
  float fv = (dot00 * dot12 - dot01 * dot02) * invD;
  float inTri = step(0.0, fu) * step(0.0, fv) * (1.0 - step(1.0, fu + fv));
  float inTd = max(inC, inTri);
  procAlpha = 1.0 - inTd;
  }
} else if (uLaserProcMode == 3) {
  vec2 u = (cellUv - 0.5) * 3.0 + 0.5;
  if (u.x < 0.0 || u.x > 1.0 || u.y < 0.0 || u.y > 1.0) {
    procAlpha = 1.0;
  } else {
  vec2 c = vec2(0.5);
  float hw = 0.42;
  float hh = 0.42;
  float d = abs(u.x - c.x) / hw + abs(u.y - c.y) / hh;
  float inDm = 1.0 - step(1.0, d);
  procAlpha = 1.0 - inDm;
  }
} else if (uLaserProcMode == 4) {
  // Mesh (net): orthogonal struts — solid on cell edges, hole in center.
  // Strut width as fraction of cell (0–0.5); must stay < 0.5 so center remains a hole.
  float t = 0.11;
  float solid = 0.0;
  if (cellUv.x < t || cellUv.x > 1.0 - t) solid = 1.0;
  if (cellUv.y < t || cellUv.y > 1.0 - t) solid = 1.0;
  procAlpha = solid;
}
float laserEdgeMask = step(uLaserSeamExcludeMm, min(vLaserEdgeDistMm.x, vLaserEdgeDistMm.y)) * step(uLaserRimExcludeMm, vLaserEdgeDistMm.z) * step(uLaserClosureExcludeMm, vLaserEdgeDistMm.w);
diffuseColor.a = mix(1.0, procAlpha, laserEdgeMask);
// HATLAB_SECTION_END fragment_color_fragment
