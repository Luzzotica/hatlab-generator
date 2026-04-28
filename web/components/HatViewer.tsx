"use client";

import type { CSSProperties } from "react";
import {
  Suspense,
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import * as THREE from "three";
import { Canvas } from "@react-three/fiber";
import { OrbitControls, PerspectiveCamera } from "@react-three/drei";
import { HatModel } from "./HatModel";
import {
  DEFAULT_VISOR_THREADING_SCALE,
  defaultHatSkeletonSpec,
  mergeHatSpecDefaults,
  type FrontSeamMode,
  type HatMeasurementTargets,
  type EyeletStyle,
  type HatClosureSpec,
  type HatSkeletonSpec,
  type SeamEndpointStyle,
  type VisorSpec,
  validateSpec,
} from "@/lib/skeleton/types";
import {
  measurementTargetsFromSpec,
  seamGroupIndices,
  shouldSkipMeasurementSolve,
  solveHatSpecFromMeasurementsIncremental,
  visorSpanRange,
} from "@/lib/skeleton";
import { frontRisePanelIndices } from "@/lib/skeleton/geometry";
import { resolveSeamEndpointStyleForIndex } from "@/lib/skeleton/geometry";
import { buildHatExportGroup } from "@/lib/hat/buildHatGroup";
import type { MeasurementFieldHighlight } from "@/lib/hat/measurementHighlight";
import { exportObjectToGLB, downloadBlob } from "@/lib/export/gltf";
import { computeTangentsForExport } from "@/lib/export/prepareExportGeometry";
import {
  createDefaultHatDocument,
  effectiveMeasurementTargets as mergeEffectiveMeasurementTargets,
  finalizeSpecForVisorShape,
  parseHatDocumentJSON,
  parseHatlabStoreJSON,
  type HatDocument,
  readHatlabStore,
  serializeHatDocument,
  type VisorMeasurementOverride,
  type VisorShapeIndex,
  VISOR_SHAPE_LABELS,
  writeHatlabStore,
} from "@/lib/hat/hatDocument";
import type { HatDecalPersisted } from "@/lib/decal/crownDecal";
import { downloadTextFile } from "@/lib/export/downloadText";
import { buildFullHatExportRoot } from "@/lib/export/unifiedHatExport";
import { resolveExportModelPrefix } from "@/lib/export/hatExportNaming";
import { disposeExportObject3D } from "@/lib/export/disposeExportObject3D";
import {
  buildAllHatsZipBlob,
  exportAllHatsToPickedDirectory,
  isFolderExportSupported,
} from "@/lib/export/bulkHatGlbExport";
import { buildAllHatsJsonZipBlob } from "@/lib/export/bulkHatJsonExport";
import {
  appendHatDecalToFullExport,
  appendHatDecalToSimpleExport,
} from "@/lib/export/appendHatDecalExport";
import {
  REAR_LASER_ETCH_LABELS,
  type RearLaserEtchMode,
} from "@/lib/hat/rearLaserEtch";

type SeamGroupKey = "front" | "sideFront" | "sideBack" | "rear";

const CLOSURE_OPTIONS = [
  { type: "snapback" as const, label: "Snapback" },
  { type: "velcro" as const, label: "Velcro" },
  { type: "strapback" as const, label: "Strapback" },
  { type: "metalSlide" as const, label: "Metal slide" },
  { type: "shockCord" as const, label: "Shock cord" },
] as const;

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(r.error);
    r.readAsDataURL(file);
  });
}

function patchGroupEndpointStyle(
  spec: HatSkeletonSpec,
  groupKey: SeamGroupKey,
  patch: Partial<SeamEndpointStyle>,
): HatSkeletonSpec {
  const indices = seamGroupIndices(spec.nSeams)[groupKey];
  if (indices.length === 0) return spec;
  const n = spec.nSeams;
  const styles: SeamEndpointStyle[] = [];
  for (let i = 0; i < n; i++) {
    styles.push(resolveSeamEndpointStyleForIndex(spec, i));
  }
  for (const i of indices) {
    styles[i] = { ...styles[i]!, ...patch };
  }
  return { ...spec, seamEndpointStyles: styles };
}

