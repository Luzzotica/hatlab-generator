import * as THREE from "three";
import {
  buildSkeleton,
  effectiveVisorHalfSpanRad,
  frontCenterSeamIndex,
  frontRisePanelIndices,
  frontGuideAlpha,
  frontGuideArcAndVIndices,
  sampleSeamWireframe,
  sampleVToArcGuideMeridian,
  sweatbandPoint,
  sweatbandPolyline,
  type BuiltSkeleton,
  type HatSkeletonSpec,
} from "@/lib/skeleton";
import {
  buildCrownPanelGeometries,
  buildInnerFrontRiseGeometries,
  crownArcSegments,
  crownVerticalRings,
  ruledSurfaceVertexBetweenSeams,
} from "@/lib/mesh/crownMesh";
import {
  BACK_CLOSURE_WIDTH_M,
  BACK_CLOSURE_TAPE_MARGIN_M,
  getBackClosureOpeningFrame,
  getClosureCutterOutline,
  getRearClosureAdjacentPanelIndices,
} from "@/lib/mesh/backClosureSubtract";
import {
  buildSweatbandGeometry,
  type BackClosureTuckLiftParams,
  type VisorTuckLiftParams,
} from "@/lib/mesh/sweatbandMesh";
import { rimWorldXYToSweatbandTheta } from "@/lib/mesh/sweatbandMesh";
import {
  buildVisorGeometry,
  buildVisorTopBottomGeometries,
  buildVisorTuckGeometry,
  buildVisorFilletGeometry,
  evalVisorRuledPointWorld,
  evalVisorRuledTopWorld,
  VISOR_THICKNESS_M,
  VISOR_TUCK_HEIGHT_M,
} from "@/lib/mesh/visorMesh";
import { buildSeamTapeGroup } from "@/lib/hat/seamTapeMesh";
import type { VisorThreadingGeometries } from "@/lib/hat/visorThreadProjection";
import { buildThreadingGroup } from "@/lib/hat/threadingMesh";
import { buildBillRopeGroup } from "@/lib/hat/billRopeMesh";
import { buildEyeletGroup } from "@/lib/hat/eyeletMesh";
import { buildClosureGroup } from "@/lib/hat/buildClosureGroup";
import { neutralizeExportMaterialTree } from "@/lib/export/hatExportTextures";
import { buildHatVariantSpec } from "@/lib/export/buildHatVariantSpec";
import type { HatDocument, VisorShapeIndex } from "@/lib/hat/hatDocument";

const SEAM_SEGMENTS = 40;

/**
 * When true, viewer adds guide lines (rim, seam wireframes, orange ruler grid, visor outline, apex cross).
 * Set false to inspect the solid mesh only (crown indent, shading, etc.).
 */
const SHOW_HAT_DEBUG_LINES = false;

/**
 * Ruled-bill overlay (rim, outer, cyan rulings, iso-d paths).
 * Independent of {@link SHOW_HAT_DEBUG_LINES}.
 */
const SHOW_VISOR_RULED_BILL_DEBUG = false;

/**
 * Iso-d paths: trim span from each tip; see {@link buildVisorRuledBillDebugGroup}.
 */
const VISOR_DEBUG_ISO_D_SPAN_INSET = 0.12;

/** Cyan V→side lerp meridians (only if {@link SHOW_HAT_DEBUG_LINES}). */
const SHOW_FRONT_V_TO_ARC_GUIDES = false;

/** Slight radial push so guide lines draw on top of the mesh (same path as vertices). */
const FRONT_GUIDE_RADIAL_OFFSET = 0.002;

function offsetRadialOutward(
  p: [number, number, number],
): [number, number, number] {
  const len = Math.hypot(p[0], p[1], p[2]);
  if (len < 1e-10) return p;
  const s = 1 + FRONT_GUIDE_RADIAL_OFFSET / len;
  return [p[0] * s, p[1] * s, p[2] * s];
}

/** Panels that flank the front center seam (V): each gets lerp lines from side seam ↔ front seam. */
function frontNeighborPanelIndices(
  nSeams: number,
  frontSeamIdx: number,
): [number, number] {
  if (nSeams === 6) {
    return [(frontSeamIdx - 1 + nSeams) % nSeams, frontSeamIdx];
  }
  return [(nSeams - 1) % nSeams, 0];
}

