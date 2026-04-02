"use client";

import type { CSSProperties } from "react";
import {
  Suspense,
  useCallback,
  useDeferredValue,
  useEffect,
  useRef,
  useState,
} from "react";
import * as THREE from "three";
import { Canvas } from "@react-three/fiber";
import { OrbitControls, PerspectiveCamera } from "@react-three/drei";
import { HatModel } from "./HatModel";
import {
  defaultHatSkeletonSpec,
  mergeHatSpecDefaults,
  type FrontSeamMode,
  type HatMeasurementTargets,
  type HatSkeletonSpec,
  type SeamEndpointStyle,
  validateSpec,
} from "@/lib/skeleton/types";
import {
  measurementTargetsFromSpec,
  seamGroupIndices,
  shouldSkipMeasurementSolve,
  solveHatSpecFromMeasurementsIncremental,
  visorSpanRange,
} from "@/lib/skeleton";
import { resolveSeamEndpointStyleForIndex } from "@/lib/skeleton/geometry";
import { buildHatGroupFromSpec } from "@/lib/hat/buildHatGroup";
import type { MeasurementFieldHighlight } from "@/lib/hat/measurementHighlight";
import { exportObjectToGLB, downloadBlob } from "@/lib/export/gltf";

type SeamGroupKey = "front" | "sideFront" | "sideBack" | "rear";

