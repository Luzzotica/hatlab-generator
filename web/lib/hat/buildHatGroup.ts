import * as THREE from "three";
import {
  buildSkeleton,
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
  buildCrownGeometry,
  crownArcSegments,
  crownVerticalRings,
} from "@/lib/mesh/crownMesh";
import { subtractBackClosureFromCrown } from "@/lib/mesh/backClosureSubtract";
import { buildSweatbandGeometry } from "@/lib/mesh/sweatbandMesh";
import { buildVisorGeometry } from "@/lib/mesh/visorMesh";
import { buildSeamTapeGroup } from "@/lib/hat/seamTapeMesh";

const SEAM_SEGMENTS = 40;

/** Cyan V→side lerp meridians (debug). Main blue seam lines are always shown. */
const SHOW_FRONT_V_TO_ARC_GUIDES = false;

/** Slight radial push so guide lines draw on top of the mesh (same path as vertices). */
const FRONT_GUIDE_RADIAL_OFFSET = 0.002;

function offsetRadialOutward(p: [number, number, number]): [number, number, number] {
  const len = Math.hypot(p[0], p[1], p[2]);
  if (len < 1e-10) return p;
  const s = 1 + FRONT_GUIDE_RADIAL_OFFSET / len;
  return [p[0] * s, p[1] * s, p[2] * s];
}

/** Panels that flank the front center seam (V): each gets lerp lines from side seam ↔ front seam. */
function frontNeighborPanelIndices(nSeams: number, frontSeamIdx: number): [number, number] {
  if (nSeams === 6) {
    return [(frontSeamIdx - 1 + nSeams) % nSeams, frontSeamIdx];
  }
  return [(nSeams - 1) % nSeams, 0];
}

function lineStripToBuffer(points: [number, number, number][]): THREE.BufferGeometry {
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

function lineLoopToSegmentsBuffer(points: [number, number, number][]): THREE.BufferGeometry {
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

/** Full hat: crown mesh + wireframe lines (rim, seams, visor, apex cross). */
export function buildHatGroup(sk: BuiltSkeleton): THREE.Group {
  const root = new THREE.Group();
  root.name = "Hat";
  // Skeleton is built in +Z up (+Y forward). Rotate −90° about X so the hat sits Y-up in Three.js
  // (rim horizontal in XZ, crown toward +Y) instead of lying on its side in the default view.
  root.rotation.x = -Math.PI / 2;

  let crownGeo = buildCrownGeometry(sk);
  if (sk.spec.backClosureOpening) {
    const cut = subtractBackClosureFromCrown(crownGeo, sk);
    crownGeo.dispose();
    crownGeo = cut;
  }
  const crown = new THREE.Mesh(
    crownGeo,
    new THREE.MeshStandardMaterial({
      color: 0x6b7280,
      flatShading: false,
      side: THREE.DoubleSide,
      metalness: 0.1,
      roughness: 0.85,
    })
  );
  crown.name = "Crown";
  root.add(crown);

  const sweatbandGeo = buildSweatbandGeometry(sk, {
    closure: sk.spec.backClosureOpening === true,
  });
  const sweatband = new THREE.Mesh(
    sweatbandGeo,
    new THREE.MeshStandardMaterial({
      color: 0x4b5563,
      flatShading: false,
      side: THREE.DoubleSide,
      metalness: 0.05,
      roughness: 0.92,
    })
  );
  sweatband.name = "Sweatband";
  root.add(sweatband);

  const seamTape = buildSeamTapeGroup(sk);
  root.add(seamTape);

  const rimPts = sweatbandPolyline(sk.spec, 96);
  const rimGeo = lineLoopToSegmentsBuffer(rimPts);
  const rim = new THREE.LineSegments(
    rimGeo,
    new THREE.LineBasicMaterial({ color: 0x9ca3af })
  );
  rim.name = "RimGuide";
  root.add(rim);

  for (let i = 0; i < sk.spec.nSeams; i++) {
    const strip = sampleSeamWireframe(sk.seamControls[i]!, SEAM_SEGMENTS);
    const geo = lineStripToBuffer(strip);
    const line = new THREE.Line(geo, new THREE.LineBasicMaterial({ color: 0x3b82f6 }));
    line.name = `Seam_${i}`;
    root.add(line);
  }

  if (SHOW_FRONT_V_TO_ARC_GUIDES && sk.spec.frontVSplit != null) {
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
      const [seamArcIdx, seamVIdx] = frontGuideArcAndVIndices(panelIdx, frontSeamIdx, nSeams);
      for (let j = 1; j < M; j++) {
        const alpha = frontGuideAlpha(panelIdx, j, M, frontSeamIdx, nSeams);
        const strip = sampleVToArcGuideMeridian(sk, seamArcIdx, seamVIdx, alpha, N).map(
          offsetRadialOutward
        );
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
    const visorFillGeo = buildVisorGeometry(sk);
    const visorFill = new THREE.Mesh(
      visorFillGeo,
      new THREE.MeshStandardMaterial({
        color: 0x52525b,
        flatShading: false,
        side: THREE.DoubleSide,
        metalness: 0.08,
        roughness: 0.88,
      })
    );
    visorFill.name = "VisorFill";
    root.add(visorFill);
  }

  const visorGeo = lineStripToBuffer(sk.visorPolyline);
  const visor = new THREE.Line(visorGeo, new THREE.LineBasicMaterial({ color: 0xf97316 }));
  visor.name = "Visor";
  root.add(visor);

  if (sk.spec.nSeams === 5 && sk.spec.fivePanelCenterSeamLength > 0) {
    const t = sk.spec.fivePanelCenterSeamLength;
    const c = sk.spec.visor.attachAngleRad;
    const rimFront = sweatbandPoint(
      c,
      sk.spec.semiAxisX,
      sk.spec.semiAxisY,
      sk.spec.yawRad
    );
    const ax = sk.apex;
    const end: [number, number, number] = [
      ax[0] + t * (rimFront[0] - ax[0]),
      ax[1] + t * (rimFront[1] - ax[1]),
      ax[2] + t * (rimFront[2] - ax[2]),
    ];
    const centerGeo = lineStripToBuffer([[ax[0], ax[1], ax[2]], end]);
    const centerSeam = new THREE.Line(
      centerGeo,
      new THREE.LineBasicMaterial({ color: 0x93c5fd })
    );
    centerSeam.name = "CenterSeam_5p";
    root.add(centerSeam);
  }

  const ax = sk.apex;
  const s = Math.max(0.01, 0.04 * Math.hypot(sk.spec.semiAxisX, sk.spec.semiAxisY));
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
    new THREE.LineBasicMaterial({ color: 0xef4444 })
  );
  cross.name = "Apex";
  root.add(cross);

  return root;
}

export function buildHatGroupFromSpec(spec: HatSkeletonSpec): THREE.Group {
  return buildHatGroup(buildSkeleton(spec));
}
