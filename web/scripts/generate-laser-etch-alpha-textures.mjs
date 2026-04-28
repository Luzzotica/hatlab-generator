#!/usr/bin/env node
/**
 * Tiling laser-etch alpha PNGs: white motif, transparent background (alpha 0).
 * Measurements (mm at `--pixelsPerMm`):
 * - 1mm circles: pitch = CIRCLE_1MM_PITCH_MULT × pitchMatchMm (pitchMatchMm = net cell 12px).
 * - 2mm circles: pitch = 6 × pitchMatchMm.
 * - Teardrop: 4mm square cell (physical motif period; 2× former 2mm spacing).
 * - Diamond: one net cell per repeat (same pitchMatchMm as mesh reference).
 *
 * Outputs four files into --out-dir:
 *   laser_etch_1mm_circle_alpha.png
 *   laser_etch_2mm_circle_alpha.png
 *   laser_etch_teardrop_alpha.png
 *   laser_etch_diamond_alpha.png
 *
 * Usage:
 *   node scripts/generate-laser-etch-alpha-textures.mjs
 *   node scripts/generate-laser-etch-alpha-textures.mjs --pixelsPerMm 64 --size 2048
 */
import { PNG } from "pngjs";
import fs from "node:fs";
import path from "node:path";

function parseArgs(argv) {
  const out = {
    pixelsPerMm: 128,
    size: 2048,
    outDir: path.join(process.cwd(), "public", "textures", "hat", "laser-etch"),
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--pixelsPerMm" && argv[i + 1]) {
      out.pixelsPerMm = Math.max(8, parseInt(argv[++i], 10) || out.pixelsPerMm);
    } else if (a === "--size" && argv[i + 1]) {
      out.size = Math.max(64, parseInt(argv[++i], 10) || out.size);
    } else if (a === "--out-dir" && argv[i + 1]) {
      out.outDir = path.resolve(process.cwd(), argv[++i]);
    } else if (a === "--help" || a === "-h") {
      console.log(`Usage: node scripts/generate-laser-etch-alpha-textures.mjs [options]
  --pixelsPerMm N   Pixels per millimetre (default 128)
  --size N          Square texture size; snapped to tile cleanly (default 2048)
  --out-dir PATH    Output directory (default web/public/textures/hat/laser-etch)`);
      process.exit(0);
    }
  }
  return out;
}

/** Snap size down so size % period === 0 for seamless tiling. */
function snapSizeToPeriod(size, periodPx) {
  const p = Math.max(1, Math.round(periodPx));
  const n = Math.floor(size / p);
  return Math.max(p, n * p);
}

function writePng(outPath, width, height, sample) {
  const png = new PNG({ width, height, colorType: 6, inputColorType: 6 });
  const data = png.data;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (width * y + x) * 4;
      const { r, g, b, a } = sample(x, y);
      data[i] = r;
      data[i + 1] = g;
      data[i + 2] = b;
      data[i + 3] = a;
    }
  }
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, PNG.sync.write(png));
}

function pointInTriangle(px, py, ax, ay, bx, by, cx, cy) {
  const sign = (x1, y1, x2, y2, x3, y3) =>
    (x1 - x3) * (y2 - y3) - (x2 - x3) * (y1 - y3);
  const d1 = sign(px, py, ax, ay, bx, by);
  const d2 = sign(px, py, bx, by, cx, cy);
  const d3 = sign(px, py, cx, cy, ax, ay);
  const neg = d1 < 0 || d2 < 0 || d3 < 0;
  const pos = d1 > 0 || d2 > 0 || d3 > 0;
  return !(neg && pos);
}

/** Teardrop: union of circle (bulb) + top triangle (point). */
function insideTeardrop(ux, uy, cellW, cellH) {
  const cx = cellW * 0.5;
  const cy = cellH * 0.58;
  const R = Math.min(cellW, cellH) * 0.36;
  const inCircle = (ux - cx) ** 2 + (uy - cy) ** 2 <= R * R;
  const tipX = cx;
  const tipY = cellH * 0.06;
  const baseY = cy - R * 0.35;
  const hw = R * 1.15;
  const inTri = pointInTriangle(
    ux,
    uy,
    tipX,
    tipY,
    cx - hw,
    baseY,
    cx + hw,
    baseY,
  );
  return inCircle || inTri;
}

/** Axis-aligned diamond (rhombus): L1 metric. */
function insideDiamond(ux, uy, cx, cy, halfW, halfH) {
  return Math.abs(ux - cx) / halfW + Math.abs(uy - cy) / halfH <= 1;
}

