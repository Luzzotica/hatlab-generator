import * as THREE from "three";
import {
  buildSkeleton,
  effectiveVisorHalfSpanRad,
  frontCenterSeamIndex,
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
import { getClosureCutterOutline } from "@/lib/mesh/backClosureSubtract";
import {
  buildSweatbandGeometry,
  type VisorTuckLiftParams,
} from "@/lib/mesh/sweatbandMesh";
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
import { agentDebugLog } from "@/lib/debug/agentDebugLog";

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
function buildInnerFrontRiseGroup(sk: BuiltSkeleton): THREE.Group {
  const mat = new THREE.MeshStandardMaterial({
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
  // #region agent log
  agentDebugLog({
    hypothesisId: "P0",
    location: "buildHatGroup:entry",
    message: "buildHatGroup start",
    data: { backClosureOpening: sk.spec.backClosureOpening === true, nSeams: sk.spec.nSeams },
    runId: "closure-crash",
  });
  // #endregion
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
  let panelGeos: THREE.BufferGeometry[];
  try {
    // #region agent log
    agentDebugLog({
      hypothesisId: "P1",
      location: "buildHatGroup:beforeCrown",
      message: "before buildCrownPanelGeometries",
      runId: "closure-crash",
    });
    // #endregion
    panelGeos = buildCrownPanelGeometries(sk);
    // #region agent log
    agentDebugLog({
      hypothesisId: "P1",
      location: "buildHatGroup:afterCrown",
      message: "after buildCrownPanelGeometries",
      data: { panelCount: panelGeos.length },
      runId: "closure-crash",
    });
    // #endregion
  } catch (e) {
    const err = e instanceof Error ? e : new Error(String(e));
    // #region agent log
    agentDebugLog({
      hypothesisId: "P1",
      location: "buildHatGroup:crownCatch",
      message: "buildCrownPanelGeometries threw",
      data: {
        name: err.name,
        message: err.message,
        stack: err.stack?.slice(0, 4000) ?? "",
      },
      runId: "closure-crash",
    });
    // #endregion
    throw e;
  }
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
  let sweatbandGeo: THREE.BufferGeometry;
  try {
    // #region agent log
    agentDebugLog({
      hypothesisId: "P2",
      location: "buildHatGroup:beforeSweatband",
      message: "before buildSweatbandGeometry",
      runId: "closure-crash",
    });
    // #endregion
    sweatbandGeo = buildSweatbandGeometry(sk, {
      closure: sk.spec.backClosureOpening === true,
      lift: liftParams,
    });
    // #region agent log
    agentDebugLog({
      hypothesisId: "P2",
      location: "buildHatGroup:afterSweatband",
      message: "after buildSweatbandGeometry",
      runId: "closure-crash",
    });
    // #endregion
  } catch (e) {
    const err = e instanceof Error ? e : new Error(String(e));
    // #region agent log
    agentDebugLog({
      hypothesisId: "P2",
      location: "buildHatGroup:sweatbandCatch",
      message: "buildSweatbandGeometry threw",
      data: { name: err.name, message: err.message, stack: err.stack?.slice(0, 4000) ?? "" },
      runId: "closure-crash",
    });
    // #endregion
    throw e;
  }
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

  let seamTape: THREE.Group;
  try {
    // #region agent log
    agentDebugLog({
      hypothesisId: "P3",
      location: "buildHatGroup:beforeSeamTape",
      message: "before buildSeamTapeGroup",
      runId: "closure-crash",
    });
    // #endregion
    seamTape = buildSeamTapeGroup(sk);
    // #region agent log
    agentDebugLog({
      hypothesisId: "P3",
      location: "buildHatGroup:afterSeamTape",
      message: "after buildSeamTapeGroup",
      runId: "closure-crash",
    });
    // #endregion
  } catch (e) {
    const err = e instanceof Error ? e : new Error(String(e));
    // #region agent log
    agentDebugLog({
      hypothesisId: "P3",
      location: "buildHatGroup:seamTapeCatch",
      message: "buildSeamTapeGroup threw",
      data: { name: err.name, message: err.message, stack: err.stack?.slice(0, 4000) ?? "" },
      runId: "closure-crash",
    });
    // #endregion
    throw e;
  }
  root.add(seamTape);

  let threading: THREE.Group;
  try {
    // #region agent log
    agentDebugLog({
      hypothesisId: "P4",
      location: "buildHatGroup:beforeThreading",
      message: "before buildThreadingGroup",
      runId: "closure-crash",
    });
    // #endregion
    threading = buildThreadingGroup(sk, visorSlabGeometries);
    // #region agent log
    agentDebugLog({
      hypothesisId: "P4",
      location: "buildHatGroup:afterThreading",
      message: "after buildThreadingGroup",
      runId: "closure-crash",
    });
    // #endregion
  } catch (e) {
    const err = e instanceof Error ? e : new Error(String(e));
    // #region agent log
    agentDebugLog({
      hypothesisId: "P4",
      location: "buildHatGroup:threadingCatch",
      message: "buildThreadingGroup threw",
      data: { name: err.name, message: err.message, stack: err.stack?.slice(0, 4000) ?? "" },
      runId: "closure-crash",
    });
    // #endregion
    throw e;
  }
  root.add(threading);

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

/**
 * Export-only group: physical hat parts only (no debug lines or guide wireframes).
 * Hierarchy: Hat → Crown (Panel_0…N), Eyelets (optional), InnerFrontRise, TopButton, Sweatband, SeamTape (…), Threading, Visor (Bottom, Fillet, Tuck, Top), BillRope.
 */
export function buildHatExportGroup(spec: HatSkeletonSpec): THREE.Group {
  const sk = buildSkeleton(spec);
  const root = new THREE.Group();
  root.name = "Hat";
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

  const exportLiftParams = visorTuckLiftParams(sk);
  const sweatbandGeo = buildSweatbandGeometry(sk, {
    closure: sk.spec.backClosureOpening === true,
    lift: exportLiftParams,
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
  root.add(sweatband);

  let exportVisorSlabGeometries: VisorThreadingGeometries | undefined;
  if (sk.visorPolyline.length >= 2) {
    const { top, bottom } = buildVisorTopBottomGeometries(sk, {
      omitInnerRimInTop: true,
    });
    exportVisorSlabGeometries = { top, bottom };
  }

  root.add(buildSeamTapeGroup(sk));
  root.add(buildThreadingGroup(sk, exportVisorSlabGeometries));

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
    root.add(visorGroup);
    root.add(buildBillRopeGroup(sk));
  }

  return root;
}