function patchGroupEndpointStyle(
  spec: HatSkeletonSpec,
  groupKey: SeamGroupKey,
  patch: Partial<SeamEndpointStyle>
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
  onDownload,
  exporting,
  measurementTargets,
  onMeasurementTargetsChange,
  measurementHighlight,
  onMeasurementHighlightChange,
}: {
  spec: HatSkeletonSpec;
  onChange: (s: HatSkeletonSpec) => void;
  onDownload: () => void;
  exporting: boolean;
  measurementTargets: HatMeasurementTargets;
  onMeasurementTargetsChange: (t: HatMeasurementTargets) => void;
  measurementHighlight: MeasurementFieldHighlight;
  onMeasurementHighlightChange: (h: MeasurementFieldHighlight | null) => void;
}) {
  const v = spec.visor;
  const set = (patch: Partial<HatSkeletonSpec>) =>
    onChange({ ...spec, ...patch });
  const setVisor = (patch: Partial<typeof v>) =>
    onChange({ ...spec, visor: { ...v, ...patch } });

  const mt = measurementTargets;
  const setMt = (patch: Partial<HatMeasurementTargets>) =>
    onMeasurementTargetsChange({ ...mt, ...patch });

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
    field: Exclude<MeasurementFieldHighlight, null>
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
          {([5, 6] as const).map((n) => (
            <button
              key={n}
              type="button"
              onClick={() =>
                set({
                  nSeams: n,
                  seamAnglesRad: null,
                  seamSquarenessOverrides: [],
                  seamEndpointStyles: [],
                  seamTargetArcLengthM: [],
                })
              }
              style={{
                flex: 1,
                padding: "8px 10px",
                borderRadius: 6,
                border:
                  spec.nSeams === n
                    ? "1px solid #3b82f6"
                    : "1px solid #374151",
                background: spec.nSeams === n ? "#1e3a5f" : "#1f2937",
                color: "#e5e7eb",
                cursor: "pointer",
                fontSize: 12,
              }}
            >
              {n}-panel
            </button>
          ))}
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
        <p style={{ margin: "4px 0 8px", opacity: 0.65, fontSize: 11, lineHeight: 1.35 }}>
          Focus a field to highlight (green = base, amber = visor, magenta = seams).
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
              onChange={(e) =>
                setMt({ visorLengthM: Number(e.target.value) })
              }
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
                    value={Math.min(Math.max(mt.visorWidthM, range.min), range.max)}
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
            Half-span (max, rad)
            <input
              type="range"
              min={0.2}
              max={1.35}
              step={0.005}
              value={v.halfSpanRad}
              onChange={(e) => setVisor({ halfSpanRad: Number(e.target.value) })}
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
                setVisor({ superellipseN: Number(e.target.value), mode: "superellipse" })
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
          {(spec.nSeams === 6
            ? (["front", "sideFront", "sideBack", "rear"] as const)
            : (["front", "sideFront", "rear"] as const)
          ).map((key) => {
            const g = seamGroupIndices(spec.nSeams)[key];
            if (g.length === 0) return null;
            const idx = g[0]!;
            const st = resolveSeamEndpointStyleForIndex(spec, idx);
            const title =
              key === "front"
                ? spec.nSeams === 6
                  ? "Front center"
                  : "Front (center)"
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
                            background: mt.frontSeamMode === m ? "#1e3a5f" : "#1f2937",
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
                            onFocus={() => onMeasurementHighlightChange("seamFront")}
                            onChange={(e) =>
                              setMt({ seamFrontBaseLengthM: Number(e.target.value) })
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
                            onFocus={() => onMeasurementHighlightChange("seamFront")}
                            onChange={(e) =>
                              setMt({ seamFrontTopLengthM: Number(e.target.value) })
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
                              <span>{(spec.frontVSplit.legBottomStrength ?? 0).toFixed(2)}</span>
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
                              <span>{(spec.frontVSplit.legTopStrength ?? 0).toFixed(2)}</span>
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
                          onFocus={() => onMeasurementHighlightChange("seamFront")}
                          onChange={(e) =>
                            setMt({ seamEdgeLengthFrontM: Number(e.target.value) })
                          }
                        />
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
                      onFocus={() => onMeasurementHighlightChange("seamSideFront")}
                      onChange={(e) =>
                        setMt({ seamEdgeLengthSideFrontM: Number(e.target.value) })
                      }
                    />
                  </label>
                )}
                {key === "sideBack" && spec.nSeams === 6 && (
                  <label style={lab}>
                    Target arc length (rim → top)
                    <input
                      type="number"
                      step={0.001}
                      min={0.02}
                      value={mt.seamEdgeLengthSideBackM}
                      style={hiInput("seamSideBack")}
                      onFocus={() => onMeasurementHighlightChange("seamSideBack")}
                      onChange={(e) =>
                        setMt({ seamEdgeLengthSideBackM: Number(e.target.value) })
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
                        })
                      )
                    }
                  />
                  <span>{st.bottomStrength.toFixed(2)}</span>
                </label>
                <label style={lab}>
                  Bottom angle (deg,{" "}
                  {st.lockAnglesToSeamPlane
                    ? "0 = straight up at rim, 90 = outward in plane"
                    : "0 = along rim→top chord, 90 = outward in plane"}
                  <input
                    type="range"
                    min={-90}
                    max={90}
                    step={1}
                    value={(st.bottomAngleRad * 180) / Math.PI}
                    onChange={(e) =>
                      set(
                        patchGroupEndpointStyle(spec, key, {
                          bottomAngleRad: (Number(e.target.value) * Math.PI) / 180,
                        })
                      )
                    }
                  />
                  <span>{((st.bottomAngleRad * 180) / Math.PI).toFixed(0)}°</span>
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
                        })
                      )
                    }
                  />
                  <span>{st.topStrength.toFixed(2)}</span>
                </label>
                <label style={{ ...lab, flexDirection: "row", alignItems: "center", gap: 8 }}>
                  <input
                    type="checkbox"
                    checked={st.lockAnglesToSeamPlane}
                    onChange={(e) =>
                      set(
                        patchGroupEndpointStyle(spec, key, {
                          lockAnglesToSeamPlane: e.target.checked,
                        })
                      )
                    }
                  />
                  <span>Lock handle angles to seam plane</span>
                </label>
                {st.lockAnglesToSeamPlane ? null : (
                  <label style={lab}>
                    Top angle (deg)
                    <input
                      type="range"
                      min={-90}
                      max={90}
                      step={1}
                      value={(st.topAngleRad * 180) / Math.PI}
                      onChange={(e) =>
                        set(
                          patchGroupEndpointStyle(spec, key, {
                            topAngleRad: (Number(e.target.value) * Math.PI) / 180,
                          })
                        )
                      }
                    />
                    <span>{((st.topAngleRad * 180) / Math.PI).toFixed(0)}°</span>
                  </label>
                )}
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
      {spec.nSeams === 5 && (
        <div
          style={{
            ...lab,
            borderTop: "1px solid #374151",
            paddingTop: 10,
          }}
        >
          <span style={{ fontWeight: 600 }}>5-panel front edges (seams 0 &amp; 1)</span>
          <label style={{ ...lab, flexDirection: "row", alignItems: "center", gap: 8 }}>
            <input
              type="checkbox"
              checked={spec.fivePanelFrontSeams !== null}
              onChange={(e) =>
                set({
                  fivePanelFrontSeams: e.target.checked
                    ? {
                        visor: spec.seamSquareness,
                        crown: spec.seamSquareness,
                        splitT: 0.45,
                      }
                    : null,
                })
              }
            />
            <span>Split visor / crown along front seams</span>
          </label>
          {spec.fivePanelFrontSeams !== null && (
            <>
              <label style={lab}>
                Visor segment (rim → split)
                <input
                  type="range"
                  min={0}
                  max={1}
                  step={0.05}
                  value={spec.fivePanelFrontSeams.visor}
                  onChange={(e) =>
                    set({
                      fivePanelFrontSeams: {
                        ...spec.fivePanelFrontSeams!,
                        visor: Number(e.target.value),
                      },
                    })
                  }
                />
                <span>{spec.fivePanelFrontSeams.visor.toFixed(2)}</span>
              </label>
              <label style={lab}>
                Crown segment (split → button)
                <input
                  type="range"
                  min={0}
                  max={1}
                  step={0.05}
                  value={spec.fivePanelFrontSeams.crown}
                  onChange={(e) =>
                    set({
                      fivePanelFrontSeams: {
                        ...spec.fivePanelFrontSeams!,
                        crown: Number(e.target.value),
                      },
                    })
                  }
                />
                <span>{spec.fivePanelFrontSeams.crown.toFixed(2)}</span>
              </label>
              <label style={lab}>
                Split position (along seam)
                <input
                  type="range"
                  min={0.1}
                  max={0.9}
                  step={0.02}
                  value={spec.fivePanelFrontSeams.splitT}
                  onChange={(e) =>
                    set({
                      fivePanelFrontSeams: {
                        ...spec.fivePanelFrontSeams!,
                        splitT: Number(e.target.value),
                      },
                    })
                  }
                />
                <span>{spec.fivePanelFrontSeams.splitT.toFixed(2)}</span>
              </label>
            </>
          )}
        </div>
      )}
      {spec.nSeams === 5 ? (
        <label style={lab}>
          5-panel center seam (from button)
          <input
            type="range"
            min={0}
            max={0.95}
            step={0.02}
            value={spec.fivePanelCenterSeamLength}
            onChange={(e) =>
              set({ fivePanelCenterSeamLength: Number(e.target.value) })
            }
          />
          <span>{spec.fivePanelCenterSeamLength.toFixed(2)}</span>
        </label>
      ) : null}
      <div
        style={{
          ...lab,
          borderTop: "1px solid #374151",
          paddingTop: 10,
        }}
      >
        <label style={{ ...lab, flexDirection: "row", alignItems: "center", gap: 8 }}>
          <input
            type="checkbox"
            checked={spec.backClosureOpening}
            onChange={(e) => set({ backClosureOpening: e.target.checked })}
          />
          <span>Back closure opening</span>
        </label>
      </div>
      <button
        type="button"
        onClick={onDownload}
        disabled={exporting}
        style={{
          marginTop: 12,
          padding: "8px 14px",
          borderRadius: 6,
          border: "none",
          background: "#3b82f6",
          color: "#fff",
          cursor: exporting ? "wait" : "pointer",
          width: "100%",
        }}
      >
        {exporting ? "Exporting…" : "Download GLB"}
      </button>
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

