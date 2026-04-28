import JSZip from "jszip";
import { describe, expect, it } from "vitest";
import { buildAllHatsJsonZipBlob } from "./bulkHatJsonExport";
import {
  createDefaultHatDocument,
  parseHatDocumentJSON,
  serializeHatDocument,
} from "@/lib/hat/hatDocument";
import { mergeHatSpecDefaults } from "@/lib/skeleton/types";

/** Top-level keys expected in every exported hat JSON (single-hat / ZIP entry). */
const REQUIRED_HAT_EXPORT_KEYS = [
  "schemaVersion",
  "id",
  "name",
  "updatedAt",
  "activeVisorShape",
  "measurementBase",
  "visorShapeOverrides",
  "spec",
] as const;

function assertExportedHatJsonIncludesCoreFields(json: string): void {
  const o = JSON.parse(json) as Record<string, unknown>;
  for (const k of REQUIRED_HAT_EXPORT_KEYS) {
    expect(o).toHaveProperty(k);
  }
  expect(o.schemaVersion).toBe(1);

  const mb = o.measurementBase as Record<string, unknown>;
  expect(typeof mb.baseCircumferenceM).toBe("number");
  expect(typeof mb.visorLengthM).toBe("number");
  expect(typeof mb.visorWidthM).toBe("number");
  expect(typeof mb.frontSeamMode).toBe("string");
  expect(typeof mb.seamEdgeLengthFrontM).toBe("number");

  const spec = o.spec as Record<string, unknown>;
  expect(spec.nSeams === 5 || spec.nSeams === 6).toBe(true);
  expect(Array.isArray(spec.closures)).toBe(true);
  expect(spec.visor).toBeDefined();
  expect(typeof (spec.visor as Record<string, unknown>).visorCurvatureM).toBe(
    "number",
  );
}

describe("serializeHatDocument (export JSON)", () => {
  it("includes required top-level fields and nested measurement/spec data", () => {
    const doc = createDefaultHatDocument();
    doc.name = "Export shape check";
    const json = serializeHatDocument(doc);
    assertExportedHatJsonIncludesCoreFields(json);
  });

  it("includes visorShapeOverrides (may be empty object)", () => {
    const doc = createDefaultHatDocument();
    const json = serializeHatDocument(doc);
    const o = JSON.parse(json) as { visorShapeOverrides: unknown };
    expect(typeof o.visorShapeOverrides).toBe("object");
    expect(o.visorShapeOverrides).not.toBeNull();
  });

  it("serializes decal when present", () => {
    const doc = createDefaultHatDocument();
    doc.decal = {
      panelIndex: 0,
      position: [0.01, 0.02, 0.03],
      zRotation: 0.25,
      scale: [1, 1.1, 1],
      imageDataUrl: "data:image/png;base64,AAAA",
    };
    const json = serializeHatDocument(doc);
    const o = JSON.parse(json) as {
      decal: {
        panelIndex: number;
        position: number[];
        imageDataUrl: string;
      };
    };
    expect(o.decal).toBeDefined();
    expect(o.decal.panelIndex).toBe(0);
    expect(o.decal.imageDataUrl).toBe("data:image/png;base64,AAAA");
  });

  it("does not include a decal key when no decal is set", () => {
    const doc = createDefaultHatDocument();
    const json = serializeHatDocument(doc);
    expect(Object.prototype.hasOwnProperty.call(JSON.parse(json), "decal")).toBe(
      false,
    );
  });
});

describe("buildAllHatsJsonZipBlob", () => {
  it("writes one JSON per hat under slug/slug.json and preserves hat ids in file contents", async () => {
    const a = createDefaultHatDocument();
    a.name = "Alpha Hat";
    a.id = "export-test-alpha";
    const b = createDefaultHatDocument();
    b.name = "Beta Hat";
    b.id = "export-test-beta";

    const { blob, exportedCount, errors } = await buildAllHatsJsonZipBlob([a, b]);
    expect(errors).toEqual([]);
    expect(exportedCount).toBe(2);

    const zip = await JSZip.loadAsync(await blob.arrayBuffer());
    const files = Object.keys(zip.files).filter((k) => !zip.files[k]!.dir);
    expect(files.sort()).toEqual(
      ["Alpha-Hat/Alpha-Hat.json", "Beta-Hat/Beta-Hat.json"].sort(),
    );

    const ja = await zip.file("Alpha-Hat/Alpha-Hat.json")!.async("string");
    const jb = await zip.file("Beta-Hat/Beta-Hat.json")!.async("string");
    assertExportedHatJsonIncludesCoreFields(ja);
    assertExportedHatJsonIncludesCoreFields(jb);
    expect(parseHatDocumentJSON(ja).id).toBe("export-test-alpha");
    expect(parseHatDocumentJSON(jb).id).toBe("export-test-beta");
  });

  it("uses unique folder slugs when hat names collide", async () => {
    const a = createDefaultHatDocument();
    a.name = "Twin";
    a.id = "twin-1";
    const b = createDefaultHatDocument();
    b.name = "Twin";
    b.id = "twin-2";

    const { blob, exportedCount } = await buildAllHatsJsonZipBlob([a, b]);
    expect(exportedCount).toBe(2);
    const zip = await JSZip.loadAsync(await blob.arrayBuffer());
    const files = Object.keys(zip.files).filter((k) => !zip.files[k]!.dir);
    expect(files.sort()).toEqual(["Twin/Twin.json", "Twin-2/Twin-2.json"].sort());
  });

  it("skips hats that fail validateSpec and lists their names in errors", async () => {
    const good = createDefaultHatDocument();
    good.name = "Good";
    const bad = createDefaultHatDocument();
    bad.name = "Bad duplicate closure";
    bad.spec = mergeHatSpecDefaults({
      ...bad.spec,
      closures: [{ type: "snapback" }, { type: "snapback" }],
    });

    const { exportedCount, errors } = await buildAllHatsJsonZipBlob([good, bad]);
    expect(exportedCount).toBe(1);
    expect(errors).toEqual(["Bad duplicate closure"]);
  });
});