function makeCirclePattern(diameterMm, pitchMm, ppm) {
  const dPx = diameterMm * ppm;
  const cellPx = pitchMm * ppm;
  const period = cellPx;
  const r = dPx / 2;
  const cx0 = period / 2;
  const cy0 = period / 2;

  return (x, y) => {
    const ux = ((x % period) + period) % period;
    const uy = ((y % period) + period) % period;
    const dx = ux - cx0;
    const dy = uy - cy0;
    const inside = dx * dx + dy * dy <= r * r;
    return inside
      ? { r: 255, g: 255, b: 255, a: 255 }
      : { r: 255, g: 255, b: 255, a: 0 };
  };
}

function makeTeardropPattern(pitchMm, ppm) {
  const cellPx = pitchMm * ppm;
  const period = cellPx;

  return (x, y) => {
    const ux = ((x % period) + period) % period;
    const uy = ((y % period) + period) % period;
    const inside = insideTeardrop(ux, uy, period, period);
    return inside
      ? { r: 255, g: 255, b: 255, a: 255 }
      : { r: 255, g: 255, b: 255, a: 0 };
  };
}

function makeDiamondPattern(pitchMm, ppm) {
  const cellPx = pitchMm * ppm;
  const period = cellPx;
  const cx = period / 2;
  const cy = period / 2;
  const halfW = period * 0.42;
  const halfH = period * 0.42;

  return (x, y) => {
    const ux = ((x % period) + period) % period;
    const uy = ((y % period) + period) % period;
    const inside = insideDiamond(ux, uy, cx, cy, halfW, halfH);
    return inside
      ? { r: 255, g: 255, b: 255, a: 255 }
      : { r: 255, g: 255, b: 255, a: 0 };
  };
}

function main() {
  const opts = parseArgs(process.argv);
  const { pixelsPerMm: ppm, size: sizeIn, outDir } = opts;

  // Match `generate-net-alpha-texture.mjs` default cell (px period for net pitch reference).
  const NET_CELL_PX = 24;
  const pitchMatchMm = NET_CELL_PX / ppm;

  /** Slightly above 2× net baseline so 1mm circles read a bit larger on the hat. */
  const CIRCLE_1MM_PITCH_MULT = 2.25;
  const pitch1 = pitchMatchMm * CIRCLE_1MM_PITCH_MULT;
  const diameter1Mm = pitch1 * 0.5;
  const cell1 = pitch1 * ppm;
  const size1 = snapSizeToPeriod(sizeIn, cell1);

  const CIRCLE_2MM_PITCH_MULT = 6;
  const pitch2 = pitchMatchMm * CIRCLE_2MM_PITCH_MULT;
  const diameter2Mm = pitch2 * 0.5;
  const cell2 = pitch2 * ppm;
  const size2 = snapSizeToPeriod(sizeIn, cell2);

  const TEARDROP_CELL_MM = 4;
  const pitchTd = TEARDROP_CELL_MM;
  const cellTd = pitchTd * ppm;
  const sizeTd = snapSizeToPeriod(sizeIn, cellTd);

  const pitchDm = pitchMatchMm;
  const cellDm = pitchDm * ppm;
  const sizeDm = snapSizeToPeriod(sizeIn, cellDm);

  const files = [
    {
      name: "laser_etch_1mm_circle_alpha.png",
      w: size1,
      h: size1,
      sample: makeCirclePattern(diameter1Mm, pitch1, ppm),
    },
    {
      name: "laser_etch_2mm_circle_alpha.png",
      w: size2,
      h: size2,
      sample: makeCirclePattern(diameter2Mm, pitch2, ppm),
    },
    {
      name: "laser_etch_teardrop_alpha.png",
      w: sizeTd,
      h: sizeTd,
      sample: makeTeardropPattern(pitchTd, ppm),
    },
    {
      name: "laser_etch_diamond_alpha.png",
      w: sizeDm,
      h: sizeDm,
      sample: makeDiamondPattern(pitchDm, ppm),
    },
  ];

  for (const f of files) {
    const outPath = path.join(outDir, f.name);
    writePng(outPath, f.w, f.h, f.sample);
    console.log(`Wrote ${outPath} (${f.w}×${f.h})`);
  }

  console.log(
    `\n${ppm} px/mm; pitchMatchMm=${pitchMatchMm.toFixed(4)} (net ${NET_CELL_PX}px). ` +
      `1mm: pitch ${pitch1.toFixed(4)}mm (${CIRCLE_1MM_PITCH_MULT}× pitchMatch), dia ${diameter1Mm.toFixed(4)}mm. ` +
      `2mm: pitch ${pitch2.toFixed(4)}mm (${CIRCLE_2MM_PITCH_MULT}× pitchMatch), dia ${diameter2Mm.toFixed(4)}mm. ` +
      `Teardrop: ${TEARDROP_CELL_MM}mm cell; diamond: ${pitchDm.toFixed(4)}mm cell (net pitch).`,
  );
}

main();
