#!/usr/bin/env node
// Generates the PWA/home-screen icons from an inline SVG, rendered to PNG with
// the preinstalled Chromium (same browser tools/verify.mjs uses). Run:
//   node tools/make_icons.mjs
// Outputs icons/icon-192.png, icons/icon-512.png, icons/apple-touch-icon.png.

import { execSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..");
const iconsDir = join(repoRoot, "icons");
mkdirSync(iconsDir, { recursive: true });

const globalRoot = execSync("npm root -g").toString().trim();
const chromeBin = "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";

// Full-bleed accent background (so iOS/Android masks look clean) with a white
// "label" card + a few text bars + OCR wordmark. viewBox 512, scaled per size.
const svg = (size) => `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 512 512">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#4c8dff"/>
      <stop offset="1" stop-color="#2f6fe0"/>
    </linearGradient>
  </defs>
  <rect width="512" height="512" fill="url(#g)"/>
  <rect x="112" y="150" width="288" height="212" rx="26" fill="#ffffff"/>
  <rect x="148" y="196" width="150" height="22" rx="11" fill="#2f6fe0"/>
  <rect x="148" y="240" width="216" height="16" rx="8" fill="#c3ccdb"/>
  <rect x="148" y="276" width="176" height="16" rx="8" fill="#c3ccdb"/>
  <text x="256" y="340" font-family="Helvetica,Arial,DejaVu Sans,sans-serif" font-size="46" font-weight="800" fill="#2f6fe0" text-anchor="middle">OCR</text>
</svg>`;

async function main() {
  const pw = await import(join(globalRoot, "playwright", "index.js"));
  const chromium = pw.chromium || (pw.default && pw.default.chromium);
  const browser = await chromium.launch({ executablePath: chromeBin, headless: true, args: ["--no-sandbox"] });
  const targets = [
    { size: 192, file: "icon-192.png" },
    { size: 512, file: "icon-512.png" },
    { size: 180, file: "apple-touch-icon.png" }
  ];
  for (const t of targets) {
    const page = await browser.newPage({ viewport: { width: t.size, height: t.size }, deviceScaleFactor: 1 });
    await page.setContent(`<!doctype html><style>*{margin:0;padding:0}</style>${svg(t.size)}`, { waitUntil: "load" });
    await page.screenshot({ path: join(iconsDir, t.file), clip: { x: 0, y: 0, width: t.size, height: t.size }, omitBackground: false });
    await page.close();
    console.log("wrote icons/" + t.file + " (" + t.size + "x" + t.size + ")");
  }
  await browser.close();
}
main().catch((e) => { console.error("make_icons failed:", e); process.exit(1); });
