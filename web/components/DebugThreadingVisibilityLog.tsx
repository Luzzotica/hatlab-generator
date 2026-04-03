"use client";

import { useRef } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import * as THREE from "three";

/** Matches SWEATBAND_THREAD_HALF_WIDTH_M in threadingMesh (debug estimate only). */
const THREAD_HALF_W_M = 0.005;

const DEBUG_INGEST =
  "http://127.0.0.1:7308/ingest/f207d8e5-31a4-4fc3-90ad-c0892d7b6fa9";

/**
 * Runtime samples for sweatband thread visibility (zoom / depth / grazing angle).
 * Hypotheses: H1 depth+polygonOffset, H2 edge-on ribbon, H3 sub-pixel width.
 */
export function DebugThreadingVisibilityLog() {
  const { camera, scene, gl } = useThree();
  const frameRef = useRef(0);

  useFrame(() => {
    frameRef.current += 1;
    if (frameRef.current % 120 !== 0) return;

    let sweatMesh: THREE.Mesh | null = null;
    scene.traverse((o) => {
      if (o.name === "Thread_Sweatband_0") sweatMesh = o as THREE.Mesh;
    });

    if (sweatMesh === null) {
      // #region agent log
      fetch(DEBUG_INGEST, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Debug-Session-Id": "7b9aa0",
        },
        body: JSON.stringify({
          sessionId: "7b9aa0",
          location: "DebugThreadingVisibilityLog.tsx:useFrame",
          message: "Thread_Sweatband_0 missing",
          data: { hypothesisId: "H4", foundMesh: false },
          timestamp: Date.now(),
        }),
      }).catch(() => {});
      // #endregion
      return;
    }

    const mesh: THREE.Mesh = sweatMesh;
    const geo = mesh.geometry;
    const pos = geo.getAttribute("position");
    const nor = geo.getAttribute("normal");
    if (!pos || pos.count < 1) return;

    const meshWorld = mesh.matrixWorld;
    const center = new THREE.Vector3();
    new THREE.Box3().setFromObject(mesh).getCenter(center);

    const camWorld = new THREE.Vector3();
    camera.getWorldPosition(camWorld);
    const dist = camWorld.distanceTo(center);

    const v0 = new THREE.Vector3(pos.getX(0), pos.getY(0), pos.getZ(0)).applyMatrix4(
      meshWorld,
    );
    const toCam = camWorld.clone().sub(v0).normalize();
    let faceDot = -1;
    if (nor && nor.count > 0) {
      const n0 = new THREE.Vector3(nor.getX(0), nor.getY(0), nor.getZ(0));
      n0.applyNormalMatrix(new THREE.Matrix3().getNormalMatrix(meshWorld));
      n0.normalize();
      faceDot = Math.abs(n0.dot(toCam));
    }

    const persp = camera as THREE.PerspectiveCamera;
    const vfov = persp.isPerspectiveCamera
      ? THREE.MathUtils.degToRad(persp.fov)
      : 1;
    const h = Math.max(1, gl.domElement.clientHeight);
    const pxPerMeter = (h / 2) / (Math.tan(vfov / 2) * Math.max(dist, 1e-6));
    const approxRibbonHalfPx = THREAD_HALF_W_M * pxPerMeter;

    const mat = mesh.material as THREE.MeshStandardMaterial;
    const polyOff =
      mat.polygonOffset === true
        ? { factor: mat.polygonOffsetFactor, units: mat.polygonOffsetUnits }
        : null;

    // #region agent log
    fetch(DEBUG_INGEST, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Debug-Session-Id": "7b9aa0",
      },
      body: JSON.stringify({
        sessionId: "7b9aa0",
        location: "DebugThreadingVisibilityLog.tsx:useFrame",
        message: "sweatband thread visibility sample",
          data: {
            hypothesisId: "H1-H3",
            runId: "post-fix",
            dist,
          faceDot,
          approxRibbonHalfPx,
          polyOff,
          depthWrite: mat.depthWrite,
        },
        timestamp: Date.now(),
      }),
    }).catch(() => {});
    // #endregion
  });

  return null;
}
