/**
 * Keep in sync with {@link SEAM_TAPE_WIDTH_M} in seamTapeMesh and SWEATBAND_HEIGHT_M in
 * sweatbandMesh (avoid circular imports with crownMesh).
 */
const SEAM_TAPE_WIDTH_M = 0.014;
const SWEATBAND_HEIGHT_M = 0.9375 * 0.0254;

/** Small clearance (m) beyond physical tape/sweatband so the mask clears the decoration. */
const LASER_MASK_MARGIN_M = 0.0005;

/**
 * Extra inset (mm) beyond physical tape/sweatband so the no-etch band reads wider on the crown.
 */
const LASER_EXTRA_EXCLUDE_INSET_MM = 10;

/**
 * Minimum distance (mm) from a side seam for laser etch holes (half tape + margin).
 * Matches treating the mask as distance from panel edges in UV space.
 */
export const LASER_EXCLUDE_FROM_SEAM_MM =
  (SEAM_TAPE_WIDTH_M * 0.5 + LASER_MASK_MARGIN_M) * 1000 +
  LASER_EXTRA_EXCLUDE_INSET_MM;

/**
 * Minimum distance (mm) from the rim (sweatband band) for laser etch holes.
 */
export const LASER_EXCLUDE_FROM_RIM_MM =
  (SWEATBAND_HEIGHT_M + LASER_MASK_MARGIN_M) * 1000 +
  LASER_EXTRA_EXCLUDE_INSET_MM;

/** Same band as side seams: rear closure arch seam tape (see seam tape over stadium cut). */
export const LASER_EXCLUDE_FROM_CLOSURE_MM = LASER_EXCLUDE_FROM_SEAM_MM;

/** Inner crown shell: no tape/sweatband mask (multiply mask to 1 everywhere). */
export const LASER_MASK_INNER_SHELL_MM = 1e6;
