import { describe, expect, it } from "vitest";
import * as THREE from "three";
import {
  buildSkeleton,
  VISOR_CURVATURE_PLANFORM_K,
} from "@/lib/skeleton/geometry";
import { mergeHatSpecDefaults, defaultHatSkeletonSpec } from "@/lib/skeleton/types";
import { buildVisorTopBottomGeometries } from "@/lib/mesh/visorMesh";
import { VISOR_SHAPE_CURVATURE_MS } from "@/lib/hat/hatDocument";

function visorXYExtent(sk: ReturnType<typeof buildSkeleton>): {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
} {
  const { top, bottom } = buildVisorTopBottomGeometries(sk);
  const box = new THREE.Box3();
  box.setFromBufferAttribute(top.getAttribute("position") as THREE.BufferAttribute);
  const b2 = new THREE.Box3();
  b2.setFromBufferAttribute(bottom.getAttribute("position") as THREE.BufferAttribute);
  box.union(b2);
  top.dispose();
  bottom.dispose();
  return {
    minX: box.min.x,
    maxX: box.max.x,
    minY: box.min.y,
    maxY: box.max.y,
  };
}

describe("visor flat vs curved planform", () => {
  it("matches XY bounds when planform depth projection * (1 + K*c) is held constant", () => {
    const base = mergeHatSpecDefaults(defaultHatSkeletonSpec());
    const c = VISOR_SHAPE_CURVATURE_MS[3]!;
    const K = VISOR_CURVATURE_PLANFORM_K;
    const flatSpec = {
      ...base,
      visor: { ...base.visor, visorCurvatureM: VISOR_SHAPE_CURVATURE_MS[0]! },
    };
    const curvedSpec = {
      ...base,
      visor: {
        ...base.visor,
        visorCurvatureM: c,
        projection: base.visor.projection / (1 + K * c),
      },
    };
    const flatSk = buildSkeleton(flatSpec);
    const curvedSk = buildSkeleton(curvedSpec);
    const a = visorXYExtent(flatSk);
    const b = visorXYExtent(curvedSk);
    expect(a.minX).toBeCloseTo(b.minX, 5);
    expect(a.maxX).toBeCloseTo(b.maxX, 5);
    expect(a.minY).toBeCloseTo(b.minY, 5);
    expect(a.maxY).toBeCloseTo(b.maxY, 5);
  });

});
