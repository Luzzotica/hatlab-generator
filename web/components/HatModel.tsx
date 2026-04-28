"use client";

import { useEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import { buildHatGroup } from "@/lib/hat/buildHatGroup";
import {
  buildMeasurementHighlightGroup,
  disposeMeasurementHighlightGroup,
  type MeasurementFieldHighlight,
} from "@/lib/hat/measurementHighlight";
import { HatCrownDecal } from "@/components/HatCrownDecal";
import type { HatDecalPersisted } from "@/lib/decal/crownDecal";
import { applyProceduralLaserEtchMaterial } from "@/lib/hat/proceduralLaserEtch";
import {
  invertTextureAlpha,
  packAlphaChannelIntoRgbForAlphaMap,
  shouldInvertAlphaForMode,
  textureUrlForRearLaserEtchMode,
  usesProceduralLaserEtch,
  type RearLaserEtchMode,
} from "@/lib/hat/rearLaserEtch";
import {
  buildSkeleton,
  frontRisePanelIndices,
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
  decal = null,
  decalTexture = null,
  onDecalChange,
  rearLaserEtchMode = "none",
}: {
  spec: HatSkeletonSpec;
  measurementHighlight?: MeasurementFieldHighlight | null;
  decal?: HatDecalPersisted | null;
  decalTexture?: THREE.Texture | null;
  onDecalChange?: (next: HatDecalPersisted) => void;
  rearLaserEtchMode?: RearLaserEtchMode;
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

  useEffect(() => {
    const baseMesh = hatGroup.getObjectByName("Panel_0") as THREE.Mesh | null;
    if (!baseMesh || !(baseMesh.material instanceof THREE.MeshStandardMaterial)) {
      return;
    }
    const crownMat = baseMesh.material;
    /** Matches export `Crown_Side` ∪ `Crown_Rear`: all panels except front rise (`Crown_Front`). */
    const frontSet = new Set(frontRisePanelIndices(spec.nSeams));
    const etchMeshes: THREE.Mesh[] = [];
    const etchMeshesInner: THREE.Mesh[] = [];
    let crownMatInner: THREE.MeshStandardMaterial | null = null;
    for (let i = 0; i < spec.nSeams; i++) {
      if (frontSet.has(i)) continue;
      const m = hatGroup.getObjectByName(`Panel_${i}`);
      if (m instanceof THREE.Mesh) etchMeshes.push(m);
      const inner = hatGroup.getObjectByName(`Panel_${i}_Inner`);
      if (inner instanceof THREE.Mesh) {
        etchMeshesInner.push(inner);
        if (
          !crownMatInner &&
          inner.material instanceof THREE.MeshStandardMaterial
        ) {
          crownMatInner = inner.material;
        }
      }
    }

    if (etchMeshes.length === 0) return;

    let etchMat: THREE.MeshStandardMaterial | null = null;
    let cancelled = false;

    const resetToSharedCrown = () => {
      for (const m of etchMeshes) {
        m.material = crownMat;
      }
      const innerBase = crownMatInner ?? crownMat;
      for (const m of etchMeshesInner) {
        m.material = innerBase;
      }
      if (etchMat) {
        etchMat.dispose();
        etchMat = null;
      }
    };

    if (usesProceduralLaserEtch(rearLaserEtchMode)) {
      etchMat = crownMat.clone();
      etchMat.alphaMap = null;
      etchMat.transparent = true;
      etchMat.alphaTest = 0.5;
      etchMat.depthWrite = true;
      etchMat.needsUpdate = true;
      applyProceduralLaserEtchMaterial(etchMat, rearLaserEtchMode);
      for (const m of etchMeshes) {
        m.material = etchMat;
      }
      for (const m of etchMeshesInner) {
        m.material = etchMat;
      }
      return () => {
        resetToSharedCrown();
      };
    }

    const url = textureUrlForRearLaserEtchMode(rearLaserEtchMode);
    if (!url) {
      resetToSharedCrown();
      return () => {
        cancelled = true;
        resetToSharedCrown();
      };
    }

    const loader = new THREE.TextureLoader();
    loader.load(
      url,
      (tex) => {
        if (cancelled) {
          tex.dispose();
          return;
        }
        tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
        tex.colorSpace = THREE.LinearSRGBColorSpace;
        if (shouldInvertAlphaForMode(rearLaserEtchMode)) {
          invertTextureAlpha(tex);
        }
        packAlphaChannelIntoRgbForAlphaMap(tex);
        etchMat = crownMat.clone();
        etchMat.alphaMap = tex;
        etchMat.transparent = true;
        etchMat.alphaTest = 0.5;
        etchMat.depthWrite = true;
        etchMat.needsUpdate = true;
        for (const m of etchMeshes) {
          m.material = etchMat;
        }
        for (const m of etchMeshesInner) {
          m.material = etchMat;
        }
      },
      undefined,
      () => {
        if (!cancelled) resetToSharedCrown();
      },
    );

    return () => {
      cancelled = true;
      resetToSharedCrown();
    };
  }, [hatGroup, spec.nSeams, rearLaserEtchMode]);

  return (
    <group>
      <primitive object={hatGroup} />
      {highlightGroup ? <primitive object={highlightGroup} /> : null}
      {decal && decalTexture && onDecalChange ? (
        <HatCrownDecal
          hatGroup={hatGroup}
          texture={decalTexture}
          decal={decal}
          onDecalChange={onDecalChange}
        />
      ) : null}
    </group>
  );
}
