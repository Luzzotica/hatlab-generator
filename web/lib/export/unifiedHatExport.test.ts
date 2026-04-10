import { describe, expect, it } from "vitest";
import { createDefaultHatDocument } from "@/lib/hat/hatDocument";
import { mergeHatSpecDefaults } from "@/lib/skeleton/types";
import { buildFullHatExportRoot } from "./unifiedHatExport";
import type { VisorShapeIndex } from "@/lib/hat/hatDocument";
import { visorGroupKey, visorRootGroupName } from "./hatExportNaming";
import {
  HAT_EXPORT_GROUP_ROOT_ROTATION_X,
  HAT_EXPORT_GROUP_ROOT_ROTATION_Y,
} from "@/lib/hat/buildHatGroup";

describe("buildFullHatExportRoot", () => {
  it(
    "creates four top-level visor groups",
    () => {
      const doc = createDefaultHatDocument();
      const root = buildFullHatExportRoot(doc, { modelPrefix: "m1" });
      expect(root.children.length).toBe(4);
      for (let i = 0; i < 4; i++) {
        expect(root.children[i]!.name).toBe(
          visorRootGroupName("m1", visorGroupKey(i as VisorShapeIndex)),
        );
      }
    },
    60_000,
  );

  it(
    "modular root has export frame rotation; eyelets and closure are nested under it",
    () => {
      const doc = createDefaultHatDocument();
      doc.spec = mergeHatSpecDefaults({ ...doc.spec, eyeletStyle: "cloth" });
      const root = buildFullHatExportRoot(doc, { modelPrefix: "m1" });
      const visor0 = root.children[0]!;
      const modular = visor0.children[0]!;
      expect(modular.name).toBe("m1_flatcurve_root");
      expect(modular.rotation.x).toBe(0);
      expect(modular.rotation.y).toBe(HAT_EXPORT_GROUP_ROOT_ROTATION_Y);
      const exportFrame = modular.children[0]!;
      expect(exportFrame.name).toBe("m1_flatcurve_hat_export_frame");
      expect(exportFrame.rotation.x).toBe(HAT_EXPORT_GROUP_ROOT_ROTATION_X);
      expect(exportFrame.rotation.y).toBe(0);
      const px = "m1_flatcurve_hat_export_frame";
      const cloth = modular.getObjectByName(`${px}_eyelets_cloth`);
      const closureSlot = modular.getObjectByName(`${px}_closure`);
      const hardware = modular.getObjectByName(`${px}_closure_hardware`);
      expect(cloth).toBeDefined();
      expect(closureSlot).toBeDefined();
      expect(hardware).toBeDefined();
      expect(cloth!.rotation.x).toBe(0);
    },
    60_000,
  );

  it(
    "exports shared crown slots and dual rear / sweatband / closure variants regardless of document rear opening",
    () => {
      const doc = createDefaultHatDocument();
      doc.spec = mergeHatSpecDefaults({
        ...doc.spec,
        backClosureOpening: false,
      });
      const root = buildFullHatExportRoot(doc, { modelPrefix: "m1" });
      const visor0 = root.children[0]!;
      const modular = visor0.children[0]!;
      const px = "m1_flatcurve_hat_export_frame";
      expect(modular.getObjectByName(`${px}_crown_front`)).toBeDefined();
      expect(modular.getObjectByName(`${px}_crown_side`)).toBeDefined();
      expect(modular.getObjectByName(`${px}_fitted`)).toBeDefined();
      expect(modular.getObjectByName(`${px}_closure`)).toBeDefined();
      expect(
        modular.getObjectByName(`${px}_fitted_crown_rear`),
      ).toBeDefined();
      expect(
        modular.getObjectByName(`${px}_closure_crown_rear`),
      ).toBeDefined();
      expect(
        modular.getObjectByName(`${px}_fitted_sweatband`),
      ).toBeDefined();
      expect(
        modular.getObjectByName(`${px}_closure_sweatband`),
      ).toBeDefined();
      expect(
        modular.getObjectByName(`${px}_closure_hardware`),
      ).toBeDefined();
    },
    60_000,
  );
});
