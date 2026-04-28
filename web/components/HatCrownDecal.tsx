"use client";

import { Decal } from "@react-three/drei";
import { useThree } from "@react-three/fiber";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import type { HatDecalPersisted } from "@/lib/decal/crownDecal";
import { defaultDecalLocalCenter } from "@/lib/decal/crownDecal";

type Props = {
  hatGroup: THREE.Group;
  texture: THREE.Texture;
  decal: HatDecalPersisted;
  onDecalChange: (next: HatDecalPersisted) => void;
};

export function HatCrownDecal({
  hatGroup,
  texture,
  decal,
  onDecalChange,
}: Props) {
  const get = useThree((s) => s.get);
  const { raycaster, camera, gl } = useThree();
  const meshRef = useRef<THREE.Mesh | null>(null);
  const draggingRef = useRef(false);
  const decalRef = useRef(decal);
  decalRef.current = decal;
  const didCenterRef = useRef(false);
  const prevImageUrl = useRef<string | null>(null);

  useEffect(() => {
    if (decal.imageDataUrl !== prevImageUrl.current) {
      prevImageUrl.current = decal.imageDataUrl;
      didCenterRef.current = false;
    }
  }, [decal.imageDataUrl]);

  const targetMesh = useMemo(() => {
    const m = hatGroup.getObjectByName(`Panel_${decal.panelIndex}`);
    return m instanceof THREE.Mesh ? m : null;
  }, [hatGroup, decal.panelIndex]);

  useLayoutEffect(() => {
    if (!targetMesh || !texture) return;
    if (didCenterRef.current) return;
    const isZero =
      decal.position[0] === 0 &&
      decal.position[1] === 0 &&
      decal.position[2] === 0;
    if (!isZero) {
      didCenterRef.current = true;
      return;
    }
    didCenterRef.current = true;
    const c = defaultDecalLocalCenter(targetMesh);
    onDecalChange({
      ...decalRef.current,
      position: c.toArray() as [number, number, number],
    });
  }, [targetMesh, texture, decal.position, onDecalChange]);

  const ndc = useMemo(() => new THREE.Vector2(), []);

  const crownMeshes = useMemo(() => {
    const list: THREE.Mesh[] = [];
    hatGroup.traverse((o) => {
      if (o instanceof THREE.Mesh && o.name.startsWith("Panel_")) list.push(o);
    });
    return list;
  }, [hatGroup]);

  const projectPick = useCallback(
    (e: PointerEvent) => {
      const rect = gl.domElement.getBoundingClientRect();
      const x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
      const y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
      ndc.set(x, y);
      raycaster.setFromCamera(ndc, camera);
      const hits = raycaster.intersectObjects(crownMeshes, false);
      if (hits.length === 0) return null;
      const hit = hits[0]!;
      const meshHit = hit.object as THREE.Mesh;
      if (!meshHit.name.startsWith("Panel_")) return null;
      const panelIndex = Number(meshHit.name.replace("Panel_", ""));
      if (!Number.isFinite(panelIndex)) return null;
      const local = hit.point.clone();
      meshHit.worldToLocal(local);
      return { panelIndex, local };
    },
    [crownMeshes, raycaster, camera, gl.domElement, ndc],
  );

  useEffect(() => {
    const el = gl.domElement;
    const setOrbit = (enabled: boolean) => {
      const controls = get().controls as { enabled?: boolean } | undefined;
      if (controls) controls.enabled = enabled;
    };

    const onDown = (e: PointerEvent) => {
      if (e.button !== 0 || !e.altKey) return;
      const picked = projectPick(e);
      if (!picked) return;
      e.preventDefault();
      e.stopPropagation();
      draggingRef.current = true;
      setOrbit(false);
      const d = decalRef.current;
      onDecalChange({
        ...d,
        panelIndex: picked.panelIndex,
        position: picked.local.toArray() as [number, number, number],
      });
    };

    const onMove = (e: PointerEvent) => {
      if (!draggingRef.current) return;
      const picked = projectPick(e);
      if (!picked) return;
      const d = decalRef.current;
      onDecalChange({
        ...d,
        panelIndex: picked.panelIndex,
        position: picked.local.toArray() as [number, number, number],
      });
    };

    const onUp = () => {
      if (!draggingRef.current) return;
      draggingRef.current = false;
      setOrbit(true);
    };

    el.addEventListener("pointerdown", onDown, true);
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp, true);
    window.addEventListener("pointercancel", onUp, true);
    return () => {
      el.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp, true);
      window.removeEventListener("pointercancel", onUp, true);
      setOrbit(true);
    };
  }, [get, gl.domElement, onDecalChange, projectPick]);

  const positionVec = useMemo(
    () => new THREE.Vector3().fromArray(decal.position),
    [decal.position],
  );
  const scaleVec = useMemo(
    () => new THREE.Vector3().fromArray(decal.scale),
    [decal.scale],
  );

  /**
   * Drei's Decal reads `mesh.current` in its own useLayoutEffect. Parent layout effects
   * are not guaranteed to run before the child's, so sync the ref before JSX (after hooks).
   */
  meshRef.current = targetMesh;

  if (!targetMesh) return null;

  return (
    <Decal
      mesh={meshRef as React.RefObject<THREE.Mesh>}
      position={positionVec}
      rotation={decal.zRotation}
      scale={scaleVec}
      map={texture}
      polygonOffsetFactor={-8}
      depthTest
    >
      <meshPhysicalMaterial
        transparent
        map={texture}
        polygonOffset
        polygonOffsetFactor={-8}
        depthTest
        roughness={0.85}
        metalness={0}
      />
    </Decal>
  );
}
