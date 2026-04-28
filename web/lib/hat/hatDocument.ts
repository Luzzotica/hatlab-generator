import { VISOR_CURVATURE_PLANFORM_K } from "@/lib/skeleton/geometry";
import {
  defaultHatSkeletonSpec,
  defaultVisorSpec,
  mergeHatSpecDefaults,
  type HatMeasurementTargets,
  type HatSkeletonSpec,
  type VisorSpec,
} from "@/lib/skeleton/types";
import { measurementTargetsFromSpec } from "@/lib/skeleton/measurements";
import type { HatDecalPersisted } from "@/lib/decal/crownDecal";

export const HATLAB_STORE_KEY = "hatlab:hats:v1";

export const VISOR_SHAPE_CURVATURE_MS = [0, 0.015, 0.02, 0.03] as const;

/**
 * Multiplies visor thread forward (`b`) depth; index matches {@link VISOR_SHAPE_CURVATURE_MS}.
 * Slightly &lt; 1 on deeper curves so stitching stays proportional as effective brim length grows.
 */
export const VISOR_THREAD_PLANFORM_DEPTH_SCALE_BY_SHAPE = [
  1,
  0.988,
  0.976,
  0.964,
] as const;

export type VisorShapeIndex = 0 | 1 | 2 | 3;

export const VISOR_SHAPE_LABELS: readonly string[] = [
  "Flat",
  "1.5 cm",
  "2 cm",
  "3 cm",
];

export type VisorMeasurementOverride = Partial<
  Pick<HatMeasurementTargets, "visorLengthM" | "visorWidthM">
>;

export interface VisorShapeOverride {
  measurements?: VisorMeasurementOverride;
  visor?: Partial<VisorSpec>;
}

export interface HatDocument {
  schemaVersion: 1;
  id: string;
  name: string;
  updatedAt: number;
  activeVisorShape: VisorShapeIndex;
  measurementBase: HatMeasurementTargets;
  visorShapeOverrides: Partial<Record<VisorShapeIndex, VisorShapeOverride>>;
  spec: HatSkeletonSpec;
  /** Optional front crown decal (logo); embedded in GLB as mesh `Decal_Logo` when present. */
  decal?: HatDecalPersisted;
}

export type { HatDecalPersisted };

export interface HatlabStoreV1 {
  schemaVersion: 1;
  activeHatId: string;
  hats: HatDocument[];
}

export function isVisorShapeIndex(n: number): n is VisorShapeIndex {
  return n === 0 || n === 1 || n === 2 || n === 3;
}

export function visorShapeIndexFromCurvatureM(curvature: number): VisorShapeIndex {
  const i = VISOR_SHAPE_CURVATURE_MS.findIndex(
    (c) => Math.abs(c - curvature) < 1e-9,
  );
  return (i >= 0 ? i : 0) as VisorShapeIndex;
}

export function mergeMeasurementTargetsWithDefaults(
  partial: Partial<HatMeasurementTargets>,
): HatMeasurementTargets {
  const d = measurementTargetsFromSpec(mergeHatSpecDefaults(defaultHatSkeletonSpec()));
  return { ...d, ...partial };
}

export function effectiveMeasurementTargets(
  measurementBase: HatMeasurementTargets,
  activeVisorShape: VisorShapeIndex,
  visorShapeOverrides: Partial<Record<VisorShapeIndex, VisorShapeOverride>>,
): HatMeasurementTargets {
  const patch = visorShapeOverrides[activeVisorShape]?.measurements;
  if (!patch) return measurementBase;
  return { ...measurementBase, ...patch };
}

/**
 * Merge solver output with per-shape visor UI overrides; always set curvature from the active shape.
 */
export function finalizeSpecForVisorShape(
  spec: HatSkeletonSpec,
  activeVisorShape: VisorShapeIndex,
  visorShapeOverrides: Partial<Record<VisorShapeIndex, VisorShapeOverride>>,
): HatSkeletonSpec {
  const m = mergeHatSpecDefaults(spec);
  const patch = visorShapeOverrides[activeVisorShape]?.visor;
  const curve = VISOR_SHAPE_CURVATURE_MS[activeVisorShape];
  const prevC = m.visor.visorCurvatureM ?? 0;
  const K = VISOR_CURVATURE_PLANFORM_K;
  const projection =
    patch?.projection !== undefined
      ? patch.projection
      : Math.abs(curve - prevC) > 1e-12
        ? (m.visor.projection * (1 + K * prevC)) / (1 + K * curve)
        : m.visor.projection;
  return {
    ...m,
    visor: {
      ...m.visor,
      ...patch,
      visorCurvatureM: curve,
      projection,
    },
  };
}

export function createDefaultHatDocument(): HatDocument {
  const spec = mergeHatSpecDefaults(defaultHatSkeletonSpec());
  const mt = measurementTargetsFromSpec(spec);
  return {
    schemaVersion: 1,
    id: crypto.randomUUID(),
    name: "Untitled hat",
    updatedAt: Date.now(),
    activeVisorShape: 0,
    measurementBase: mt,
    visorShapeOverrides: {},
    spec: finalizeSpecForVisorShape(spec, 0, {}),
  };
}

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