function lineStripToBuffer(
  points: [number, number, number][],
): THREE.BufferGeometry {
  const pos = new Float32Array(points.length * 3);
  for (let i = 0; i < points.length; i++) {
    const p = points[i]!;
    pos[i * 3] = p[0];
    pos[i * 3 + 1] = p[1];
    pos[i * 3 + 2] = p[2];
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  return geo;
}

function lineLoopToSegmentsBuffer(
  points: [number, number, number][],
): THREE.BufferGeometry {
  const n = points.length;
  const pos = new Float32Array(n * 2 * 3);
  for (let i = 0; i < n; i++) {
    const a = points[i]!;
    const b = points[(i + 1) % n]!;
    const o = i * 6;
    pos[o] = a[0];
    pos[o + 1] = a[1];
    pos[o + 2] = a[2];
    pos[o + 3] = b[0];
    pos[o + 4] = b[1];
    pos[o + 5] = b[2];
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  return geo;
}

function bumpVisorDebugZ(p: [number, number, number]): [number, number, number] {
  return [p[0], p[1], p[2] + 0.003];
}

/**
 * Debug lines for the ruled bill: `s` = span, `d` = depth (rim→outer).
 * Uses depthTest: false so lines stay visible over the visor mesh.
 */
function buildVisorRuledBillDebugGroup(sk: BuiltSkeleton): THREE.Group {
  const g = new THREE.Group();
  g.name = "Debug_Visor_RuledBill";
  if (sk.visorPolyline.length < 2) return g;

  const alongS = 64;
  const lineMatOpts = { depthTest: false as const, depthWrite: false };

  const rimStrip: [number, number, number][] = [];
  const outerBotStrip: [number, number, number][] = [];
  const outerTopStrip: [number, number, number][] = [];
  for (let i = 0; i < alongS; i++) {
    const s = alongS <= 1 ? 0 : i / (alongS - 1);
    rimStrip.push(bumpVisorDebugZ(evalVisorRuledPointWorld(sk, s, 0)));
    outerBotStrip.push(bumpVisorDebugZ(evalVisorRuledPointWorld(sk, s, 1)));
    outerTopStrip.push(bumpVisorDebugZ(evalVisorRuledTopWorld(sk, s, 1)));
  }

  const lineRim = new THREE.Line(
    lineStripToBuffer(rimStrip),
    new THREE.LineBasicMaterial({ color: 0x22c55e, ...lineMatOpts }),
  );
  lineRim.name = "RuledBill_Rim_d0_bottom";
  lineRim.renderOrder = 999;
  g.add(lineRim);

  const lineOuterBot = new THREE.Line(
    lineStripToBuffer(outerBotStrip),
    new THREE.LineBasicMaterial({ color: 0xd946ef, ...lineMatOpts }),
  );
  lineOuterBot.name = "RuledBill_Outer_d1_bottom";
  lineOuterBot.renderOrder = 999;
  g.add(lineOuterBot);

  const lineOuterTop = new THREE.Line(
    lineStripToBuffer(outerTopStrip),
    new THREE.LineBasicMaterial({
      color: 0xf5f5f4,
      transparent: true,
      opacity: 0.9,
      ...lineMatOpts,
    }),
  );
  lineOuterTop.name = "RuledBill_Outer_d1_top";
  lineOuterTop.renderOrder = 999;
  g.add(lineOuterTop);

  const nRulings = 13;
  const rulingPos: number[] = [];
  for (let r = 0; r < nRulings; r++) {
    const s = nRulings <= 1 ? 0 : r / (nRulings - 1);
    const a = bumpVisorDebugZ(evalVisorRuledPointWorld(sk, s, 0));
    const b = bumpVisorDebugZ(evalVisorRuledPointWorld(sk, s, 1));
    rulingPos.push(a[0], a[1], a[2], b[0], b[1], b[2]);
  }
  const rulingGeo = new THREE.BufferGeometry();
  rulingGeo.setAttribute(
    "position",
    new THREE.BufferAttribute(new Float32Array(rulingPos), 3),
  );
  const rulings = new THREE.LineSegments(
    rulingGeo,
    new THREE.LineBasicMaterial({ color: 0x38bdf8, ...lineMatOpts }),
  );
  rulings.name = "RuledBill_Rulings_fixed_s";
  rulings.renderOrder = 999;
  g.add(rulings);

  const isoDs: { d: number; color: number; label: string }[] = [
    { d: 0.25, color: 0xfacc15, label: "iso_d_0.25" },
    { d: 0.5, color: 0xfb923c, label: "iso_d_0.5" },
    { d: 0.75, color: 0xa3e635, label: "iso_d_0.75" },
  ];
  const inset = Math.max(0, Math.min(0.45, VISOR_DEBUG_ISO_D_SPAN_INSET));
  const sIsoMin = inset;
  const sIsoMax = 1 - inset;
  for (const { d, color, label } of isoDs) {
    // Only the fixed-d locus in s — no straight "ruling" segments to the rim. Those segments
    // met ∂P/∂s at a corner (∂P/∂d ≠ ∂P/∂s), so cyan rulings looked like they "cut off" the curve.
    const strip: [number, number, number][] = [];
    for (let i = 0; i < alongS; i++) {
      const s = sIsoMin + (i / (alongS - 1)) * (sIsoMax - sIsoMin);
      strip.push(bumpVisorDebugZ(evalVisorRuledPointWorld(sk, s, d)));
    }
    const line = new THREE.Line(
      lineStripToBuffer(strip),
      new THREE.LineBasicMaterial({ color, ...lineMatOpts }),
    );
    line.name = `RuledBill_${label}_iso_d_curve`;
    line.renderOrder = 999;
    g.add(line);
  }

  return g;
}

/** Model units are meters; snap-style crown button total height. */
const TOP_BUTTON_HEIGHT_M = 0.004;
/** Shift entire button toward −Z (skeleton down) from the apex. */
const TOP_BUTTON_OFFSET_DOWN_M = 0.002;

/**
 * Crown button with domed top and concave underside.
 * Lathe is Y-up; rotated so Y → skeleton +Z. Dome peak sits at apex. Parent Hat applies −90° X.
 */
function buildTopButtonMesh(sk: BuiltSkeleton): THREE.Mesh {
  const ax = sk.apex;
  const scale = Math.hypot(sk.spec.semiAxisX, sk.spec.semiAxisY);
  const R = Math.max(0.006, 0.04 * scale);
  const H = TOP_BUTTON_HEIGHT_M;
  const domeH = H * 0.45;
  const wallH = H * 0.2;
  const concH = H * 0.35;

  const profile: THREE.Vector2[] = [
    // concave underside (center → rim)
    new THREE.Vector2(0, 0),
    new THREE.Vector2(R * 0.25, concH * 0.08),
    new THREE.Vector2(R * 0.5, concH * 0.3),
    new THREE.Vector2(R * 0.75, concH * 0.62),
    new THREE.Vector2(R * 0.92, concH * 0.9),
    new THREE.Vector2(R, concH),
    // outer wall (vertical-ish)
    new THREE.Vector2(R, concH + wallH),
    // domed top (rim → center, curving upward)
    new THREE.Vector2(R * 0.92, concH + wallH + domeH * 0.28),
    new THREE.Vector2(R * 0.75, concH + wallH + domeH * 0.6),
    new THREE.Vector2(R * 0.55, concH + wallH + domeH * 0.82),
    new THREE.Vector2(R * 0.3, concH + wallH + domeH * 0.95),
    new THREE.Vector2(0, concH + wallH + domeH),
  ];

  const geo = new THREE.LatheGeometry(profile, 48);

  const mat = new THREE.MeshStandardMaterial({
    color: 0x374151,
    flatShading: false,
    side: THREE.DoubleSide,
    metalness: 0.12,
    roughness: 0.82,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = "TopButton";
  mesh.rotation.x = Math.PI / 2;
  mesh.position.set(ax[0], ax[1], ax[2] - TOP_BUTTON_OFFSET_DOWN_M);
  return mesh;
}

/**
 * Inward tuck peaked at each closure rail (half the visor slab thickness); sweatband applies a
 * vertical-edge profile so rim and top stay on the crown column.
 */
function backClosureTuckLiftParams(
  sk: BuiltSkeleton,
): BackClosureTuckLiftParams | undefined {
  if (!sk.spec.backClosureOpening || sk.spec.closures.length === 0) return undefined;
  const { tW, rimAnchor } = getBackClosureOpeningFrame(sk);
  const halfW = (BACK_CLOSURE_WIDTH_M + BACK_CLOSURE_TAPE_MARGIN_M) * 0.5 + 0.01;
  const leftPt: [number, number, number] = [
    rimAnchor[0] - halfW * tW[0],
    rimAnchor[1] - halfW * tW[1],
    rimAnchor[2] - halfW * tW[2],
  ];
  const rightPt: [number, number, number] = [
    rimAnchor[0] + halfW * tW[0],
    rimAnchor[1] + halfW * tW[1],
    rimAnchor[2] + halfW * tW[2],
  ];
  const spec = sk.spec;
  const thetaL = rimWorldXYToSweatbandTheta(spec, leftPt[0], leftPt[1]);
  const thetaR = rimWorldXYToSweatbandTheta(spec, rightPt[0], rightPt[1]);
  const rail: Omit<VisorTuckLiftParams, "thetaCenter"> = {
    halfSpanRad: 0.34,
    liftAmount: VISOR_THICKNESS_M,
    liftHeightM: VISOR_TUCK_HEIGHT_M,
    blendAngleRad: 0.12,
  };
  return {
    left: { thetaCenter: thetaL, ...rail },
    right: { thetaCenter: thetaR, ...rail },
  };
}

function visorTuckLiftParams(
  sk: BuiltSkeleton,
): VisorTuckLiftParams | undefined {
  if (sk.visorPolyline.length < 2) return undefined;
  const spec = sk.spec;
  const halfSpan = effectiveVisorHalfSpanRad(
    spec.visor,
    spec.nSeams,
    sk.angles,
  );
  return {
    thetaCenter: spec.visor.attachAngleRad,
    halfSpanRad: halfSpan,
    liftAmount: VISOR_THICKNESS_M,
    liftHeightM: VISOR_TUCK_HEIGHT_M,
    blendAngleRad: 0.05,
  };
}

/** Inner front rise liner (split from crown shells); drawn before sweatband and seam tape. */
function buildInnerFrontRiseGroup(
  sk: BuiltSkeleton,
  matOverride?: THREE.MeshStandardMaterial,
): THREE.Group {
  const mat =
    matOverride ??
    new THREE.MeshStandardMaterial({
      color: 0x00f0ff,
      emissive: 0x003844,
      emissiveIntensity: 0.35,
      flatShading: false,
      side: THREE.DoubleSide,
      metalness: 0.06,
      roughness: 0.55,
    });
  const geos = buildInnerFrontRiseGeometries(sk);
  const group = new THREE.Group();
  group.name = "InnerFrontRise";
  geos.forEach((geo, i) => {
    const mesh = new THREE.Mesh(geo, mat);
    mesh.name = `InnerFrontRise_${i}`;
    group.add(mesh);
  });
  return group;
}

/** Full hat: crown mesh + optional debug guides when `SHOW_HAT_DEBUG_LINES` is true. */
export function buildHatGroup(sk: BuiltSkeleton): THREE.Group {
  const root = new THREE.Group();
  root.name = "Hat";
  // Skeleton is built in +Z up (+Y forward). Rotate −90° about X so the hat sits Y-up in Three.js
  // (rim horizontal in XZ, crown toward +Y) instead of lying on its side in the default view.
  root.rotation.x = -Math.PI / 2;

  const crownMat = new THREE.MeshStandardMaterial({
    color: 0x6b7280,
    flatShading: false,
    side: THREE.DoubleSide,
    metalness: 0.1,
    roughness: 0.85,
  });
  const panelGeos = buildCrownPanelGeometries(sk);
  const crownGroup = new THREE.Group();
  crownGroup.name = "Crown";
  panelGeos.forEach((geo, i) => {
    const mesh = new THREE.Mesh(geo, crownMat);
    mesh.name = `Panel_${i}`;
    crownGroup.add(mesh);
  });
  root.add(crownGroup);
  if (sk.spec.eyeletStyle !== "none") {
    root.add(buildEyeletGroup(sk, panelGeos));
  }
  root.add(buildInnerFrontRiseGroup(sk));
  root.add(buildTopButtonMesh(sk));

  if (SHOW_HAT_DEBUG_LINES) {
    const M = crownArcSegments(sk.spec);
    const N = crownVerticalRings(sk.spec);
    const mat = new THREE.LineBasicMaterial({
      color: 0xffaa00,
      depthTest: true,
      transparent: true,
      opacity: 0.9,
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -1,
    });
    const nSeams = sk.spec.nSeams;
    for (let panel = 0; panel < nSeams; panel++) {
      for (let j = 0; j <= M; j += 2) {
        const pts: [number, number, number][] = [];
        for (let k = 0; k <= N; k++) {
          pts.push(ruledSurfaceVertexBetweenSeams(sk, panel, j, k, M, N));
        }
        const line = new THREE.Line(lineStripToBuffer(pts), mat);
        line.renderOrder = 3;
        line.name = `CrownRulerMeridian_p${panel}_j${j}`;
        root.add(line);
      }
      if (M % 2 === 1) {
        const pts: [number, number, number][] = [];
        for (let k = 0; k <= N; k++) {
          pts.push(ruledSurfaceVertexBetweenSeams(sk, panel, M, k, M, N));
        }
        const line = new THREE.Line(lineStripToBuffer(pts), mat);
        line.renderOrder = 3;
        line.name = `CrownRulerMeridian_p${panel}_j${M}`;
        root.add(line);
      }
      for (let k = 0; k <= N; k += 2) {
        const pts: [number, number, number][] = [];
        for (let j = 0; j <= M; j++) {
          pts.push(ruledSurfaceVertexBetweenSeams(sk, panel, j, k, M, N));
        }
        const line = new THREE.Line(lineStripToBuffer(pts), mat);
        line.renderOrder = 3;
        line.name = `CrownRulerRing_p${panel}_k${k}`;
        root.add(line);
      }
      if (N % 2 === 1) {
        const pts: [number, number, number][] = [];
        for (let j = 0; j <= M; j++) {
          pts.push(ruledSurfaceVertexBetweenSeams(sk, panel, j, N, M, N));
        }
        const line = new THREE.Line(lineStripToBuffer(pts), mat);
        line.renderOrder = 3;
        line.name = `CrownRulerRing_p${panel}_k${N}`;
        root.add(line);
      }
    }
  }

  const liftParams = visorTuckLiftParams(sk);
  const sweatbandGeo = buildSweatbandGeometry(sk, {
    closure: sk.spec.backClosureOpening === true,
    lift: liftParams,
    backClosureTuck: backClosureTuckLiftParams(sk),
  });
  const sweatband = new THREE.Mesh(
    sweatbandGeo,
    new THREE.MeshStandardMaterial({
      color: 0xff00ff,
      flatShading: false,
      side: THREE.DoubleSide,
      metalness: 0.05,
      roughness: 0.92,
    }),
  );
  sweatband.name = "Sweatband";
  sweatband.renderOrder = 3;
  root.add(sweatband);

  let visorSlabGeometries: VisorThreadingGeometries | undefined;
  if (sk.visorPolyline.length >= 2) {
    const { top, bottom } = buildVisorTopBottomGeometries(sk, {
      omitInnerRimInTop: true,
    });
    visorSlabGeometries = { top, bottom };
  }

  const seamTape = buildSeamTapeGroup(sk);
  root.add(seamTape);

  const threading = buildThreadingGroup(sk, visorSlabGeometries);
  root.add(threading);

  root.add(buildClosureGroup(sk));

  if (SHOW_HAT_DEBUG_LINES) {
    const rimPts = sweatbandPolyline(sk.spec, 96);
    const rimGeo = lineLoopToSegmentsBuffer(rimPts);
    const rim = new THREE.LineSegments(
      rimGeo,
      new THREE.LineBasicMaterial({ color: 0x9ca3af }),
    );
    rim.name = "RimGuide";
    root.add(rim);

    if (sk.spec.backClosureOpening) {
      const cutterPts = getClosureCutterOutline(sk);
      cutterPts.push(cutterPts[0]!);
      const cutterGeo = lineStripToBuffer(cutterPts);
      const cutterLine = new THREE.Line(
        cutterGeo,
        new THREE.LineBasicMaterial({ color: 0xff0000, linewidth: 2 }),
      );
      cutterLine.name = "ClosureCutterOutline";
      cutterLine.renderOrder = 5;
      root.add(cutterLine);
    }

    const bottomHandleMat = new THREE.LineBasicMaterial({
      color: 0x22c55e,
      linewidth: 2,
    });
    const topHandleMat = new THREE.LineBasicMaterial({
      color: 0xec4899,
      linewidth: 2,
    });

    for (let i = 0; i < sk.spec.nSeams; i++) {
      const strip = sampleSeamWireframe(sk.seamControls[i]!, SEAM_SEGMENTS);
      const geo = lineStripToBuffer(strip);
      const line = new THREE.Line(
        geo,
        new THREE.LineBasicMaterial({ color: 0x3b82f6 }),
      );
      line.name = `Seam_${i}`;
      root.add(line);

      const sc = sk.seamControls[i]!;
      if (sc.kind === "cubic") {
        const [p0, p1, p2, p3] = sc.ctrl;
        const bottomGeo = lineStripToBuffer([
          [p0[0], p0[1], p0[2]],
          [p1[0], p1[1], p1[2]],
        ]);
        const bottomLine = new THREE.Line(bottomGeo, bottomHandleMat);
        bottomLine.name = `SeamHandle_bottom_${i}`;
        bottomLine.renderOrder = 4;
        root.add(bottomLine);

        const topGeo = lineStripToBuffer([
          [p3[0], p3[1], p3[2]],
          [p2[0], p2[1], p2[2]],
        ]);
        const topLine = new THREE.Line(topGeo, topHandleMat);
        topLine.name = `SeamHandle_top_${i}`;
        topLine.renderOrder = 4;
        root.add(topLine);
      }
    }
  }

  if (
    SHOW_HAT_DEBUG_LINES &&
    SHOW_FRONT_V_TO_ARC_GUIDES &&
    sk.spec.frontVSplit != null
  ) {
    const frontSeamIdx = frontCenterSeamIndex(sk.spec.nSeams);
    const [pa, pb] = frontNeighborPanelIndices(sk.spec.nSeams, frontSeamIdx);
    const M = crownArcSegments(sk.spec);
    const N = crownVerticalRings(sk.spec);
    const vBlend = sk.spec.frontVSplit.blend;
    const opacity = Math.max(0.35, Math.min(1, 0.4 + 0.55 * vBlend));
    const mat = new THREE.LineBasicMaterial({
      color: 0x60a5fa,
      transparent: true,
      opacity,
      depthTest: true,
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -1,
    });

    const addPanelLerpLines = (panelIdx: number) => {
      const nSeams = sk.spec.nSeams;
      const [seamArcIdx, seamVIdx] = frontGuideArcAndVIndices(
        panelIdx,
        frontSeamIdx,
        nSeams,
      );
      for (let j = 1; j < M; j++) {
        const alpha = frontGuideAlpha(panelIdx, j, M, frontSeamIdx, nSeams);
        const strip = sampleVToArcGuideMeridian(
          sk,
          seamArcIdx,
          seamVIdx,
          alpha,
          N,
        ).map(offsetRadialOutward);
        const geo = lineStripToBuffer(strip);
        const line = new THREE.Line(geo, mat);
        line.renderOrder = 2;
        line.name = `FrontLerp_p${panelIdx}_j${j}`;
        root.add(line);
      }
    };

    addPanelLerpLines(pa);
    addPanelLerpLines(pb);
  }

  if (sk.visorPolyline.length >= 2) {
    const visorMat = new THREE.MeshStandardMaterial({
      color: 0x52525b,
      flatShading: false,
      side: THREE.DoubleSide,
      metalness: 0.08,
      roughness: 0.88,
    });
    const visorBotMat = new THREE.MeshStandardMaterial({
      color: 0x00ffd5,
      emissive: 0x00aa99,
      emissiveIntensity: 0.45,
      flatShading: false,
      side: THREE.DoubleSide,
      metalness: 0.06,
      roughness: 0.55,
    });
    const { top: visorTopGeo, bottom: visorBotGeo } = visorSlabGeometries!;
    const visorGroup = new THREE.Group();
    visorGroup.name = "Visor";
    const visorBot = new THREE.Mesh(visorBotGeo, visorBotMat);
    visorBot.name = "Visor_Bottom";
    visorGroup.add(visorBot);
    const filletGeo = buildVisorFilletGeometry(sk);
    const fillet = new THREE.Mesh(filletGeo, visorBotMat);
    fillet.name = "Visor_Fillet";
    fillet.renderOrder = 2;
    visorGroup.add(fillet);
    const tuckGeo = buildVisorTuckGeometry(sk);
    const tuck = new THREE.Mesh(tuckGeo, visorBotMat);
    tuck.name = "Visor_Tuck";
    tuck.renderOrder = 1;
    visorGroup.add(tuck);
    const visorTop = new THREE.Mesh(visorTopGeo, visorMat);
    visorTop.name = "Visor_Top";
    visorGroup.add(visorTop);
    root.add(visorGroup);
    root.add(buildBillRopeGroup(sk));

    if (SHOW_VISOR_RULED_BILL_DEBUG) {
      root.add(buildVisorRuledBillDebugGroup(sk));
    }
  }

  if (SHOW_HAT_DEBUG_LINES) {
    const visorGeo = lineStripToBuffer(sk.visorPolyline);
    const visor = new THREE.Line(
      visorGeo,
      new THREE.LineBasicMaterial({ color: 0xf97316 }),
    );
    visor.name = "Visor";
    root.add(visor);

    const ax = sk.apex;
    const s = Math.max(
      0.01,
      0.04 * Math.hypot(sk.spec.semiAxisX, sk.spec.semiAxisY),
    );
    const crossPos = new Float32Array([
      ax[0] - s,
      ax[1],
      ax[2],
      ax[0] + s,
      ax[1],
      ax[2],
      ax[0],
      ax[1] - s,
      ax[2],
      ax[0],
      ax[1] + s,
      ax[2],
      ax[0],
      ax[1],
      ax[2] - s,
      ax[0],
      ax[1],
      ax[2] + s,
    ]);
    const crossGeo = new THREE.BufferGeometry();
    crossGeo.setAttribute("position", new THREE.BufferAttribute(crossPos, 3));
    const cross = new THREE.LineSegments(
      crossGeo,
      new THREE.LineBasicMaterial({ color: 0xef4444 }),
    );
    cross.name = "Apex";
    root.add(cross);
  }

  return root;
}

export function buildHatGroupFromSpec(spec: HatSkeletonSpec): THREE.Group {
  return buildHatGroup(buildSkeleton(spec));
}

/** Pitch −90° about local X: skeleton +Z-up → Three.js Y-up (rim in XZ). Applied on the *child* of the export yaw node. */
export const HAT_EXPORT_GROUP_ROOT_ROTATION_X = -Math.PI / 2;
/** Yaw π about world +Y (vertical through the hat) so exported forward matches common DCC / engines. Kept on the *parent* of the pitch node so pitch+yaw are not stored on one Euler (gimbal lock at −90° pitch breaks GLB orientation). */
export const HAT_EXPORT_GROUP_ROOT_ROTATION_Y = Math.PI;

/**
 * Export-only group: physical hat parts only (no debug lines or guide wireframes).
 * Hierarchy: Hat (yaw) → HatExportFrame (pitch) → Crown (Panel_0…N), Eyelets (optional), InnerFrontRise, TopButton, Sweatband, SeamTape (…), Threading, Closures (optional), Visor (Bottom, Fillet, Tuck, Top), BillRope.
 */
export function buildHatExportGroup(spec: HatSkeletonSpec): THREE.Group {
  const sk = buildSkeleton(spec);
  const root = new THREE.Group();
  root.name = "Hat";
  root.rotation.y = HAT_EXPORT_GROUP_ROOT_ROTATION_Y;
  const frame = new THREE.Group();
  frame.name = "HatExportFrame";
  frame.rotation.x = HAT_EXPORT_GROUP_ROOT_ROTATION_X;
  root.add(frame);

  const crownMat = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    flatShading: false,
    side: THREE.DoubleSide,
    metalness: 0,
    roughness: 1,
  });
  const panelGeos = buildCrownPanelGeometries(sk);
  const crownGroup = new THREE.Group();
  crownGroup.name = "Crown";
  panelGeos.forEach((geo, i) => {
    const mesh = new THREE.Mesh(geo, crownMat);
    mesh.name = `Panel_${i}`;
    crownGroup.add(mesh);
  });
  frame.add(crownGroup);
  if (sk.spec.eyeletStyle !== "none") {
    frame.add(buildEyeletGroup(sk, panelGeos));
  }
  frame.add(buildInnerFrontRiseGroup(sk, crownMat));
  frame.add(buildTopButtonMesh(sk));

  const exportLiftParams = visorTuckLiftParams(sk);
  const sweatbandGeo = buildSweatbandGeometry(sk, {
    closure: sk.spec.backClosureOpening === true,
    lift: exportLiftParams,
    backClosureTuck: backClosureTuckLiftParams(sk),
  });
  const sweatbandMat = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    flatShading: false,
    side: THREE.DoubleSide,
    metalness: 0,
    roughness: 1,
  });
  const sweatband = new THREE.Mesh(sweatbandGeo, sweatbandMat);
  sweatband.name = "Sweatband";
  frame.add(sweatband);

  let exportVisorSlabGeometries: VisorThreadingGeometries | undefined;
  if (sk.visorPolyline.length >= 2) {
    const { top, bottom } = buildVisorTopBottomGeometries(sk, {
      omitInnerRimInTop: true,
    });
    exportVisorSlabGeometries = { top, bottom };
  }

  frame.add(buildSeamTapeGroup(sk));
  frame.add(buildThreadingGroup(sk, exportVisorSlabGeometries));
  frame.add(buildClosureGroup(sk));

  if (sk.visorPolyline.length >= 2) {
    const visorMat = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      flatShading: false,
      side: THREE.DoubleSide,
      metalness: 0,
      roughness: 1,
    });
    const visorBotMat = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      emissive: 0x000000,
      emissiveIntensity: 0,
      flatShading: false,
      side: THREE.DoubleSide,
      metalness: 0,
      roughness: 1,
    });
    const { top: visorTopGeo, bottom: visorBotGeo } = exportVisorSlabGeometries!;
    const visorGroup = new THREE.Group();
    visorGroup.name = "Visor";
    const visorBot = new THREE.Mesh(visorBotGeo, visorBotMat);
    visorBot.name = "Visor_Bottom";
    visorGroup.add(visorBot);
    const filletGeo = buildVisorFilletGeometry(sk);
    const fillet = new THREE.Mesh(filletGeo, visorBotMat);
    fillet.name = "Visor_Fillet";
    fillet.renderOrder = 2;
    visorGroup.add(fillet);
    const tuckGeo = buildVisorTuckGeometry(sk);
    const tuck = new THREE.Mesh(tuckGeo, visorBotMat);
    tuck.name = "Visor_Tuck";
    tuck.renderOrder = 1;
    visorGroup.add(tuck);
    const visorTop = new THREE.Mesh(visorTopGeo, visorMat);
    visorTop.name = "Visor_Top";
    visorGroup.add(visorTop);
    frame.add(visorGroup);
    frame.add(buildBillRopeGroup(sk));
  }

  neutralizeExportMaterialTree(root);
  return root;
}