function Panel({
  spec,
  onChange,
  measurementTargets,
  onMeasurementBaseChange,
  onVisorShapeMeasurementOverride,
  onVisorOverrideChange,
  activeVisorShape,
  onActiveVisorShapeChange,
  measurementHighlight,
  onMeasurementHighlightChange,
}: {
  spec: HatSkeletonSpec;
  onChange: (s: HatSkeletonSpec) => void;
  measurementTargets: HatMeasurementTargets;
  onMeasurementBaseChange: (patch: Partial<HatMeasurementTargets>) => void;
  onVisorShapeMeasurementOverride: (patch: VisorMeasurementOverride) => void;
  onVisorOverrideChange: (patch: Partial<VisorSpec>) => void;
  activeVisorShape: VisorShapeIndex;
  onActiveVisorShapeChange: (shape: VisorShapeIndex) => void;
  measurementHighlight: MeasurementFieldHighlight;
  onMeasurementHighlightChange: (h: MeasurementFieldHighlight | null) => void;
}) {
  const v = spec.visor;
  const set = (patch: Partial<HatSkeletonSpec>) =>
    onChange({ ...spec, ...patch });
  const setVisor = (patch: Partial<typeof v>) => onVisorOverrideChange(patch);

  const mt = measurementTargets;
  const setMt = (patch: Partial<HatMeasurementTargets>) => {
    const visor: Partial<VisorMeasurementOverride> = {};
    const base: Partial<HatMeasurementTargets> = { ...patch };
    if ("visorLengthM" in patch) {
      visor.visorLengthM = patch.visorLengthM;
      delete (base as { visorLengthM?: number }).visorLengthM;
    }
    if ("visorWidthM" in patch) {
      visor.visorWidthM = patch.visorWidthM;
      delete (base as { visorWidthM?: number }).visorWidthM;
    }
    if (Object.keys(visor).length > 0) {
      onVisorShapeMeasurementOverride(visor);
    }
    if (Object.keys(base).length > 0) {
      onMeasurementBaseChange(base);
    }
  };

  const measurementBlockRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onFocusIn = (e: FocusEvent) => {
      const el = measurementBlockRef.current;
      if (!el || !e.target) return;
      if (!el.contains(e.target as Node)) {
        onMeasurementHighlightChange(null);
      }
    };
    document.addEventListener("focusin", onFocusIn);
    return () => document.removeEventListener("focusin", onFocusIn);
  }, [onMeasurementHighlightChange]);

  const hiInput = (
    field: Exclude<MeasurementFieldHighlight, null>,
  ): CSSProperties =>
    measurementHighlight === field
      ? {
          outline: "1px solid #22c55e",
          outlineOffset: 1,
          borderRadius: 4,
        }
      : {};

  return (
    <div
      style={{
        boxSizing: "border-box",
        width: "100%",
        background: "rgba(15,15,18,0.92)",
        color: "#e5e7eb",
        padding: 16,
        fontSize: 13,
        fontFamily: "system-ui, sans-serif",
      }}
    >
      <h1 style={{ margin: "0 0 12px", fontSize: 16 }}>Hat skeleton</h1>
      <div style={{ ...lab, marginBottom: 12 }}>
        <span style={{ fontWeight: 600 }}>Panels</span>
        <div style={{ display: "flex", gap: 8 }}>
          {([5, 6] as const).map((n) => {
            const is5 = spec.crownPanelMode === 5;
            const active = n === 5 ? is5 : !is5;
            return (
              <button
                key={n}
                type="button"
                onClick={() =>
                  set({
                    nSeams: 6 as const,
                    crownPanelMode: n,
                    fivePanelCenterSeamLength: n === 5 ? 0.36 : 1.0,
                  })
                }
                style={{
                  flex: 1,
                  padding: "8px 10px",
                  borderRadius: 6,
                  border: active ? "1px solid #3b82f6" : "1px solid #374151",
                  background: active ? "#1e3a5f" : "#1f2937",
                  color: "#e5e7eb",
                  cursor: "pointer",
                  fontSize: 12,
                }}
              >
                {n}-panel
              </button>
            );
          })}
        </div>
      </div>
      <div
        ref={measurementBlockRef}
        style={{
          borderBottom: "1px solid #374151",
          paddingBottom: 12,
          marginBottom: 12,
        }}
      >
        <span style={{ fontWeight: 600 }}>Measurements (metres)</span>
        <p
          style={{
            margin: "4px 0 8px",
            opacity: 0.65,
            fontSize: 11,
            lineHeight: 1.35,
          }}
        >
          Focus a field to highlight (green = base, amber = visor, magenta =
          seams).
        </p>
        <label style={lab}>
          Base circumference
          <input
            type="number"
            step={0.001}
            min={0.1}
            value={mt.baseCircumferenceM}
            style={hiInput("base")}
            onFocus={() => onMeasurementHighlightChange("base")}
            onChange={(e) =>
              setMt({ baseCircumferenceM: Number(e.target.value) })
            }
          />
        </label>

        <div
          style={{
            ...lab,
            borderTop: "1px solid #374151",
            paddingTop: 10,
            marginTop: 10,
          }}
        >
          <span style={{ fontWeight: 600 }}>Visor</span>
          <label style={lab}>
            Length (rim → edge, solver)
            <input
              type="number"
              step={0.001}
              min={0.005}
              value={mt.visorLengthM}
              style={hiInput("visorLength")}
              onFocus={() => onMeasurementHighlightChange("visorLength")}
              onChange={(e) => setMt({ visorLengthM: Number(e.target.value) })}
            />
          </label>
          <label style={lab}>
            Width (left → right, solver)
            {(() => {
              const range = visorSpanRange(spec);
              return (
                <>
                  <input
                    type="range"
                    min={range.min}
                    max={range.max}
                    step={0.001}
                    value={Math.min(
                      Math.max(mt.visorWidthM, range.min),
                      range.max,
                    )}
                    style={hiInput("visorWidth")}
                    onFocus={() => onMeasurementHighlightChange("visorWidth")}
                    onChange={(e) =>
                      setMt({ visorWidthM: Number(e.target.value) })
                    }
                  />
                  <span style={{ fontSize: 11, opacity: 0.75 }}>
                    {mt.visorWidthM.toFixed(3)} m
                    <span style={{ opacity: 0.5, marginLeft: 6 }}>
                      ({range.min.toFixed(3)} – {range.max.toFixed(3)})
                    </span>
                  </span>
                </>
              );
            })()}
          </label>
          <div style={lab}>
            <span>Visor curve (per tab)</span>
            <div
              style={{
                display: "flex",
                flexWrap: "wrap",
                gap: 6,
                marginTop: 4,
              }}
            >
              {VISOR_SHAPE_LABELS.map((label, i) => {
                const idx = i as VisorShapeIndex;
                const active = activeVisorShape === idx;
                return (
                  <button
                    key={label}
                    type="button"
                    onClick={() => onActiveVisorShapeChange(idx)}
                    style={{
                      padding: "6px 8px",
                      borderRadius: 6,
                      border: active
                        ? "1px solid #3b82f6"
                        : "1px solid #374151",
                      background: active ? "#1e3a5f" : "#1f2937",
                      color: "#e5e7eb",
                      cursor: "pointer",
                      fontSize: 11,
                    }}
                  >
                    {label}
                  </button>
                );
              })}
            </div>
          </div>
          <label style={lab}>
            Projection
            <input
              type="range"
              min={0.05}
              max={0.25}
              step={0.005}
              value={v.projection}
              onChange={(e) => setVisor({ projection: Number(e.target.value) })}
            />
            <span>{v.projection.toFixed(3)}</span>
          </label>
          <label style={lab}>
            Thread depth scale
            <input
              type="range"
              min={0.25}
              max={4}
              step={0.025}
              value={v.visorThreadingScale ?? DEFAULT_VISOR_THREADING_SCALE}
              onChange={(e) =>
                setVisor({ visorThreadingScale: Number(e.target.value) })
              }
            />
            <span>
              {(v.visorThreadingScale ?? DEFAULT_VISOR_THREADING_SCALE).toFixed(3)}
            </span>
          </label>
          <label style={lab}>
            Half-span (max, rad)
            <input
              type="range"
              min={0.2}
              max={1.35}
              step={0.005}
              value={v.halfSpanRad}
              onChange={(e) =>
                setVisor({ halfSpanRad: Number(e.target.value) })
              }
            />
            <span>{v.halfSpanRad.toFixed(3)}</span>
          </label>
          <label style={lab}>
            Rim past side seams (outset, rad)
            <input
              type="range"
              min={0}
              max={0.12}
              step={0.005}
              value={v.rimOutsetBeyondSeamRad ?? 0.035}
              onChange={(e) =>
                setVisor({ rimOutsetBeyondSeamRad: Number(e.target.value) })
              }
            />
            <span>{(v.rimOutsetBeyondSeamRad ?? 0.035).toFixed(3)}</span>
          </label>
          <label style={lab}>
            Inset from side seams (narrow, rad)
            <input
              type="range"
              min={0}
              max={0.2}
              step={0.005}
              value={v.rimInsetBehindSeamRad}
              onChange={(e) =>
                setVisor({ rimInsetBehindSeamRad: Number(e.target.value) })
              }
            />
            <span>{v.rimInsetBehindSeamRad.toFixed(3)}</span>
          </label>
          <label style={lab}>
            Outline curve (<em>n</em>, superellipse)
            <input
              type="range"
              min={1.05}
              max={6}
              step={0.05}
              value={v.superellipseN}
              onChange={(e) =>
                setVisor({
                  superellipseN: Number(e.target.value),
                  mode: "superellipse",
                })
              }
            />
            <span>{v.superellipseN.toFixed(2)}</span>
          </label>
        </div>

        <div
          style={{
            ...lab,
            borderTop: "1px solid #374151",
            paddingTop: 10,
            marginTop: 10,
          }}
        >
          <span style={{ fontWeight: 600 }}>Seams (per region)</span>
          {(["front", "sideFront", "sideBack", "rear"] as const).map((key) => {
            const g = seamGroupIndices(spec.nSeams)[key];
            if (g.length === 0) return null;
            const idx = g[0]!;
            const st = resolveSeamEndpointStyleForIndex(spec, idx);
            const title =
              key === "front"
                ? "Front center"
                : key === "sideFront"
                  ? "Side-front (mirrored pair)"
                  : key === "sideBack"
                    ? "Side-back (mirrored pair)"
                    : "Rear center";
            return (
              <div
                key={key}
                style={{
                  marginBottom: 12,
                  paddingBottom: 10,
                  borderBottom: "1px solid #2d3748",
                }}
              >
                <span style={{ fontSize: 12, opacity: 0.95 }}>{title}</span>

                {key === "front" && (
                  <div style={{ marginBottom: 8, marginTop: 6 }}>
                    <div style={{ display: "flex", gap: 6, marginBottom: 6 }}>
                      {(["curve", "split"] as FrontSeamMode[]).map((m) => (
                        <button
                          key={m}
                          type="button"
                          onClick={() => setMt({ frontSeamMode: m })}
                          style={{
                            flex: 1,
                            padding: "5px 8px",
                            borderRadius: 5,
                            border:
                              mt.frontSeamMode === m
                                ? "1px solid #3b82f6"
                                : "1px solid #374151",
                            background:
                              mt.frontSeamMode === m ? "#1e3a5f" : "#1f2937",
                            color: "#e5e7eb",
                            cursor: "pointer",
                            fontSize: 11,
                          }}
                        >
                          {m === "curve" ? "Single curve" : "Base + top (V)"}
                        </button>
                      ))}
                    </div>
                    {mt.frontSeamMode === "split" ? (
                      <>
                        <label style={lab}>
                          Front base → V-point
                          <input
                            type="number"
                            step={0.001}
                            min={0.01}
                            value={mt.seamFrontBaseLengthM}
                            style={hiInput("seamFront")}
                            onFocus={() =>
                              onMeasurementHighlightChange("seamFront")
                            }
                            onChange={(e) =>
                              setMt({
                                seamFrontBaseLengthM: Number(e.target.value),
                              })
                            }
                          />
                        </label>
                        <label style={lab}>
                          Front V-point → top
                          <input
                            type="number"
                            step={0.001}
                            min={0.01}
                            value={mt.seamFrontTopLengthM}
                            style={hiInput("seamFront")}
                            onFocus={() =>
                              onMeasurementHighlightChange("seamFront")
                            }
                            onChange={(e) =>
                              setMt({
                                seamFrontTopLengthM: Number(e.target.value),
                              })
                            }
                          />
                        </label>
                        <label style={lab}>
                          V-shape strength
                          <input
                            type="range"
                            min={0}
                            max={1}
                            step={0.01}
                            value={mt.frontSplitBlend}
                            onChange={(e) =>
                              setMt({ frontSplitBlend: Number(e.target.value) })
                            }
                          />
                          <span style={{ fontSize: 11, opacity: 0.75 }}>
                            {mt.frontSplitBlend.toFixed(2)}
                            <span style={{ opacity: 0.5, marginLeft: 6 }}>
                              (0 = smooth curve, 1 = sharp V)
                            </span>
                          </span>
                        </label>
                        {spec.frontVSplit && (
                          <>
                            <label style={lab}>
                              V leg bulge (rim → V)
                              <input
                                type="range"
                                min={0}
                                max={0.5}
                                step={0.01}
                                value={spec.frontVSplit.legBottomStrength ?? 0}
                                onChange={(e) =>
                                  set({
                                    frontVSplit: {
                                      ...spec.frontVSplit!,
                                      legBottomStrength: Number(e.target.value),
                                    },
                                  })
                                }
                              />
                              <span>
                                {(
                                  spec.frontVSplit.legBottomStrength ?? 0
                                ).toFixed(2)}
                              </span>
                            </label>
                            <label style={lab}>
                              V leg bulge (V → top)
                              <input
                                type="range"
                                min={0}
                                max={0.5}
                                step={0.01}
                                value={spec.frontVSplit.legTopStrength ?? 0}
                                onChange={(e) =>
                                  set({
                                    frontVSplit: {
                                      ...spec.frontVSplit!,
                                      legTopStrength: Number(e.target.value),
                                    },
                                  })
                                }
                              />
                              <span>
                                {(spec.frontVSplit.legTopStrength ?? 0).toFixed(
                                  2,
                                )}
                              </span>
                            </label>
                          </>
                        )}
                      </>
                    ) : (
                      <label style={lab}>
                        Target arc length (rim → top)
                        <input
                          type="number"
                          step={0.001}
                          min={0.02}
                          value={mt.seamEdgeLengthFrontM}
                          style={hiInput("seamFront")}
                          onFocus={() =>
                            onMeasurementHighlightChange("seamFront")
                          }
                          onChange={(e) =>
                            setMt({
                              seamEdgeLengthFrontM: Number(e.target.value),
                            })
                          }
                        />
                      </label>
                    )}
                    {spec.crownPanelMode === 5 && (
                      <label style={{ ...lab, marginTop: 8 }}>
                        Front center seam length (from top, 5-panel)
                        <input
                          type="range"
                          min={0.05}
                          max={0.95}
                          step={0.01}
                          value={spec.fivePanelCenterSeamLength}
                          onChange={(e) =>
                            set({
                              fivePanelCenterSeamLength: Number(e.target.value),
                            })
                          }
                        />
                        <span>
                          {(spec.fivePanelCenterSeamLength * 100).toFixed(0)}%
                        </span>
                      </label>
                    )}
                  </div>
                )}

                {key === "sideFront" && (
                  <label style={lab}>
                    Target arc length (rim → top)
                    <input
                      type="number"
                      step={0.001}
                      min={0.02}
                      value={mt.seamEdgeLengthSideFrontM}
                      style={hiInput("seamSideFront")}
                      onFocus={() =>
                        onMeasurementHighlightChange("seamSideFront")
                      }
                      onChange={(e) =>
                        setMt({
                          seamEdgeLengthSideFrontM: Number(e.target.value),
                        })
                      }
                    />
                  </label>
                )}
                {key === "sideBack" && (
                  <label style={lab}>
                    Target arc length (rim → top)
                    <input
                      type="number"
                      step={0.001}
                      min={0.02}
                      value={mt.seamEdgeLengthSideBackM}
                      style={hiInput("seamSideBack")}
                      onFocus={() =>
                        onMeasurementHighlightChange("seamSideBack")
                      }
                      onChange={(e) =>
                        setMt({
                          seamEdgeLengthSideBackM: Number(e.target.value),
                        })
                      }
                    />
                  </label>
                )}
                {key === "rear" && (
                  <label style={lab}>
                    Target arc length (rim → top)
                    <input
                      type="number"
                      step={0.001}
                      min={0.02}
                      value={mt.seamEdgeLengthRearM}
                      style={hiInput("seamRear")}
                      onFocus={() => onMeasurementHighlightChange("seamRear")}
                      onChange={(e) =>
                        setMt({ seamEdgeLengthRearM: Number(e.target.value) })
                      }
                    />
                  </label>
                )}

                <label style={lab}>
                  Bottom strength
                  <input
                    type="range"
                    min={0}
                    max={1}
                    step={0.02}
                    value={st.bottomStrength}
                    onChange={(e) =>
                      set(
                        patchGroupEndpointStyle(spec, key, {
                          bottomStrength: Number(e.target.value),
                        }),
                      )
                    }
                  />
                  <span>{st.bottomStrength.toFixed(2)}</span>
                </label>
                <label style={lab}>
                  Bottom angle
                  <input
                    type="range"
                    min={-90}
                    max={90}
                    step={1}
                    value={Math.round((st.bottomAngleRad * 180) / Math.PI - 40)}
                    onChange={(e) =>
                      set(
                        patchGroupEndpointStyle(spec, key, {
                          bottomAngleRad:
                            ((Number(e.target.value) + 40) * Math.PI) / 180,
                        }),
                      )
                    }
                  />
                  <span>
                    {Math.round((st.bottomAngleRad * 180) / Math.PI - 40)}°
                  </span>
                </label>
                <label style={lab}>
                  Top strength
                  <input
                    type="range"
                    min={0}
                    max={1}
                    step={0.02}
                    value={st.topStrength}
                    onChange={(e) =>
                      set(
                        patchGroupEndpointStyle(spec, key, {
                          topStrength: Number(e.target.value),
                        }),
                      )
                    }
                  />
                  <span>{st.topStrength.toFixed(2)}</span>
                </label>
                <label style={lab}>
                  Top angle
                  <input
                    type="range"
                    min={-90}
                    max={90}
                    step={1}
                    value={Math.round((st.topAngleRad * 180) / Math.PI + 45)}
                    onChange={(e) =>
                      set(
                        patchGroupEndpointStyle(spec, key, {
                          topAngleRad:
                            ((Number(e.target.value) - 45) * Math.PI) / 180,
                        }),
                      )
                    }
                  />
                  <span>
                    {Math.round((st.topAngleRad * 180) / Math.PI + 45)}°
                  </span>
                </label>
              </div>
            );
          })}
        </div>
      </div>
      <label style={lab}>
        Semi axis X
        <input
          type="range"
          min={0.05}
          max={0.2}
          step={0.001}
          value={spec.semiAxisX}
          onChange={(e) => set({ semiAxisX: Number(e.target.value) })}
        />
        <span>{spec.semiAxisX.toFixed(3)}</span>
      </label>
      <label style={lab}>
        Semi axis Y
        <input
          type="range"
          min={0.05}
          max={0.25}
          step={0.001}
          value={spec.semiAxisY}
          onChange={(e) => set({ semiAxisY: Number(e.target.value) })}
        />
        <span>{spec.semiAxisY.toFixed(3)}</span>
      </label>
      <label style={lab}>
        Crown height
        <input
          type="range"
          min={0.05}
          max={0.3}
          step={0.005}
          value={spec.crownHeight}
          onChange={(e) => set({ crownHeight: Number(e.target.value) })}
        />
        <span>{spec.crownHeight.toFixed(3)}</span>
      </label>
      <label style={lab}>
        Seam groove depth (mm, inward at seams)
        <input
          type="range"
          min={0}
          max={1.5}
          step={0.05}
          value={spec.seamGrooveDepthM * 1000}
          onChange={(e) =>
            set({ seamGrooveDepthM: Number(e.target.value) / 1000 })
          }
        />
        <span>{(spec.seamGrooveDepthM * 1000).toFixed(2)}</span>
      </label>
      <label style={lab}>
        Top button ring (fraction of rim)
        <input
          type="range"
          min={0}
          max={0.2}
          step={0.002}
          value={spec.topRimFraction}
          onChange={(e) => set({ topRimFraction: Number(e.target.value) })}
        />
        <span>{spec.topRimFraction.toFixed(3)}</span>
      </label>
      <div
        style={{
          ...lab,
          borderTop: "1px solid #374151",
          paddingTop: 10,
        }}
      >
        <div style={{ ...lab, marginTop: 0 }}>
          <span style={{ fontWeight: 600 }}>Back closure</span>
          <div
            style={{
              display: "flex",
              flexWrap: "wrap",
              gap: 8,
              marginTop: 8,
            }}
          >
            <button
              type="button"
              onClick={() =>
                set({ backClosureOpening: false, closures: [] })
              }
              style={{
                flex: "1 1 28%",
                minWidth: 64,
                padding: "8px 10px",
                borderRadius: 6,
                border:
                  !spec.backClosureOpening
                    ? "1px solid #3b82f6"
                    : "1px solid #374151",
                background: !spec.backClosureOpening ? "#1e3a5f" : "#1f2937",
                color: "#e5e7eb",
                cursor: "pointer",
                fontSize: 12,
              }}
            >
              None
            </button>
            {CLOSURE_OPTIONS.map((opt) => {
              const active =
                spec.backClosureOpening &&
                spec.closures.some((c) => c.type === opt.type);
              return (
                <button
                  key={opt.type}
                  type="button"
                  onClick={() =>
                    set({
                      backClosureOpening: true,
                      closures: [{ type: opt.type } satisfies HatClosureSpec],
                    })
                  }
                  style={{
                    flex: "1 1 28%",
                    minWidth: 64,
                    padding: "8px 10px",
                    borderRadius: 6,
                    border: active
                      ? "1px solid #3b82f6"
                      : "1px solid #374151",
                    background: active ? "#1e3a5f" : "#1f2937",
                    color: "#e5e7eb",
                    cursor: "pointer",
                    fontSize: 12,
                  }}
                >
                  {opt.label}
                </button>
              );
            })}
          </div>
        </div>
        <div style={{ ...lab, marginTop: 8 }}>
          <span style={{ fontWeight: 600 }}>Eyelets</span>
          <div style={{ display: "flex", gap: 8 }}>
            {(["none", "cloth", "metal"] as const satisfies readonly EyeletStyle[]).map(
              (opt) => {
                const active = spec.eyeletStyle === opt;
                return (
                  <button
                    key={opt}
                    type="button"
                    onClick={() => set({ eyeletStyle: opt })}
                    style={{
                      flex: 1,
                      padding: "8px 10px",
                      borderRadius: 6,
                      border: active ? "1px solid #3b82f6" : "1px solid #374151",
                      background: active ? "#1e3a5f" : "#1f2937",
                      color: "#e5e7eb",
                      cursor: "pointer",
                      fontSize: 12,
                      textTransform: "capitalize",
                    }}
                  >
                    {opt}
                  </button>
                );
              },
            )}
          </div>
        </div>
        {spec.eyeletStyle !== "none" && (
          <label style={lab}>
            Eyelet drop from crown top (m)
            <input
              type="range"
              min={0.02}
              max={0.12}
              step={0.001}
              value={spec.eyeletDropFromTopM}
              onChange={(e) =>
                set({ eyeletDropFromTopM: Number(e.target.value) })
              }
            />
            <span>{spec.eyeletDropFromTopM.toFixed(3)}</span>
          </label>
        )}
      </div>
    </div>
  );
}

