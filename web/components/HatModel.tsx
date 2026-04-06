"use client";

import { useEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import { buildHatGroup } from "@/lib/hat/buildHatGroup";
import {
  buildMeasurementHighlightGroup,
  disposeMeasurementHighlightGroup,
  type MeasurementFieldHighlight,
} from "@/lib/hat/measurementHighlight";
import {
  buildSkeleton,
  type BuiltSkeleton,
  type HatSkeletonSpec,
} from "@/lib/skeleton";

function disposeObject3D(root: THREE.Object3D): void {
  root.traverse((obj) => {
    if (obj instanceof THREE.Mesh) {
      obj.geometry.dispose();
      const m = obj.material;
      if (Array.isArray(m)) m.forEach((x) => x.dispose());
      else m.dispose();
    }
    if (obj instanceof THREE.Line || obj instanceof THREE.LineSegments) {
      obj.geometry.dispose();
      (obj.material as THREE.Material).dispose();
    }
  });
}

export function HatModel({
  spec,
  measurementHighlight = null,
}: {
  spec: HatSkeletonSpec;
  measurementHighlight?: MeasurementFieldHighlight | null;
}) {
  const prevSkRef = useRef<BuiltSkeleton | null>(null);
  const sk = useMemo(() => {
    const next = buildSkeleton(spec, prevSkRef.current);
    prevSkRef.current = next;
    return next;
  }, [spec]);
  const hatGroup = useMemo(() => buildHatGroup(sk), [sk]);
  const highlightGroup = useMemo(
    () => buildMeasurementHighlightGroup(sk, measurementHighlight ?? null),
    [sk, measurementHighlight],
  );

  useEffect(() => {
    return () => {
      disposeObject3D(hatGroup);
      disposeMeasurementHighlightGroup(highlightGroup);
    };
  }, [hatGroup, highlightGroup]);

  return (
    <group>
      <primitive object={hatGroup} />
      {highlightGroup ? <primitive object={highlightGroup} /> : null}
    </group>
  );
}
