#!/usr/bin/env node
/**
 * Writes a tiling PNG: white strands, transparent holes (alpha = 0).
 * Use in Three.js as alphaMap + alphaTest, or as opacity/mask in DCC tools.
 *
 * Usage:
 *   node scripts/generate-net-alpha-texture.mjs
 *   node scripts/generate-net-alpha-texture.mjs --size 2048 --cell 24 --strand 4 --pattern hex --out public/textures/hat/net-alpha.png
 */
import { PNG } from "pngjs";
import fs from "node:fs";
import path from "node:path";

function parseArgs(argv) {
  const out = {
    size: 2048,
    cell: 24,
    strand: 4,
    pattern: "square",
    out: path.join(process.cwd(), "public", "textures", "hat", "net-alpha.png"),
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--size" && argv[i + 1]) {
      out.size = Math.max(8, parseInt(argv[++i], 10) || out.size);
    } else if (a === "--cell" && argv[i + 1]) {
      out.cell = Math.max(4, parseInt(argv[++i], 10) || out.cell);
    } else if (a === "--strand" && argv[i + 1]) {
      out.strand = Math.max(1, parseInt(argv[++i], 10) || out.strand);
    } else if (a === "--pattern" && argv[i + 1]) {
      const p = argv[++i].toLowerCase();
      if (p === "square" || p === "hex") out.pattern = p;
    } else if (a === "--out" && argv[i + 1]) {
      out.out = path.resolve(process.cwd(), argv[++i]);
    } else if (a === "--help" || a === "-h") {
      console.log(`Usage: node scripts/generate-net-alpha-texture.mjs [options]
  --size N      Square texture size in pixels (default 2048)
  --cell N      Distance between parallel strand centers (default 24)
  --strand N    Strand thickness in pixels (default 4)
  --pattern square|hex   Grid family (default square)
  --out PATH    Output PNG path (default web/public/textures/hat/net-alpha.png)`);
      process.exit(0);
    }
  }
  return out;
}

/** Unit normals for strand families (lines perpendicular to these normals). */
function normalsForPattern(pattern) {
  const s3 = Math.sqrt(3) / 2;
  if (pattern === "hex") {
    return [
      [0, 1],
      [s3, 0.5],
      [-s3, 0.5],
    ];
  }
  return [
    [0, 1],
    [1, 0],
  ];
}

/**
 * True if (x,y) lies on a strand: thin band around lines dot(p,n)=k*cell.
 */
function isStrand(x, y, cell, strandPx, normals) {
  const w = Math.min(strandPx, cell - 2);
  if (w <= 0) return false;
  for (const [nx, ny] of normals) {
    let p = x * nx + y * ny;
    p -= Math.floor(p / cell) * cell;
    if (p < 0) p += cell;
    if (p < w || p > cell - w) return true;
  }
  return false;
}

function main() {
  const opts = parseArgs(process.argv);
  const { size, cell, strand, pattern, out } = opts;
  const normals = normalsForPattern(pattern);

  const png = new PNG({ width: size, height: size, colorType: 6, inputColorType: 6 });
  const data = png.data;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (size * y + x) * 4;
      const solid = isStrand(x, y, cell, strand, normals);
      data[i] = 255;
      data[i + 1] = 255;
      data[i + 2] = 255;
      data[i + 3] = solid ? 255 : 0;
    }
  }

  fs.mkdirSync(path.dirname(out), { recursive: true });
  const buf = PNG.sync.write(png);
  fs.writeFileSync(out, buf);
  console.log(`Wrote ${out} (${size}×${size}, ${pattern} net, cell=${cell}, strand=${strand})`);
}

main();