function parseOptionalDecal(raw: unknown): HatDecalPersisted | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!isRecord(raw)) throw new Error("Invalid decal");
  if (typeof raw.panelIndex !== "number" || !Number.isFinite(raw.panelIndex)) {
    throw new Error("Invalid decal.panelIndex");
  }
  if (!Array.isArray(raw.position) || raw.position.length !== 3) {
    throw new Error("Invalid decal.position");
  }
  for (const x of raw.position) {
    if (typeof x !== "number" || !Number.isFinite(x)) {
      throw new Error("Invalid decal.position");
    }
  }
  if (typeof raw.zRotation !== "number" || !Number.isFinite(raw.zRotation)) {
    throw new Error("Invalid decal.zRotation");
  }
  if (!Array.isArray(raw.scale) || raw.scale.length !== 3) {
    throw new Error("Invalid decal.scale");
  }
  for (const x of raw.scale) {
    if (typeof x !== "number" || !Number.isFinite(x) || x <= 0) {
      throw new Error("Invalid decal.scale");
    }
  }
  if (typeof raw.imageDataUrl !== "string" || !raw.imageDataUrl) {
    throw new Error("Invalid decal.imageDataUrl");
  }
  return {
    panelIndex: raw.panelIndex,
    position: raw.position as [number, number, number],
    zRotation: raw.zRotation,
    scale: raw.scale as [number, number, number],
    imageDataUrl: raw.imageDataUrl,
  };
}

function parseHatDocumentLoose(raw: unknown): HatDocument {
  if (!isRecord(raw)) throw new Error("Invalid hat document");
  if (raw.schemaVersion !== 1) throw new Error("Unsupported schemaVersion");
  if (typeof raw.id !== "string" || !raw.id) throw new Error("Invalid id");
  if (typeof raw.name !== "string") throw new Error("Invalid name");
  if (typeof raw.updatedAt !== "number") throw new Error("Invalid updatedAt");
  const avs = raw.activeVisorShape;
  if (typeof avs !== "number" || !isVisorShapeIndex(avs)) {
    throw new Error("Invalid activeVisorShape");
  }
  if (!isRecord(raw.measurementBase)) throw new Error("Invalid measurementBase");
  if (!isRecord(raw.spec)) throw new Error("Invalid spec");
  const vo = raw.visorShapeOverrides;
  if (typeof vo !== "object" || vo === null || Array.isArray(vo)) {
    throw new Error("Invalid visorShapeOverrides");
  }

  const visorShapeOverrides = vo as Partial<
    Record<VisorShapeIndex, VisorShapeOverride>
  >;

  const measurementBase = mergeMeasurementTargetsWithDefaults(
    raw.measurementBase as Partial<HatMeasurementTargets>,
  );
  const spec = mergeHatSpecDefaults(raw.spec as unknown as HatSkeletonSpec);

  const decal =
    "decal" in raw && raw.decal !== undefined
      ? parseOptionalDecal(raw.decal)
      : undefined;

  return {
    schemaVersion: 1,
    id: raw.id,
    name: raw.name,
    updatedAt: raw.updatedAt,
    activeVisorShape: avs,
    measurementBase,
    visorShapeOverrides,
    spec: finalizeSpecForVisorShape(spec, avs, visorShapeOverrides),
    decal,
  };
}

export function parseHatDocumentJSON(json: string): HatDocument {
  const raw = JSON.parse(json) as unknown;
  return parseHatDocumentLoose(raw);
}

export function serializeHatDocument(doc: HatDocument): string {
  return JSON.stringify(doc, null, 2);
}

export function parseHatlabStoreJSON(json: string): HatlabStoreV1 {
  const raw = JSON.parse(json) as unknown;
  if (!isRecord(raw)) throw new Error("Invalid store");
  if (raw.schemaVersion !== 1) throw new Error("Unsupported store schemaVersion");
  if (typeof raw.activeHatId !== "string") throw new Error("Invalid activeHatId");
  if (!Array.isArray(raw.hats)) throw new Error("Invalid hats");
  const hats = raw.hats.map((h) => parseHatDocumentLoose(h));
  return { schemaVersion: 1, activeHatId: raw.activeHatId, hats };
}

export function serializeHatlabStore(store: HatlabStoreV1): string {
  return JSON.stringify(store, null, 2);
}

export function defaultHatlabStore(): HatlabStoreV1 {
  const hat = createDefaultHatDocument();
  return { schemaVersion: 1, activeHatId: hat.id, hats: [hat] };
}

export function readHatlabStore(): HatlabStoreV1 {
  if (typeof window === "undefined") return defaultHatlabStore();
  try {
    const s = window.localStorage.getItem(HATLAB_STORE_KEY);
    if (!s) return defaultHatlabStore();
    return parseHatlabStoreJSON(s);
  } catch {
    return defaultHatlabStore();
  }
}

export function writeHatlabStore(store: HatlabStoreV1): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(HATLAB_STORE_KEY, serializeHatlabStore(store));
  } catch {
    /* ignore quota */
  }
}

/** For tests: shallow check that visor curvature matches active shape after finalize. */
export function defaultVisorSpecForShape(shape: VisorShapeIndex): VisorSpec {
  return {
    ...defaultVisorSpec(),
    visorCurvatureM: VISOR_SHAPE_CURVATURE_MS[shape],
  };
}
