import proceduralLaserEtchGlsl from "@/lib/hat/shaders/proceduralLaserEtch.glsl";

/** Full `proceduralLaserEtch.glsl` source (for tooling or re-use). */
export const PROCEDURAL_LASER_ETCH_GLSL_SOURCE = proceduralLaserEtchGlsl;

function extractSection(source: string, name: string): string {
  const begin = `// HATLAB_SECTION_BEGIN ${name}`;
  const end = `// HATLAB_SECTION_END ${name}`;
  const i0 = source.indexOf(begin);
  if (i0 < 0) {
    throw new Error(`proceduralLaserEtch.glsl: missing section "${name}"`);
  }
  const i1 = source.indexOf(end, i0 + begin.length);
  if (i1 < 0) {
    throw new Error(`proceduralLaserEtch.glsl: unclosed section "${name}"`);
  }
  const body = source.slice(i0 + begin.length, i1).replace(/^\r?\n/, "");
  return body;
}

/** Injects after `#include <common>` in the Three.js vertex shader. */
export const PROCEDURAL_LASER_VERTEX_AFTER_COMMON = extractSection(
  proceduralLaserEtchGlsl,
  "vertex_after_common",
);

/** Injects after `#include <uv_vertex>` in the Three.js vertex shader. */
export const PROCEDURAL_LASER_VERTEX_AFTER_UV_VERTEX = extractSection(
  proceduralLaserEtchGlsl,
  "vertex_after_uv_vertex",
);

/** Injects after `#include <common>` in the Three.js fragment shader. */
export const PROCEDURAL_LASER_FRAGMENT_AFTER_COMMON = extractSection(
  proceduralLaserEtchGlsl,
  "fragment_after_common",
);

/** Replaces `#include <color_fragment>` in the Three.js fragment shader. */
export const PROCEDURAL_LASER_FRAGMENT_COLOR_FRAGMENT = extractSection(
  proceduralLaserEtchGlsl,
  "fragment_color_fragment",
);
