import * as THREE from "three";
import {
  effectiveVisorHalfSpanRad,
  panelSeamAngles,
  sampleSeamWireframe,
  sweatbandPoint,
  sweatbandPolyline,
} from "@/lib/skeleton/geometry";
import type { BuiltSkeleton } from "@/lib/skeleton/geometry";
import { seamGroupIndices } from "@/lib/skeleton/measurements";

/** Which measurement field is focused in the UI (drives 3D highlight). */
export type MeasurementFieldHighlight =
  | null
  | "base"
  | "visorLength"
  | "visorWidth"
  | "seamFront"
  | "seamSideFront"
  | "seamSideBack"
  | "seamRear";

const HI_BASE = 0x22c55e;
const HI_VISOR = 0xfbbf24;
const HI_SEAM = 0xe879f9;

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

function hiMat(color: number): THREE.LineBasicMaterial {
  return new THREE.LineBasicMaterial({
    color,
    depthTest: true,
    depthWrite: false,
    transparent: true,
    opacity: 1,
  });
}

/**
 * Extra lines matching the geometry affected by each measurement field.
 * Same world setup as `buildHatGroup` (root rotation applied here).
 */
export function buildMeasurementHighlightGroup(
  sk: BuiltSkeleton,
  highlight: MeasurementFieldHighlight
): THREE.Group | null {
  if (highlight === null) return null;

  const root = new THREE.Group();
  root.name = "MeasurementHighlight";
  root.rotation.x = -Math.PI / 2;

  if (highlight === "base") {
    const pts = sweatbandPolyline(sk.spec, 128);
    const geo = lineLoopToSegmentsBuffer(pts);
    const line = new THREE.LineSegments(geo, hiMat(HI_BASE));
    line.name = "Highlight_Base";
    line.renderOrder = 1;
    root.add(line);
  }

  if (highlight === "visorLength") {
    const { spec } = sk;
    const rimCenter = sweatbandPoint(
      spec.visor.attachAngleRad,
      spec.semiAxisX,
      spec.semiAxisY,
      spec.yawRad
    );
    if (sk.visorPolyline.length >= 2) {
      const midIdx = Math.floor(sk.visorPolyline.length / 2);
      const visorCenter = sk.visorPolyline[midIdx]!;
      const geo = lineStripToBuffer([rimCenter, visorCenter]);
      const line = new THREE.Line(geo, hiMat(HI_VISOR));
      line.name = "Highlight_VisorLength";
      line.renderOrder = 1;
      root.add(line);
    }
  }

  if (highlight === "visorWidth") {
    const { spec } = sk;
    const c = spec.visor.attachAngleRad;
    const angles =
      spec.seamAnglesRad !== null
        ? Float64Array.from(spec.seamAnglesRad)
        : panelSeamAngles(spec.nSeams);
    const half = effectiveVisorHalfSpanRad(spec.visor, spec.nSeams, angles);
    const left = sweatbandPoint(c - half, spec.semiAxisX, spec.semiAxisY, spec.yawRad);
    const right = sweatbandPoint(c + half, spec.semiAxisX, spec.semiAxisY, spec.yawRad);
    const geo = lineStripToBuffer([left, right]);
    const line = new THREE.Line(geo, hiMat(HI_VISOR));
    line.name = "Highlight_VisorWidth";
    line.renderOrder = 1;
    root.add(line);
  }

  if (
    highlight === "seamFront" ||
    highlight === "seamSideFront" ||
    highlight === "seamSideBack" ||
    highlight === "seamRear"
  ) {
    const g = seamGroupIndices(sk.spec.nSeams);
    const idx =
      highlight === "seamFront"
        ? g.front
        : highlight === "seamSideFront"
          ? g.sideFront
          : highlight === "seamSideBack"
            ? g.sideBack
            : g.rear;
    for (const i of idx) {
      const strip = sampleSeamWireframe(sk.seamControls[i]!, 56);
      const geo = lineStripToBuffer(strip);
      const line = new THREE.Line(geo, hiMat(HI_SEAM));
      line.name = `Highlight_Seam_${i}`;
      line.renderOrder = 1;
      root.add(line);
    }
  }

  return root;
}

export function disposeMeasurementHighlightGroup(g: THREE.Group | null): void {
  if (!g) return;
  g.traverse((obj) => {
    if (obj instanceof THREE.Line || obj instanceof THREE.LineSegments) {
      obj.geometry.dispose();
      (obj.material as THREE.Material).dispose();
    }
  });
}
