import * as THREE from "three";
import {
  LASER_EXCLUDE_FROM_CLOSURE_MM,
  LASER_EXCLUDE_FROM_RIM_MM,
  LASER_EXCLUDE_FROM_SEAM_MM,
} from "@/lib/hat/laserEtchMask";
import type { RearLaserEtchMode } from "@/lib/hat/rearLaserEtch";
import {
  PROCEDURAL_LASER_FRAGMENT_AFTER_COMMON,
  PROCEDURAL_LASER_FRAGMENT_COLOR_FRAGMENT,
  PROCEDURAL_LASER_VERTEX_AFTER_COMMON,
  PROCEDURAL_LASER_VERTEX_AFTER_UV_VERTEX,
} from "@/lib/hat/shaders/extractProceduralLaserEtchSections";

/**
 * Center-to-center pitch (mm): holeDiameter + gap, with gap = 2 * holeDiameter
 * (e.g. 1mm hole, 2mm gap, 3mm pitch; 2mm hole, 4mm gap, 6mm pitch).
 */
const pitchMmFromHoleDiameter = (holeDiameterMm: number) => 3 * holeDiameterMm;

/** Circle modes: physical hole diameter (mm). */
const CIRCLE_1MM_DIAMETER_MM = 1;
const CIRCLE_2MM_DIAMETER_MM = 2;

/** Teardrop: nominal hole diameter (mm) for the same pitch rule. */
const TEARDROP_HOLE_DIAMETER_MM = 4;

/**
 * Diamond grid: tighter center-to-center spacing than 3 * nominal diameter (12mm).
 * Smaller pitch = less gap between diamond holes.
 */
const DIAMOND_PITCH_MM = 8;

/**
 * Orthogonal net (Mesh / net): repeat cell size in mm. Strut width is fixed in the shader
 * (fraction of cell — see proceduralLaserEtch.glsl).
 */
const NET_MESH_PITCH_MM = 4;

export const LASER_PROC_MODE_CIRCLE1 = 0;
export const LASER_PROC_MODE_CIRCLE2 = 1;
export const LASER_PROC_MODE_TEARDROP = 2;
export const LASER_PROC_MODE_DIAMOND = 3;
export const LASER_PROC_MODE_MESH = 4;

export function laserProcModeInt(mode: RearLaserEtchMode): number {
  switch (mode) {
    case "circle1mm":
      return LASER_PROC_MODE_CIRCLE1;
    case "circle2mm":
      return LASER_PROC_MODE_CIRCLE2;
    case "teardrop":
      return LASER_PROC_MODE_TEARDROP;
    case "diamond":
      return LASER_PROC_MODE_DIAMOND;
    case "mesh":
      return LASER_PROC_MODE_MESH;
    default:
      return LASER_PROC_MODE_CIRCLE1;
  }
}

/** Physical pitch (mm) between motif centers for the current mode. */
export function pitchMmForLaserMode(mode: RearLaserEtchMode): number {
  switch (mode) {
    case "circle1mm":
      return pitchMmFromHoleDiameter(CIRCLE_1MM_DIAMETER_MM);
    case "circle2mm":
      return pitchMmFromHoleDiameter(CIRCLE_2MM_DIAMETER_MM);
    case "teardrop":
      return pitchMmFromHoleDiameter(TEARDROP_HOLE_DIAMETER_MM);
    case "diamond":
      return DIAMOND_PITCH_MM;
    case "mesh":
      return NET_MESH_PITCH_MM;
    default:
      return 3;
  }
}

/** @deprecated Use {@link pitchMmForLaserMode}; kept for any external callers. */
export function cellRepeatForLaserMode(mode: RearLaserEtchMode): number {
  return pitchMmForLaserMode(mode);
}

/**
 * Procedural laser etch (no alphaMap): sets diffuse alpha from physical panel plane (mm) + masks.
 * Requires `laserEdgeDistMm` (vec4) and `laserPlaneMm` (vec2) on geometry (see crownMesh).
 */
export function applyProceduralLaserEtchMaterial(
  mat: THREE.MeshStandardMaterial,
  mode: RearLaserEtchMode,
): void {
  const modeInt = laserProcModeInt(mode);
  const pitchMm = pitchMmForLaserMode(mode);

  mat.customProgramCacheKey = () =>
    `procLaser:${modeInt}:${pitchMm}:${LASER_EXCLUDE_FROM_SEAM_MM}:${LASER_EXCLUDE_FROM_RIM_MM}:${LASER_EXCLUDE_FROM_CLOSURE_MM}`;

  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uLaserProcMode = { value: modeInt };
    shader.uniforms.uLaserPitchMm = { value: pitchMm };
    shader.uniforms.uLaserSeamExcludeMm = {
      value: LASER_EXCLUDE_FROM_SEAM_MM,
    };
    shader.uniforms.uLaserRimExcludeMm = {
      value: LASER_EXCLUDE_FROM_RIM_MM,
    };
    shader.uniforms.uLaserClosureExcludeMm = {
      value: LASER_EXCLUDE_FROM_CLOSURE_MM,
    };

    shader.vertexShader = shader.vertexShader
      .replace(
        "#include <common>",
        `#include <common>
${PROCEDURAL_LASER_VERTEX_AFTER_COMMON}`,
      )
      .replace(
        "#include <uv_vertex>",
        `#include <uv_vertex>
${PROCEDURAL_LASER_VERTEX_AFTER_UV_VERTEX}`,
      );

    shader.fragmentShader = shader.fragmentShader
      .replace(
        "#include <common>",
        `#include <common>
${PROCEDURAL_LASER_FRAGMENT_AFTER_COMMON}`,
      )
      .replace(
        "#include <color_fragment>",
        `#include <color_fragment>
${PROCEDURAL_LASER_FRAGMENT_COLOR_FRAGMENT}`,
      );
  };
}