export function HatViewer() {
  const [spec, setSpecRaw] = useState<HatSkeletonSpec>(() =>
    mergeHatSpecDefaults(defaultHatSkeletonSpec())
  );
  const setSpec = useCallback((s: HatSkeletonSpec) => {
    setSpecRaw(mergeHatSpecDefaults(s));
  }, []);
  const measurementSolveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastSolvedMeasurementTargetsRef = useRef<HatMeasurementTargets | null>(
    measurementTargetsFromSpec(mergeHatSpecDefaults(defaultHatSkeletonSpec()))
  );
  const [measurementTargets, setMeasurementTargetsRaw] =
    useState<HatMeasurementTargets>(() =>
      measurementTargetsFromSpec(mergeHatSpecDefaults(defaultHatSkeletonSpec()))
    );
  const setMeasurementTargets = useCallback((mt: HatMeasurementTargets) => {
    setMeasurementTargetsRaw(mt);
    if (measurementSolveTimerRef.current) {
      clearTimeout(measurementSolveTimerRef.current);
    }
    measurementSolveTimerRef.current = setTimeout(() => {
      measurementSolveTimerRef.current = null;
      const lastSolved = lastSolvedMeasurementTargetsRef.current;
      lastSolvedMeasurementTargetsRef.current = mt;
      setSpecRaw((prev) => {
        if (shouldSkipMeasurementSolve(prev, lastSolved, mt)) {
          return prev;
        }
        return mergeHatSpecDefaults(
          solveHatSpecFromMeasurementsIncremental(prev, lastSolved, mt)
        );
      });
    }, MEASUREMENT_SOLVE_DEBOUNCE_MS);
  }, []);
  useEffect(
    () => () => {
      if (measurementSolveTimerRef.current) {
        clearTimeout(measurementSolveTimerRef.current);
      }
    },
    []
  );

  const deferredSpec = useDeferredValue(spec);
  const [measurementHighlight, setMeasurementHighlight] =
    useState<MeasurementFieldHighlight>(null);
  const [exporting, setExporting] = useState(false);

  const onDownload = useCallback(async () => {
    try {
      validateSpec(spec);
    } catch {
      return;
    }
    setExporting(true);
    try {
      const g = buildHatGroupFromSpec(spec);
      const blob = await exportObjectToGLB(g);
      g.traverse((o) => {
        if (o instanceof THREE.Mesh) {
          o.geometry.dispose();
          const m = o.material;
          if (Array.isArray(m)) m.forEach((x) => x.dispose());
          else m.dispose();
        }
        if (o instanceof THREE.Line || o instanceof THREE.LineSegments) {
          o.geometry.dispose();
          (o.material as THREE.Material).dispose();
        }
      });
      downloadBlob(blob, "hat-skeleton.glb");
    } finally {
      setExporting(false);
    }
  }, [spec]);

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
        <Panel
          spec={spec}
          onChange={setSpec}
          onDownload={onDownload}
          exporting={exporting}
          measurementTargets={measurementTargets}
          onMeasurementTargetsChange={setMeasurementTargets}
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
            <PerspectiveCamera makeDefault position={[0.35, 0.45, 0.35]} fov={50} />
            <color attach="background" args={["#0f0f12"]} />
            <ambientLight intensity={0.55} />
            <directionalLight position={[5, 8, 10]} intensity={1.1} />
            <directionalLight position={[-4, 2, -3]} intensity={0.35} />
            <HatModel spec={deferredSpec} measurementHighlight={measurementHighlight} />
            <OrbitControls makeDefault enableDamping dampingFactor={0.08} />
          </Suspense>
        </Canvas>
      </div>
    </div>
  );
}