const lab: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 4,
  marginBottom: 10,
  fontSize: 12,
};

const MEASUREMENT_SOLVE_DEBOUNCE_MS = 120;
const PERSIST_DEBOUNCE_MS = 320;

export function HatViewer() {
  const storeRef = useRef<ReturnType<typeof readHatlabStore> | null>(null);
  if (storeRef.current === null) {
    storeRef.current = readHatlabStore();
  }
  const [hats, setHats] = useState<HatDocument[]>(
    () => storeRef.current!.hats,
  );
  const [activeHatId, setActiveHatId] = useState<string>(
    () => storeRef.current!.activeHatId,
  );

  const measurementSolveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );
  const lastSolvedMeasurementTargetsRef = useRef<HatMeasurementTargets | null>(
    measurementTargetsFromSpec(mergeHatSpecDefaults(defaultHatSkeletonSpec())),
  );
  const persistTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const prevActiveHatIdRef = useRef<string | null>(null);
  const importFileRef = useRef<HTMLInputElement | null>(null);
  const importBulkFilesRef = useRef<HTMLInputElement | null>(null);
  const decalFileRef = useRef<HTMLInputElement | null>(null);
  const importModeRef = useRef<"replace" | "new">("replace");
  const [decalTexture, setDecalTexture] = useState<THREE.Texture | null>(null);
  const [rearLaserEtchMode, setRearLaserEtchMode] =
    useState<RearLaserEtchMode>("none");

  const activeHat = useMemo(() => {
    const h = hats.find((x) => x.id === activeHatId);
    return h ?? hats[0]!;
  }, [hats, activeHatId]);

  useEffect(() => {
    const url = activeHat.decal?.imageDataUrl;
    if (!url) {
      setDecalTexture((prev) => {
        prev?.dispose();
        return null;
      });
      return;
    }
    const loader = new THREE.TextureLoader();
    let cancelled = false;
    loader.load(
      url,
      (tex) => {
        tex.colorSpace = THREE.SRGBColorSpace;
        if (cancelled) {
          tex.dispose();
          return;
        }
        setDecalTexture((prev) => {
          prev?.dispose();
          return tex;
        });
      },
      undefined,
      () => {
        if (!cancelled) {
          setDecalTexture((prev) => {
            prev?.dispose();
            return null;
          });
        }
      },
    );
    return () => {
      cancelled = true;
    };
  }, [activeHat.decal?.imageDataUrl]);

  const effectiveMeasurementTargets = useMemo(
    () =>
      mergeEffectiveMeasurementTargets(
        activeHat.measurementBase,
        activeHat.activeVisorShape,
        activeHat.visorShapeOverrides,
      ),
    [
      activeHat.measurementBase,
      activeHat.activeVisorShape,
      activeHat.visorShapeOverrides,
    ],
  );

  useEffect(() => {
    if (hats.some((h) => h.id === activeHatId)) return;
    if (hats[0]) setActiveHatId(hats[0].id);
  }, [hats, activeHatId]);

  useEffect(() => {
    if (prevActiveHatIdRef.current === activeHatId) return;
    prevActiveHatIdRef.current = activeHatId;
    const h = hats.find((x) => x.id === activeHatId);
    if (h) {
      lastSolvedMeasurementTargetsRef.current = mergeEffectiveMeasurementTargets(
        h.measurementBase,
        h.activeVisorShape,
        h.visorShapeOverrides,
      );
    }
  }, [activeHatId, hats]);

  useEffect(() => {
    const mt = effectiveMeasurementTargets;
    if (measurementSolveTimerRef.current) {
      clearTimeout(measurementSolveTimerRef.current);
    }
    measurementSolveTimerRef.current = setTimeout(() => {
      measurementSolveTimerRef.current = null;
      setHats((hs) =>
        hs.map((h) => {
          if (h.id !== activeHatId) return h;
          const lastSolved = lastSolvedMeasurementTargetsRef.current;
          lastSolvedMeasurementTargetsRef.current = mt;
          let nextSpec = h.spec;
          if (!shouldSkipMeasurementSolve(h.spec, lastSolved, mt)) {
            nextSpec = mergeHatSpecDefaults(
              solveHatSpecFromMeasurementsIncremental(h.spec, lastSolved, mt),
            );
          }
          nextSpec = finalizeSpecForVisorShape(
            nextSpec,
            h.activeVisorShape,
            h.visorShapeOverrides,
          );
          return { ...h, spec: nextSpec, updatedAt: Date.now() };
        }),
      );
    }, MEASUREMENT_SOLVE_DEBOUNCE_MS);
    return () => {
      if (measurementSolveTimerRef.current) {
        clearTimeout(measurementSolveTimerRef.current);
        measurementSolveTimerRef.current = null;
      }
    };
  }, [effectiveMeasurementTargets, activeHatId]);

  useEffect(() => {
    if (persistTimerRef.current) clearTimeout(persistTimerRef.current);
    persistTimerRef.current = setTimeout(() => {
      persistTimerRef.current = null;
      writeHatlabStore({ schemaVersion: 1, activeHatId, hats });
    }, PERSIST_DEBOUNCE_MS);
    return () => {
      if (persistTimerRef.current) clearTimeout(persistTimerRef.current);
    };
  }, [activeHatId, hats]);

  const patchDecal = useCallback(
    (next: HatDecalPersisted) => {
      setHats((hs) =>
        hs.map((h) =>
          h.id === activeHatId
            ? { ...h, decal: next, updatedAt: Date.now() }
            : h,
        ),
      );
    },
    [activeHatId],
  );

  const clearDecal = useCallback(() => {
    setHats((hs) =>
      hs.map((h) =>
        h.id === activeHatId
          ? { ...h, decal: undefined, updatedAt: Date.now() }
          : h,
      ),
    );
  }, [activeHatId]);

  const applySpecChange = useCallback(
    (patch: Partial<HatSkeletonSpec> | HatSkeletonSpec) => {
      setHats((hs) =>
        hs.map((h) => {
          if (h.id !== activeHatId) return h;
          const next = { ...h.spec, ...patch };
          const merged = mergeHatSpecDefaults(next);
          const finalized = finalizeSpecForVisorShape(
            merged,
            h.activeVisorShape,
            h.visorShapeOverrides,
          );
          return { ...h, spec: finalized, updatedAt: Date.now() };
        }),
      );
    },
    [activeHatId],
  );

  const patchMeasurementBase = useCallback(
    (patch: Partial<HatMeasurementTargets>) => {
      setHats((hs) =>
        hs.map((h) => {
          if (h.id !== activeHatId) return h;
          return {
            ...h,
            measurementBase: { ...h.measurementBase, ...patch },
            updatedAt: Date.now(),
          };
        }),
      );
    },
    [activeHatId],
  );

  const patchVisorShapeMeasurementOverride = useCallback(
    (patch: VisorMeasurementOverride) => {
      setHats((hs) =>
        hs.map((h) => {
          if (h.id !== activeHatId) return h;
          const shape = h.activeVisorShape;
          const prevO = h.visorShapeOverrides[shape] ?? {};
          return {
            ...h,
            visorShapeOverrides: {
              ...h.visorShapeOverrides,
              [shape]: {
                ...prevO,
                measurements: { ...prevO.measurements, ...patch },
              },
            },
            updatedAt: Date.now(),
          };
        }),
      );
    },
    [activeHatId],
  );

  const patchVisorOverride = useCallback(
    (patch: Partial<VisorSpec>) => {
      setHats((hs) =>
        hs.map((h) => {
          if (h.id !== activeHatId) return h;
          const shape = h.activeVisorShape;
          const prevO = h.visorShapeOverrides[shape] ?? {};
          const nextOverrides = {
            ...h.visorShapeOverrides,
            [shape]: {
              ...prevO,
              visor: { ...prevO.visor, ...patch },
            },
          };
          const nextSpec = finalizeSpecForVisorShape(
            mergeHatSpecDefaults(h.spec),
            shape,
            nextOverrides,
          );
          return {
            ...h,
            visorShapeOverrides: nextOverrides,
            spec: nextSpec,
            updatedAt: Date.now(),
          };
        }),
      );
    },
    [activeHatId],
  );

  const handleVisorShapeChange = useCallback(
    (shape: VisorShapeIndex) => {
      if (measurementSolveTimerRef.current) {
        clearTimeout(measurementSolveTimerRef.current);
        measurementSolveTimerRef.current = null;
      }
      setHats((hs) =>
        hs.map((h) => {
          if (h.id !== activeHatId) return h;
          const mt = mergeEffectiveMeasurementTargets(
            h.measurementBase,
            shape,
            h.visorShapeOverrides,
          );
          const lastSolved = lastSolvedMeasurementTargetsRef.current;
          lastSolvedMeasurementTargetsRef.current = mt;
          let nextSpec = h.spec;
          if (!shouldSkipMeasurementSolve(h.spec, lastSolved, mt)) {
            nextSpec = mergeHatSpecDefaults(
              solveHatSpecFromMeasurementsIncremental(h.spec, lastSolved, mt),
            );
          }
          nextSpec = finalizeSpecForVisorShape(
            nextSpec,
            shape,
            h.visorShapeOverrides,
          );
          return {
            ...h,
            activeVisorShape: shape,
            spec: nextSpec,
            updatedAt: Date.now(),
          };
        }),
      );
    },
    [activeHatId],
  );

  const newHat = useCallback(() => {
    const d = createDefaultHatDocument();
    setHats((hs) => [...hs, d]);
    setActiveHatId(d.id);
  }, []);

  const duplicateHat = useCallback(() => {
    const h = hats.find((x) => x.id === activeHatId);
    if (!h) return;
    const copy: HatDocument = {
      ...h,
      id: crypto.randomUUID(),
      name: `${h.name} (copy)`,
      updatedAt: Date.now(),
    };
    setHats((hs) => [...hs, copy]);
    setActiveHatId(copy.id);
  }, [hats, activeHatId]);

  const renameHat = useCallback(() => {
    const h = hats.find((x) => x.id === activeHatId);
    if (!h) return;
    const next = window.prompt("Hat name", h.name);
    if (next === null || next.trim() === "") return;
    const name = next.trim();
    setHats((hs) =>
      hs.map((x) =>
        x.id === activeHatId ? { ...x, name, updatedAt: Date.now() } : x,
      ),
    );
  }, [hats, activeHatId]);

  const deleteHat = useCallback(() => {
    if (hats.length <= 1) return;
    const idx = hats.findIndex((x) => x.id === activeHatId);
    const next = hats.filter((x) => x.id !== activeHatId);
    const nextId = next[Math.max(0, idx - 1)]?.id ?? next[0]?.id;
    setHats(next);
    if (nextId) setActiveHatId(nextId);
  }, [hats, activeHatId]);

  const exportJson = useCallback(() => {
    const h = hats.find((x) => x.id === activeHatId);
    if (!h) return;
    const safe = h.name.replace(/[^\w\-]+/g, "-").replace(/^-|-$/g, "") || "hat";
    downloadTextFile(serializeHatDocument(h), `${safe}.json`);
  }, [hats, activeHatId]);

  const importJsonFile = useCallback(
    (file: File, mode: "replace" | "new") => {
      const reader = new FileReader();
      reader.onload = () => {
        try {
          const doc = parseHatDocumentJSON(String(reader.result));
          validateSpec(doc.spec);
          if (mode === "replace") {
            setHats((hs) =>
              hs.map((h) =>
                h.id === activeHatId
                  ? { ...doc, id: h.id, updatedAt: Date.now() }
                  : h,
              ),
            );
          } else {
            const copy: HatDocument = {
              ...doc,
              id: crypto.randomUUID(),
              updatedAt: Date.now(),
            };
            setHats((hs) => [...hs, copy]);
            setActiveHatId(copy.id);
          }
        } catch {
          window.alert("Invalid hat JSON file.");
        }
      };
      reader.readAsText(file);
    },
    [activeHatId],
  );

  const importJsonFiles = useCallback(async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    const added: HatDocument[] = [];
    const failed: string[] = [];
    for (const file of Array.from(files)) {
      try {
        const text = await file.text();
        const raw = JSON.parse(text) as unknown;
        const docs: HatDocument[] =
          typeof raw === "object" &&
          raw !== null &&
          !Array.isArray(raw) &&
          (raw as { schemaVersion?: unknown }).schemaVersion === 1 &&
          Array.isArray((raw as { hats?: unknown }).hats)
            ? parseHatlabStoreJSON(text).hats
            : (() => {
                const doc = parseHatDocumentJSON(text);
                validateSpec(doc.spec);
                return [doc];
              })();
        for (const doc of docs) {
          try {
            validateSpec(doc.spec);
          } catch {
            failed.push(`${file.name} (${doc.name})`);
            continue;
          }
          added.push({
            ...doc,
            id: crypto.randomUUID(),
            updatedAt: Date.now(),
          });
        }
      } catch {
        failed.push(file.name);
      }
    }
    if (added.length > 0) {
      setHats((hs) => [...hs, ...added]);
      setActiveHatId(added[added.length - 1]!.id);
    }
    if (failed.length > 0) {
      window.alert(`Could not import: ${failed.join(", ")}`);
    }
  }, []);

  const deferredSpec = useDeferredValue(activeHat.spec);
  const [measurementHighlight, setMeasurementHighlight] =
    useState<MeasurementFieldHighlight>(null);
  const [exporting, setExporting] = useState(false);
  const [exportingFull, setExportingFull] = useState(false);
  const [exportingAllZip, setExportingAllZip] = useState(false);
  const [exportingAllJsonZip, setExportingAllJsonZip] = useState(false);
  const [exportingAllFolder, setExportingAllFolder] = useState(false);
  const [folderExportSupported, setFolderExportSupported] = useState(false);

  useEffect(() => {
    setFolderExportSupported(isFolderExportSupported());
  }, []);

  const exportingAll = exportingAllZip || exportingAllJsonZip || exportingAllFolder;
  const anyExportBusy = exporting || exportingFull || exportingAll;

  const onDownload = useCallback(async () => {
    try {
      validateSpec(activeHat.spec);
    } catch {
      return;
    }
    setExporting(true);
    try {
      const g = buildHatExportGroup(activeHat.spec);
      await appendHatDecalToSimpleExport(g, activeHat);
      computeTangentsForExport(g);
      const blob = await exportObjectToGLB(g);
      downloadBlob(blob, "hat-skeleton.glb");
      g.traverse((o) => {
        if (o instanceof THREE.Mesh) {
          o.geometry.dispose();
          const m = o.material;
          const mats = Array.isArray(m) ? m : [m];
          for (const mat of mats) {
            if (mat instanceof THREE.MeshStandardMaterial) {
              mat.map?.dispose();
              mat.normalMap?.dispose();
              mat.roughnessMap?.dispose();
              mat.metalnessMap?.dispose();
              mat.aoMap?.dispose();
            }
            mat.dispose();
          }
        }
      });
    } finally {
      setExporting(false);
    }
  }, [activeHat]);

  const onExportFullHat = useCallback(async () => {
    try {
      validateSpec(activeHat.spec);
    } catch {
      return;
    }
    setExportingFull(true);
    try {
      const root = buildFullHatExportRoot(activeHat, {
        modelPrefix: resolveExportModelPrefix(activeHat.name),
      });
      const decalBaseTex = await appendHatDecalToFullExport(root, activeHat);
      try {
        computeTangentsForExport(root);
        const blob = await exportObjectToGLB(root);
        const safe =
          activeHat.name.replace(/[^\w\-]+/g, "-").replace(/^-|-$/g, "") ||
          "hat";
        downloadBlob(blob, `${safe}-full.glb`);
      } finally {
        disposeExportObject3D(root);
        decalBaseTex?.dispose();
      }
    } finally {
      setExportingFull(false);
    }
  }, [activeHat]);

  const onExportAllZip = useCallback(async () => {
    if (hats.length === 0) return;
    setExportingAllZip(true);
    try {
      const result = await buildAllHatsZipBlob(hats);
      if (result.exportedCount === 0) {
        window.alert(
          result.errors.length > 0
            ? "No hats could be exported (all have invalid specs)."
            : "No saved hats to export.",
        );
        return;
      }
      downloadBlob(result.blob, `hatlab-all-hats-${Date.now()}.zip`);
      if (result.errors.length > 0) {
        const lines = result.errors.slice(0, 15);
        const more =
          result.errors.length > 15
            ? `\n… and ${result.errors.length - 15} more`
            : "";
        window.alert(
          `Skipped ${result.errors.length} hat(s) with invalid spec:\n${lines.join("\n")}${more}`,
        );
      }
    } finally {
      setExportingAllZip(false);
    }
  }, [hats]);

  const onExportAllJsonZip = useCallback(async () => {
    if (hats.length === 0) return;
    setExportingAllJsonZip(true);
    try {
      const result = await buildAllHatsJsonZipBlob(hats);
      if (result.exportedCount === 0) {
        window.alert(
          result.errors.length > 0
            ? "No hats could be exported (all have invalid specs)."
            : "No saved hats to export.",
        );
        return;
      }
      downloadBlob(result.blob, `hatlab-all-hats-json-${Date.now()}.zip`);
      if (result.errors.length > 0) {
        const lines = result.errors.slice(0, 15);
        const more =
          result.errors.length > 15
            ? `\n… and ${result.errors.length - 15} more`
            : "";
        window.alert(
          `Skipped ${result.errors.length} hat(s) with invalid spec:\n${lines.join("\n")}${more}`,
        );
      }
    } finally {
      setExportingAllJsonZip(false);
    }
  }, [hats]);

  const onExportAllToFolder = useCallback(async () => {
    if (hats.length === 0) return;
    setExportingAllFolder(true);
    try {
      const result = await exportAllHatsToPickedDirectory(hats);
      if (result.exportedCount === 0) {
        window.alert(
          result.errors.length > 0
            ? "No hats could be exported (all have invalid specs)."
            : "No saved hats to export.",
        );
        return;
      }
      if (result.errors.length > 0) {
        const lines = result.errors.slice(0, 15);
        const more =
          result.errors.length > 15
            ? `\n… and ${result.errors.length - 15} more`
            : "";
        window.alert(
          `Skipped ${result.errors.length} hat(s) with invalid spec:\n${lines.join("\n")}${more}`,
        );
      }
    } catch (e) {
      if (e instanceof DOMException && e.name === "AbortError") return;
      const msg = e instanceof Error ? e.message : String(e);
      window.alert(`Folder export failed: ${msg}`);
    } finally {
      setExportingAllFolder(false);
    }
  }, [hats]);

  const btnStyle = (active?: boolean): CSSProperties => ({
    padding: "6px 8px",
    borderRadius: 6,
    border: active ? "1px solid #3b82f6" : "1px solid #374151",
    background: active ? "#1e3a5f" : "#1f2937",
    color: "#e5e7eb",
    cursor: "pointer",
    fontSize: 11,
  });

  return (
    <div
      style={{
        display: "flex",
        width: "100%",
        height: "100vh",
        overflow: "hidden",
        background: "#0f0f12",
      }}
    >
      <aside
        style={{
          flex: "0 0 min(360px, 40vw)",
          maxWidth: 400,
          minWidth: 280,
          height: "100%",
          overflowY: "auto",
          overflowX: "hidden",
          borderRight: "1px solid #27272a",
          WebkitOverflowScrolling: "touch",
        }}
      >
        <input
          ref={importFileRef}
          type="file"
          accept="application/json,.json"
          style={{ display: "none" }}
          onChange={(e) => {
            const f = e.target.files?.[0];
            e.target.value = "";
            if (f) importJsonFile(f, importModeRef.current);
          }}
        />
        <input
          ref={importBulkFilesRef}
          type="file"
          accept="application/json,.json"
          multiple
          style={{ display: "none" }}
          onChange={(e) => {
            void importJsonFiles(e.target.files);
            e.target.value = "";
          }}
        />
        <div
          style={{
            boxSizing: "border-box",
            padding: "12px 16px 0",
            borderBottom: "1px solid #27272a",
          }}
        >
          <div
            style={{
              fontSize: 12,
              fontWeight: 600,
              marginBottom: 8,
              color: "#e5e7eb",
            }}
          >
            Saved hats
          </div>
          <div
            style={{
              display: "flex",
              flexWrap: "wrap",
              gap: 6,
              alignItems: "center",
              marginBottom: 8,
            }}
          >
            <select
              value={activeHatId}
              onChange={(e) => setActiveHatId(e.target.value)}
              style={{
                flex: "1 1 140px",
                minWidth: 0,
                padding: "6px 8px",
                borderRadius: 6,
                border: "1px solid #374151",
                background: "#1f2937",
                color: "#e5e7eb",
                fontSize: 12,
              }}
            >
              {hats.map((h) => (
                <option key={h.id} value={h.id}>
                  {h.name}
                </option>
              ))}
            </select>
            <button type="button" onClick={newHat} style={btnStyle()}>
              New
            </button>
            <button type="button" onClick={renameHat} style={btnStyle()}>
              Rename
            </button>
            <button type="button" onClick={duplicateHat} style={btnStyle()}>
              Duplicate
            </button>
            <button
              type="button"
              onClick={deleteHat}
              disabled={hats.length <= 1}
              style={{
                ...btnStyle(),
                opacity: hats.length <= 1 ? 0.45 : 1,
                cursor: hats.length <= 1 ? "not-allowed" : "pointer",
              }}
            >
              Delete
            </button>
          </div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 10 }}>
            <button type="button" onClick={exportJson} style={btnStyle()}>
              Export JSON
            </button>
            <button
              type="button"
              onClick={onExportAllJsonZip}
              disabled={anyExportBusy || hats.length === 0}
              style={{
                ...btnStyle(),
                opacity: hats.length === 0 ? 0.5 : 1,
                cursor:
                  anyExportBusy || hats.length === 0
                    ? "not-allowed"
                    : "pointer",
              }}
            >
              {exportingAllJsonZip ? "Building ZIP…" : "Export all JSON (ZIP)"}
            </button>
            <button
              type="button"
              onClick={() => {
                importModeRef.current = "replace";
                importFileRef.current?.click();
              }}
              style={btnStyle()}
            >
              Import (replace)
            </button>
            <button
              type="button"
              onClick={() => {
                importModeRef.current = "new";
                importFileRef.current?.click();
              }}
              style={btnStyle()}
            >
              Import as new
            </button>
            <button
              type="button"
              onClick={() => importBulkFilesRef.current?.click()}
              style={btnStyle()}
            >
              Import JSON files…
            </button>
          </div>
        </div>
        <div
          style={{
            boxSizing: "border-box",
            padding: "12px 16px 14px",
            borderBottom: "1px solid #27272a",
          }}
        >
          <div
            style={{
              fontSize: 12,
              fontWeight: 600,
              marginBottom: 8,
              color: "#e5e7eb",
            }}
          >
            Export mesh (GLB)
          </div>
          <button
            type="button"
            onClick={onDownload}
            disabled={anyExportBusy}
            style={{
              padding: "8px 14px",
              borderRadius: 6,
              border: "none",
              background: "#3b82f6",
              color: "#fff",
              cursor: anyExportBusy ? "wait" : "pointer",
              width: "100%",
              fontSize: 12,
            }}
          >
            {exporting ? "Exporting…" : "Download GLB"}
          </button>
          <button
            type="button"
            onClick={onExportFullHat}
            disabled={anyExportBusy}
            style={{
              marginTop: 8,
              padding: "8px 14px",
              borderRadius: 6,
              border: "1px solid #4b5563",
              background: "#27272a",
              color: "#e5e7eb",
              cursor: anyExportBusy ? "wait" : "pointer",
              width: "100%",
              fontSize: 12,
            }}
          >
            {exportingFull
              ? "Building full hat…"
              : "Export full hat (GLB)"}
          </button>
          <button
            type="button"
            onClick={onExportAllZip}
            disabled={anyExportBusy || hats.length === 0}
            style={{
              marginTop: 8,
              padding: "8px 14px",
              borderRadius: 6,
              border: "1px solid #4b5563",
              background: "#27272a",
              color: "#e5e7eb",
              cursor:
                anyExportBusy || hats.length === 0 ? "not-allowed" : "pointer",
              width: "100%",
              fontSize: 12,
              opacity: hats.length === 0 ? 0.5 : 1,
            }}
          >
            {exportingAllZip ? "Building ZIP…" : "Export all hats (ZIP)"}
          </button>
          {folderExportSupported ? (
            <button
              type="button"
              onClick={onExportAllToFolder}
              disabled={anyExportBusy || hats.length === 0}
              style={{
                marginTop: 8,
                padding: "8px 14px",
                borderRadius: 6,
                border: "1px solid #4b5563",
                background: "#27272a",
                color: "#e5e7eb",
                cursor:
                  anyExportBusy || hats.length === 0
                    ? "not-allowed"
                    : "pointer",
                width: "100%",
                fontSize: 12,
                opacity: hats.length === 0 ? 0.5 : 1,
              }}
            >
              {exportingAllFolder
                ? "Writing to folder…"
                : "Export all hats to folder…"}
            </button>
          ) : null}
          <div
            style={{
              marginTop: 12,
              paddingTop: 12,
              borderTop: "1px solid #27272a",
            }}
          >
            <div
              style={{
                fontSize: 12,
                fontWeight: 600,
                marginBottom: 6,
                color: "#e5e7eb",
              }}
            >
              Rear crown etch (viewer test)
            </div>
            <p
              style={{
                margin: "0 0 8px",
                opacity: 0.65,
                fontSize: 11,
                lineHeight: 1.35,
              }}
            >
              Alpha-test cutout on side and rear crown panels (all gray fabric
              except the front rise), not the neon seam tape (green) or
              sweatband (magenta). Not exported in GLB.
            </p>
            <label style={{ ...lab, marginBottom: 8 }}>
              Pattern
              <select
                value={rearLaserEtchMode}
                onChange={(e) =>
                  setRearLaserEtchMode(e.target.value as RearLaserEtchMode)
                }
                style={{
                  marginTop: 4,
                  padding: "6px 8px",
                  borderRadius: 6,
                  border: "1px solid #374151",
                  background: "#1f2937",
                  color: "#e5e7eb",
                  fontSize: 12,
                  width: "100%",
                }}
              >
                {(Object.keys(REAR_LASER_ETCH_LABELS) as RearLaserEtchMode[]).map(
                  (k) => (
                    <option key={k} value={k}>
                      {REAR_LASER_ETCH_LABELS[k]}
                    </option>
                  ),
                )}
              </select>
            </label>
          </div>
          <div
            style={{
              marginTop: 12,
              paddingTop: 12,
              borderTop: "1px solid #27272a",
            }}
          >
            <div
              style={{
                fontSize: 12,
                fontWeight: 600,
                marginBottom: 6,
                color: "#e5e7eb",
              }}
            >
              Front decal (logo)
            </div>
            <p
              style={{
                margin: "0 0 8px",
                opacity: 0.65,
                fontSize: 11,
                lineHeight: 1.35,
              }}
            >
              PNG with transparency works best. Alt+drag on the crown to move the
              decal (avoids conflicting with orbit). Included in GLB as mesh{" "}
              <span style={{ fontFamily: "monospace" }}>Decal_Logo</span> after
              export.
            </p>
            <input
              ref={decalFileRef}
              type="file"
              accept="image/png,image/jpeg,image/webp"
              style={{ display: "none" }}
              onChange={async (e) => {
                const f = e.target.files?.[0];
                e.target.value = "";
                if (!f) return;
                try {
                  const dataUrl = await readFileAsDataUrl(f);
                  const front =
                    frontRisePanelIndices(activeHat.spec.nSeams)[0] ?? 0;
                  patchDecal({
                    panelIndex: front,
                    position: [0, 0, 0],
                    zRotation: 0,
                    scale: [0.06, 0.06, 0.06],
                    imageDataUrl: dataUrl,
                  });
                } catch {
                  window.alert("Could not read image file.");
                }
              }}
            />
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
              <button
                type="button"
                onClick={() => decalFileRef.current?.click()}
                style={btnStyle()}
              >
                Choose image…
              </button>
              <button
                type="button"
                onClick={clearDecal}
                disabled={!activeHat.decal}
                style={{
                  ...btnStyle(),
                  opacity: !activeHat.decal ? 0.45 : 1,
                  cursor: !activeHat.decal ? "not-allowed" : "pointer",
                }}
              >
                Clear decal
              </button>
            </div>
          </div>
        </div>
        <Panel
          spec={activeHat.spec}
          onChange={applySpecChange}
          measurementTargets={effectiveMeasurementTargets}
          onMeasurementBaseChange={patchMeasurementBase}
          onVisorShapeMeasurementOverride={patchVisorShapeMeasurementOverride}
          onVisorOverrideChange={patchVisorOverride}
          activeVisorShape={activeHat.activeVisorShape}
          onActiveVisorShapeChange={handleVisorShapeChange}
          measurementHighlight={measurementHighlight}
          onMeasurementHighlightChange={setMeasurementHighlight}
        />
      </aside>
      <div style={{ flex: 1, minWidth: 0, minHeight: 0, position: "relative" }}>
        <Canvas
          gl={{ antialias: true }}
          style={{ width: "100%", height: "100%", background: "#0f0f12" }}
          dpr={[1, 2]}
        >
          <Suspense fallback={null}>
            <PerspectiveCamera
              makeDefault
              position={[0.35, 0.45, 0.35]}
              fov={50}
              near={0.002}
              far={40}
            />
            <color attach="background" args={["#0f0f12"]} />
            <ambientLight intensity={0.55} />
            <directionalLight position={[5, 8, 10]} intensity={1.1} />
            <directionalLight position={[-4, 2, -3]} intensity={0.35} />
            <HatModel
              spec={deferredSpec}
              measurementHighlight={measurementHighlight}
              decal={activeHat.decal ?? null}
              decalTexture={decalTexture}
              onDecalChange={patchDecal}
              rearLaserEtchMode={rearLaserEtchMode}
            />
            <OrbitControls makeDefault enableDamping dampingFactor={0.08} />
          </Suspense>
        </Canvas>
      </div>
    </div>
  );
}