/**
 * Full-hat GLB export: crown in `Crown_Front` / `Crown_Side` / `Crown_Rear` (rear under slots) +
 * two slot groups. `Fitted` holds rear crown (closed), sweatband, seam tape, and threading for
 * no-opening mode; `Closure` holds the same four plus snapback hardware. Toggle `Fitted.visible` /
 * `Closure.visible` to swap modes. Also: inner rise, top button, eyelets, visor. Export pose:
 * parent yaw + child pitch (see {@link buildHatExportGroup}).
 */
export function buildHatExportGroupModular(
  doc: HatDocument,
  visorIndex: VisorShapeIndex,
): THREE.Group {
  const specFitted = buildHatVariantSpec(doc, visorIndex, {
    eyeletStyle: "none",
    closureClosedBack: true,
  });
  const specClosureSurface = buildHatVariantSpec(doc, visorIndex, {
    eyeletStyle: "none",
    closureClosedBack: false,
    includeClosureHardware: false,
  });
  const specClosureHw = buildHatVariantSpec(doc, visorIndex, {
    eyeletStyle: "none",
    closureClosedBack: false,
  });

  const skF = buildSkeleton(specFitted);
  const skC = buildSkeleton(specClosureSurface);
  const skCHw = buildSkeleton(specClosureHw);

  const n = skF.spec.nSeams;
  const { leftPanel, rightPanel } = getRearClosureAdjacentPanelIndices(n);

  const panelGeosF = buildCrownPanelGeometries(skF);
  const panelGeosC = buildCrownPanelGeometries(skC);

  const root = new THREE.Group();
  root.name = "HatExportModular";
  root.rotation.y = HAT_EXPORT_GROUP_ROOT_ROTATION_Y;
  const frame = new THREE.Group();
  frame.name = "HatExportFrame";
  frame.rotation.x = HAT_EXPORT_GROUP_ROOT_ROTATION_X;
  root.add(frame);

  const crownMat = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    flatShading: false,
    side: THREE.DoubleSide,
    metalness: 0,
    roughness: 1,
  });

  const frontPanelSet = new Set(frontRisePanelIndices(n));
  const rearPanelSet = new Set([leftPanel, rightPanel]);

  const crownFront = new THREE.Group();
  crownFront.name = "Crown_Front";
  const crownSide = new THREE.Group();
  crownSide.name = "Crown_Side";
  for (let i = 0; i < n; i++) {
    if (rearPanelSet.has(i)) continue;
    const mesh = new THREE.Mesh(panelGeosF[i]!, crownMat);
    mesh.name = `Panel_${i}`;
    if (frontPanelSet.has(i)) crownFront.add(mesh);
    else crownSide.add(mesh);
  }
  frame.add(crownFront);
  frame.add(crownSide);

  const fitted = new THREE.Group();
  fitted.name = "Fitted";

  const crownRearFitted = new THREE.Group();
  crownRearFitted.name = "Crown_Rear";
  for (const pi of [leftPanel, rightPanel]) {
    const mesh = new THREE.Mesh(panelGeosF[pi]!, crownMat);
    mesh.name = `Panel_${pi}`;
    crownRearFitted.add(mesh);
  }
  fitted.add(crownRearFitted);

  const exportLiftParams = visorTuckLiftParams(skF);
  const sweatbandMat = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    flatShading: false,
    side: THREE.DoubleSide,
    metalness: 0,
    roughness: 1,
  });

  const sweatbandFitted = new THREE.Mesh(
    buildSweatbandGeometry(skF, {
      closure: false,
      lift: exportLiftParams,
      backClosureTuck: undefined,
    }),
    sweatbandMat,
  );
  sweatbandFitted.name = "Sweatband";
  fitted.add(sweatbandFitted);

  let exportVisorSlabGeometries: VisorThreadingGeometries | undefined;
  if (skF.visorPolyline.length >= 2) {
    const { top, bottom } = buildVisorTopBottomGeometries(skF, {
      omitInnerRimInTop: true,
    });
    exportVisorSlabGeometries = { top, bottom };
  }

  const seamTapeFitted = buildSeamTapeGroup(skF);
  seamTapeFitted.name = "SeamTape";
  fitted.add(seamTapeFitted);

  const threadingFitted = buildThreadingGroup(skF, exportVisorSlabGeometries);
  threadingFitted.name = "Threading";
  fitted.add(threadingFitted);

  frame.add(fitted);

  const closure = new THREE.Group();
  closure.name = "Closure";

  const crownRearClosure = new THREE.Group();
  crownRearClosure.name = "Crown_Rear";
  for (const pi of [leftPanel, rightPanel]) {
    const mesh = new THREE.Mesh(panelGeosC[pi]!, crownMat);
    mesh.name = `Panel_${pi}`;
    crownRearClosure.add(mesh);
  }
  closure.add(crownRearClosure);

  const sweatbandClosure = new THREE.Mesh(
    buildSweatbandGeometry(skC, {
      closure: true,
      lift: exportLiftParams,
      backClosureTuck: backClosureTuckLiftParams(skC),
    }),
    sweatbandMat,
  );
  sweatbandClosure.name = "Sweatband";
  closure.add(sweatbandClosure);

  const seamTapeClosure = buildSeamTapeGroup(skC);
  seamTapeClosure.name = "SeamTape";
  closure.add(seamTapeClosure);

  const threadingClosure = buildThreadingGroup(skC, exportVisorSlabGeometries);
  threadingClosure.name = "Threading";
  closure.add(threadingClosure);

  const hardware = buildClosureGroup(skCHw);
  hardware.name = "Hardware";
  closure.add(hardware);

  frame.add(closure);

  frame.add(buildInnerFrontRiseGroup(skF, crownMat));
  frame.add(buildTopButtonMesh(skF));

  const specCloth = buildHatVariantSpec(doc, visorIndex, {
    eyeletStyle: "cloth",
    closureClosedBack: true,
  });
  const skCloth = buildSkeleton(specCloth);
  const pgCloth = buildCrownPanelGeometries(skCloth);
  const eyeletsCloth = buildEyeletGroup(skCloth, pgCloth);
  eyeletsCloth.name = "Eyelets_Cloth";
  frame.add(eyeletsCloth);

  const specMetal = buildHatVariantSpec(doc, visorIndex, {
    eyeletStyle: "metal",
    closureClosedBack: true,
  });
  const skMetal = buildSkeleton(specMetal);
  const pgMetal = buildCrownPanelGeometries(skMetal);
  const eyeletsMetal = buildEyeletGroup(skMetal, pgMetal);
  eyeletsMetal.name = "Eyelets_Metal";
  frame.add(eyeletsMetal);

  if (skF.visorPolyline.length >= 2) {
    const visorMat = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      flatShading: false,
      side: THREE.DoubleSide,
      metalness: 0,
      roughness: 1,
    });
    const visorBotMat = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      emissive: 0x000000,
      emissiveIntensity: 0,
      flatShading: false,
      side: THREE.DoubleSide,
      metalness: 0,
      roughness: 1,
    });
    const { top: visorTopGeo, bottom: visorBotGeo } = exportVisorSlabGeometries!;
    const visorGroup = new THREE.Group();
    visorGroup.name = "Visor";
    const visorBot = new THREE.Mesh(visorBotGeo, visorBotMat);
    visorBot.name = "Visor_Bottom";
    visorGroup.add(visorBot);
    const filletGeo = buildVisorFilletGeometry(skF);
    const fillet = new THREE.Mesh(filletGeo, visorBotMat);
    fillet.name = "Visor_Fillet";
    fillet.renderOrder = 2;
    visorGroup.add(fillet);
    const tuckGeo = buildVisorTuckGeometry(skF);
    const tuck = new THREE.Mesh(tuckGeo, visorBotMat);
    tuck.name = "Visor_Tuck";
    tuck.renderOrder = 1;
    visorGroup.add(tuck);
    const visorTop = new THREE.Mesh(visorTopGeo, visorMat);
    visorTop.name = "Visor_Top";
    visorGroup.add(visorTop);
    frame.add(visorGroup);
    frame.add(buildBillRopeGroup(skF));
  }

  neutralizeExportMaterialTree(root);
  return root;
}
