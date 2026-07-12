#!/usr/bin/env node
// End-to-end verification for index.html.
//
// 1. Serves the repo over local HTTP.
// 2. Opens index.html in Chromium (Playwright), failing on any CSP violation or JS error.
// 3. Generates a label image in-page, feeds it to the file input, runs OCR,
//    asserts the recognized text.
// 4. Saves the record, switches to the list view, checks it shows under today
//    with a calendar badge.
// 5. Reloads and confirms the record persisted in IndexedDB.
//
// The app references pinned cdn.jsdelivr.net URLs. That host is blocked by this
// sandbox's egress policy, so for the test we intercept every cdn.jsdelivr.net
// request and fulfill it from a local cache of the exact npm package files
// (auto-populated from registry.npmjs.org on first run). Real browsers load the
// assets from jsdelivr directly; this only swaps the transport during the test.

import http from "node:http";
import { createRequire } from "node:module";
import { readFileSync, existsSync, mkdirSync, copyFileSync, readdirSync, mkdtempSync } from "node:fs";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join, basename, extname } from "node:path";
import { tmpdir } from "node:os";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");
const cacheDir = join(here, ".cdncache");

const require = createRequire(import.meta.url);
const globalRoot = execSync("npm root -g").toString().trim();
const chromeBin = "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";

// ---- pinned assets (must match index.html) ----
// Tesseract has been retired; the only OCR engine is onnxruntime-web + PaddleOCR
// (shared DBNet detector + PP-OCRv4 ch rec on jsdelivr, plus a self-hosted japan
// PP-OCRv3 rec model served same-origin from models/).
const VER = { vue: "3.4.38", ort: "1.19.2", models: "1.4.2", wordlist: "4.1.0" };
const CACHE_FILES = {
  "vue.runtime.global.prod.js": join(cacheDir, "vue", "vue.runtime.global.prod.js"),
  // onnxruntime-web (wasm-only build + its wasm/glue)
  "ort.wasm.min.js": join(cacheDir, "onnxruntime-web", "ort.wasm.min.js"),
  "ort-wasm-simd-threaded.mjs": join(cacheDir, "onnxruntime-web", "ort-wasm-simd-threaded.mjs"),
  "ort-wasm-simd-threaded.wasm": join(cacheDir, "onnxruntime-web", "ort-wasm-simd-threaded.wasm"),
  "ort-wasm-simd-threaded.jsep.mjs": join(cacheDir, "onnxruntime-web", "ort-wasm-simd-threaded.jsep.mjs"),
  "ort-wasm-simd-threaded.jsep.wasm": join(cacheDir, "onnxruntime-web", "ort-wasm-simd-threaded.jsep.wasm"),
  // PP-OCRv4 detection + recognition model + dictionary (@gutenye/ocr-models)
  "ch_PP-OCRv4_det_infer.onnx": join(cacheDir, "ocr-models", "ch_PP-OCRv4_det_infer.onnx"),
  "ch_PP-OCRv4_rec_infer.onnx": join(cacheDir, "ocr-models", "ch_PP-OCRv4_rec_infer.onnx"),
  "ppocr_keys_v1.txt": join(cacheDir, "ocr-models", "ppocr_keys_v1.txt"),
  // English wordlist for the 単語フィルタ (word filter) dictionary check
  "words.txt": join(cacheDir, "word-list", "words.txt")
};

function log(...a) { console.log(...a); }

// Noise-robustness test helper: count characters in `recognized` that are
// NOT explained by the expected label strings. Case-insensitive; only
// alphanumeric and CJK characters count as "garbage" (leftover whitespace/
// punctuation after removing expected characters is not a hallucination).
function countGarbage(recognized, expectedStrings) {
  const allowed = new Set();
  for (const s of expectedStrings) for (const ch of s.toUpperCase()) allowed.add(ch);
  let n = 0;
  for (const ch of recognized.toUpperCase()) {
    if (allowed.has(ch)) continue;
    if (/[A-Z0-9぀-ヿ一-鿿]/.test(ch)) n++;
  }
  return n;
}
const NOISE_LABEL_STRINGS = ["MODEL: KX-1234AB", "S/N 5X-98765"];

// Does this container have a CJK-capable font installed? If not, canvas-rendered
// Japanese glyphs would come out as tofu boxes and OCR-ing them proves nothing.
// In that case we fall back to an ASCII-only image in jpn mode, which still
// proves the jpn PaddleOCR rec pipeline works end-to-end.
function detectCjkFont() {
  try {
    const out = execSync("fc-list", { encoding: "utf8" });
    const lines = out.split("\n").filter((l) => /cjk|noto sans jp|noto serif jp|ipagothic|ipa gothic|migu|takao|vlgothic/i.test(l));
    if (lines.length === 0) return null;
    const line = lines.find((l) => /cjk/i.test(l)) || lines[0];
    const family = (line.split(":")[1] || "").split(",")[0].trim();
    return family || null;
  } catch (e) { return null; }
}

// Populate the local CDN cache from npm tarballs if any file is missing.
function ensureCache() {
  const missing = Object.values(CACHE_FILES).some((p) => !existsSync(p));
  if (!missing) { log("CDN cache present."); return; }
  log("CDN cache incomplete — downloading npm tarballs (registry.npmjs.org)...");
  const tmp = mkdtempSync(join(tmpdir(), "cdncache-"));
  const grab = (name, url) => {
    execSync(`curl -fsS -o "${join(tmp, name)}.tgz" "${url}"`, { stdio: "inherit" });
    mkdirSync(join(tmp, name), { recursive: true });
    execSync(`tar xzf "${join(tmp, name)}.tgz" -C "${join(tmp, name)}"`);
  };
  grab("vue", `https://registry.npmjs.org/vue/-/vue-${VER.vue}.tgz`);
  grab("ort", `https://registry.npmjs.org/onnxruntime-web/-/onnxruntime-web-${VER.ort}.tgz`);
  grab("models", `https://registry.npmjs.org/@gutenye/ocr-models/-/ocr-models-${VER.models}.tgz`);
  grab("wordlist", `https://registry.npmjs.org/word-list/-/word-list-${VER.wordlist}.tgz`);

  mkdirSync(join(cacheDir, "vue"), { recursive: true });
  mkdirSync(join(cacheDir, "onnxruntime-web"), { recursive: true });
  mkdirSync(join(cacheDir, "ocr-models"), { recursive: true });
  mkdirSync(join(cacheDir, "word-list"), { recursive: true });
  copyFileSync(join(tmp, "vue", "package", "dist", "vue.runtime.global.prod.js"), CACHE_FILES["vue.runtime.global.prod.js"]);
  for (const f of ["ort.wasm.min.js", "ort-wasm-simd-threaded.mjs", "ort-wasm-simd-threaded.wasm", "ort-wasm-simd-threaded.jsep.mjs", "ort-wasm-simd-threaded.jsep.wasm"]) {
    copyFileSync(join(tmp, "ort", "package", "dist", f), CACHE_FILES[f]);
  }
  copyFileSync(join(tmp, "models", "package", "assets", "ch_PP-OCRv4_det_infer.onnx"), CACHE_FILES["ch_PP-OCRv4_det_infer.onnx"]);
  copyFileSync(join(tmp, "models", "package", "assets", "ch_PP-OCRv4_rec_infer.onnx"), CACHE_FILES["ch_PP-OCRv4_rec_infer.onnx"]);
  copyFileSync(join(tmp, "models", "package", "assets", "ppocr_keys_v1.txt"), CACHE_FILES["ppocr_keys_v1.txt"]);
  copyFileSync(join(tmp, "wordlist", "package", "words.txt"), CACHE_FILES["words.txt"]);
  log("CDN cache built.");
}

// ---- tiny static server for the repo ----
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8"
};
function startServer() {
  const server = http.createServer((req, res) => {
    let p = decodeURIComponent(req.url.split("?")[0]);
    if (p === "/") p = "/index.html";
    const file = join(repoRoot, p);
    if (!file.startsWith(repoRoot) || !existsSync(file)) { res.writeHead(404); res.end("nf"); return; }
    res.writeHead(200, { "Content-Type": MIME[extname(file)] || "application/octet-stream" });
    res.end(readFileSync(file));
  });
  return new Promise((r) => server.listen(0, "127.0.0.1", () => r(server)));
}

async function main() {
  ensureCache();
  const pw = await import(join(globalRoot, "playwright", "index.js"));
  const chromium = (pw.chromium || (pw.default && pw.default.chromium));
  if (!chromium) throw new Error("Could not load playwright chromium export");

  const server = await startServer();
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;

  const browser = await chromium.launch({ executablePath: chromeBin, headless: true, args: ["--no-sandbox"] });
  const context = await browser.newContext({ ignoreHTTPSErrors: true });

  const errors = [];
  const cspViolations = [];
  const unmappedCdn = [];
  // Every jsdelivr basename fulfilled from cache, in request order — lets a test
  // assert e.g. that the classic 「全体読取」 path fetched the DBNet det
  // model (a cropped read never does).
  const cdnHits = [];
  const countDet = () => cdnHits.filter((nm) => nm === "ch_PP-OCRv4_det_infer.onnx").length;

  // Intercept jsdelivr; fulfill from the local cache. The japan rec model and
  // its dict are SELF-HOSTED (served same-origin from models/ by the static
  // server below), so they never hit this route.
  await context.route("https://cdn.jsdelivr.net/**", async (route) => {
    const url = new URL(route.request().url());
    const name = basename(url.pathname);
    const local = CACHE_FILES[name];
    if (local && existsSync(local)) cdnHits.push(name);
    if (local && existsSync(local)) {
      // Correct MIME matters: dynamic import() of .mjs requires a JS type and
      // WebAssembly.instantiateStreaming requires application/wasm.
      const mime = name.endsWith(".wasm") ? "application/wasm"
        : (name.endsWith(".mjs") || name.endsWith(".js")) ? "text/javascript; charset=utf-8"
        : name.endsWith(".txt") ? "text/plain; charset=utf-8"
        : "application/octet-stream";
      await route.fulfill({ status: 200, contentType: mime, body: readFileSync(local) });
    } else {
      unmappedCdn.push(url.pathname);
      await route.abort();
    }
  });

  const deskewMsgs = [];
  const page = await context.newPage();
  page.on("console", (m) => {
    const t = m.text();
    if (/content security policy|refused to (load|execute|connect|apply)/i.test(t)) cspViolations.push(t);
    if (/deskew: chosen correction angle/i.test(t)) deskewMsgs.push(t);
    if (m.type() === "error") errors.push("console.error: " + t);
  });
  page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
  await page.addInitScript(() => {
    window.__csp = [];
    document.addEventListener("securitypolicyviolation", (e) => {
      window.__csp.push(e.violatedDirective + " -> " + (e.blockedURI || e.sourceFile || ""));
    });
  });

  const fail = async (msg) => {
    console.error("\nFAIL:", msg);
    if (errors.length) console.error("JS errors:\n  " + errors.join("\n  "));
    if (cspViolations.length) console.error("CSP violations:\n  " + cspViolations.join("\n  "));
    if (unmappedCdn.length) console.error("Unmapped CDN requests:\n  " + unmappedCdn.join("\n  "));
    await browser.close(); server.close();
    process.exit(1);
  };

  // Drag a crop handle (real pointer events) to a target page coordinate.
  async function dragHandle(sel, tx, ty) {
    const el = await page.$(sel);
    if (!el) throw new Error("handle not found: " + sel);
    const bb = await el.boundingBox();
    await page.mouse.move(bb.x + bb.width / 2, bb.y + bb.height / 2);
    await page.mouse.down();
    await page.mouse.move(tx, ty, { steps: 6 });
    await page.mouse.up();
  }
  // Expand the crop rect to (almost) the whole photo via the corner handles.
  async function expandCropToFull() {
    await page.waitForSelector(".crop-stage", { timeout: 15000 });
    const stage = await (await page.$(".crop-stage")).boundingBox();
    await dragHandle(".crop-handle.nw", stage.x + 3, stage.y + 3);
    await dragHandle(".crop-handle.se", stage.x + stage.width - 3, stage.y + stage.height - 3);
    const r = await page.evaluate(() => {
      const o = document.querySelector(".crop-overlay");
      const s = document.querySelector(".crop-stage");
      const ob = o.getBoundingClientRect(), sb = s.getBoundingClientRect();
      return { x: (ob.x - sb.x) / sb.width, w: ob.width / sb.width };
    });
    if (r.x > 0.1 || r.w < 0.8) throw new Error("crop drag did not expand the rect (x=" + r.x.toFixed(2) + " w=" + r.w.toFixed(2) + ")");
  }

  // ---- iPhone SE2/SE3 no-scroll layout gates ----
  // The capture and recognition (crop/result) screens must fit an SE2 Safari
  // viewport without vertical scroll; the calendar must be fully visible with
  // the day's record list allowed to scroll below it.
  const SE2 = { width: 375, height: 553 };   // SE2/SE3 Safari usable area
  const BIG = { width: 1280, height: 900 };
  // The app is a fixed-height shell: <main> (records) is the only scroll region,
  // and the recognition modal's .modalbody is its own. So the "no vertical
  // scroll" gate measures the given container's own scrollHeight vs clientHeight
  // (the document itself never scrolls). `sel` is that container. For the
  // calendar we additionally require the calendar card to fit inside <main>.
  async function checkSE2(name, sel, mode) {
    await page.setViewportSize(SE2);
    await page.waitForTimeout(150);           // let the resize listener re-render
    const m = await page.evaluate((sel) => {
      const el = document.querySelector(sel);
      const de = document.documentElement;
      const cal = document.querySelector(".cal");
      return {
        found: !!el,
        sh: el ? el.scrollHeight : 0, ch: el ? el.clientHeight : 0,
        dsw: de.scrollWidth, iw: window.innerWidth, ih: window.innerHeight,
        calBottom: cal ? Math.round(cal.getBoundingClientRect().bottom) : null
      };
    }, sel);
    if (!m.found) { await page.setViewportSize(BIG); return fail("SE2 gate '" + name + "': container '" + sel + "' not found."); }
    const horiz = m.dsw - m.iw;
    const vert = mode === "cal" ? (m.calBottom == null ? 0 : m.calBottom - m.ih) : (m.sh - m.ch);
    log("SE2[" + name + "] " + sel + ": scrollH=" + m.sh + " clientH=" + m.ch +
      (mode === "cal" ? " calBottom=" + m.calBottom + "/" + m.ih : "") + " -> vOverflow=" + vert + "px hOverflow=" + horiz + "px");
    if (horiz > 2) { await page.setViewportSize(BIG); return fail("SE2 gate '" + name + "': horizontal overflow " + horiz + "px."); }
    if (vert > 2) { await page.setViewportSize(BIG); return fail("SE2 gate '" + name + "': vertical overflow " + vert + "px (must fit without scroll)."); }
    await page.setViewportSize(BIG);
  }

  // From the 一覧 calendar screen, open the first day that has records so the
  // record list (.rec) is visible (records are hidden in calendar-only mode).
  async function openDayWithRecords() {
    await page.waitForSelector(".calcell.has", { timeout: 8000 });
    await page.click(".calcell.has");
    await page.waitForSelector(".rec .txt", { timeout: 8000 });
  }

  // Recognition mode is chosen on the crop screen now (英数字/日本語 segctl),
  // not before capture; requires the crop stage to be visible.
  async function selectMode(kind) {
    const label = kind === "jpn" ? "日本語" : "英数字";
    await page.waitForSelector(".crop-stage", { timeout: 10000 });
    await page.getByText(label, { exact: true }).click();
    await page.waitForFunction((lab) => {
      const b = [...document.querySelectorAll(".segctl button")].find((el) => el.textContent === lab);
      return !!b && b.classList.contains("on");
    }, label, { timeout: 5000 });
  }

  log(`\nServing ${repoRoot} at ${base}`);
  await page.goto(base + "/index.html", { waitUntil: "load" });
  await page.waitForSelector("header h1", { timeout: 10000 });
  log("Step 1: page loaded, Vue mounted (render functions, no template compiler).");

  // Mode/tips info now lives on the capture screen as a single collapsed
  // accordion ("モードと撮影のコツ"); it carries the jpn model download-size hint.
  const capAccClosed = await page.evaluate(() => {
    const d = [...document.querySelectorAll("details.acc")]
      .find((x) => x.querySelector("summary").textContent.includes("モードと撮影のコツ"));
    return d ? !d.open : null;
  });
  if (capAccClosed !== true) return fail("Capture-screen info accordion missing or not collapsed by default.");
  await page.getByText("モードと撮影のコツ", { exact: true }).click();
  const capHintShown = await page.evaluate(() => {
    const d = [...document.querySelectorAll("details.acc")]
      .find((x) => x.querySelector("summary").textContent.includes("モードと撮影のコツ"));
    return !!d && d.open && /日本語/.test(d.textContent) && /MB/i.test(d.textContent);
  });
  if (!capHintShown) return fail("Capture-screen accordion did not reveal the mode/download-size hint.");
  await page.getByText("モードと撮影のコツ", { exact: true }).click(); // collapse again
  log("Step 1b: capture-screen 'モードと撮影のコツ' accordion collapsed by default; reveals mode + jpn download hint.");

  // SE2 no-scroll gate: capture screen.
  await checkSE2("capture", "main");

  // SE2 no-scroll gate: recognition (crop) screen with a TALL portrait image
  // (exercises the height cap that keeps the stage from forcing a scroll).
  await page.evaluate(() => {
    const c = document.createElement("canvas"); c.width = 620; c.height = 880;
    const x = c.getContext("2d");
    x.fillStyle = "#fff"; x.fillRect(0, 0, c.width, c.height);
    x.fillStyle = "#000"; x.font = "30px monospace"; x.textBaseline = "top";
    x.fillText("MODEL: KX-1234AB", 30, 400);
    x.fillText("S/N 5X-98765", 30, 470);
    const input = document.querySelector('input[type=file]:not([capture])');
    return new Promise((r) => c.toBlob((b) => {
      const f = new File([b], "portrait.png", { type: "image/png" });
      const dt = new DataTransfer(); dt.items.add(f);
      input.files = dt.files; input.dispatchEvent(new Event("change", { bubbles: true })); r();
    }, "image/png"));
  });
  await page.waitForSelector(".crop-stage", { timeout: 10000 });
  await checkSE2("crop-portrait", ".modalbody");
  await page.getByText("キャンセル", { exact: true }).click();
  await page.waitForSelector(".card", { timeout: 8000 });
  log("Step 1c: SE2 no-scroll verified on the capture screen and a portrait-image crop screen.");

  // Feed a generated label image into the file picker input.
  await page.evaluate(async () => {
    const c = document.createElement("canvas");
    c.width = 700; c.height = 220;
    const x = c.getContext("2d");
    x.fillStyle = "#fff"; x.fillRect(0, 0, c.width, c.height);
    x.fillStyle = "#000"; x.font = "28px monospace"; x.textBaseline = "top";
    x.fillText("MODEL: KX-1234AB", 30, 50);
    x.fillText("S/N 5X-98765", 30, 120);
    const blob = await new Promise((r) => c.toBlob(r, "image/png"));
    const file = new File([blob], "label.png", { type: "image/png" });
    const input = document.querySelector('input[type=file]:not([capture])');
    const dt = new DataTransfer();
    dt.items.add(file);
    input.files = dt.files;
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
  log("Step 2: label image injected, crop stage should appear...");
  await page.waitForSelector(".crop-stage", { timeout: 10000 });
  await checkSE2("crop-landscape", ".modalbody");

  // ---- cropped 英数字 path -> PaddleOCR (rec-only) ----
  await expandCropToFull();
  log("Step 2b: crop rect expanded to full photo via pointer-event drags.");
  await page.getByText("指定範囲読取", { exact: true }).click();
  const assertResult = async (label, reKx, reOther) => {
    try {
      await page.waitForSelector("textarea", { timeout: 180000 });
      await page.waitForFunction(([a, b]) => {
        const ta = document.querySelector("textarea");
        return ta && new RegExp(a, "i").test(ta.value) && new RegExp(b).test(ta.value);
      }, [reKx, reOther], { timeout: 180000 });
    } catch (e) {
      const ta = await page.evaluate(() => { const t = document.querySelector("textarea"); return t ? t.value : "(no textarea)"; });
      return fail(label + " OCR text assertion failed. textarea value was:\n" + ta);
    }
  };
  // Generate a noisy label image in-page: diagonal gray-gradient background,
  // ~800 random low-contrast speckle dots/short strokes, a slight vignette,
  // then the same dark label text as the clean test above. Used later by the
  // noise-robustness test (both the eng and jpn PaddleOCR paths).
  async function generateNoisyLabelDataUrl() {
    return await page.evaluate(() => {
      // Seeded PRNG (mulberry32) so the noise pattern -- and therefore the
      // test's garbage-character count -- is reproducible across runs
      // instead of flaking on whichever random speckles happen to land.
      function mulberry32(seed) {
        return function () {
          seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
          let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
          t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
          return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
        };
      }
      const rand = mulberry32(0xC0FFEE);
      const c = document.createElement("canvas");
      c.width = 700; c.height = 260;
      const ctx = c.getContext("2d");
      const grad = ctx.createLinearGradient(0, 0, c.width, c.height);
      grad.addColorStop(0, "#d8d8d8");
      grad.addColorStop(1, "#a8a8a8");
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, c.width, c.height);
      for (let i = 0; i < 800; i++) {
        const x = rand() * c.width, y = rand() * c.height;
        const shade = (120 + rand() * 80) | 0;
        ctx.fillStyle = `rgba(${shade},${shade},${shade},${(0.25 + rand() * 0.35).toFixed(2)})`;
        if (rand() < 0.5) {
          ctx.fillRect(x, y, 1 + rand() * 2, 1 + rand() * 2);
        } else {
          const len = 3 + rand() * 6;
          const ang = rand() * Math.PI * 2;
          ctx.lineWidth = 1;
          ctx.strokeStyle = ctx.fillStyle;
          ctx.beginPath();
          ctx.moveTo(x, y);
          ctx.lineTo(x + Math.cos(ang) * len, y + Math.sin(ang) * len);
          ctx.stroke();
        }
      }
      const vg = ctx.createRadialGradient(
        c.width / 2, c.height / 2, Math.min(c.width, c.height) / 3,
        c.width / 2, c.height / 2, Math.max(c.width, c.height) / 1.2
      );
      vg.addColorStop(0, "rgba(0,0,0,0)");
      vg.addColorStop(1, "rgba(0,0,0,0.25)");
      ctx.fillStyle = vg;
      ctx.fillRect(0, 0, c.width, c.height);
      ctx.fillStyle = "#111";
      ctx.font = "28px monospace";
      ctx.textBaseline = "top";
      ctx.fillText("MODEL: KX-1234AB", 30, 70);
      ctx.fillText("S/N 5X-98765", 30, 150);
      return c.toDataURL("image/png");
    });
  }
  // Feed a data: URL (built in-page, no network) into the file input.
  async function injectDataUrlFile(dataUrl, filename) {
    await page.evaluate(({ dataUrl, filename }) => {
      const b64 = dataUrl.split(",")[1];
      const bin = atob(b64);
      const arr = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
      const blob = new Blob([arr], { type: "image/png" });
      const file = new File([blob], filename, { type: "image/png" });
      const input = document.querySelector('input[type=file]:not([capture])');
      const dt = new DataTransfer();
      dt.items.add(file);
      input.files = dt.files;
      input.dispatchEvent(new Event("change", { bubbles: true }));
    }, { dataUrl, filename });
  }

  await assertResult("Paddle-crop", "KX[-—_ ]?1234AB", "98765");
  const engine1 = await page.evaluate(() => { const e = document.querySelector(".engine b"); return e ? e.textContent : ""; });
  if (!/PaddleOCR/.test(engine1)) return fail("Expected PaddleOCR engine for cropped 英数字 path, got: " + engine1);
  const recognized = await page.evaluate(() => document.querySelector("textarea").value);
  log("Step 3: cropped-region OCR via " + engine1 + " matched. Recognized:\n  " + recognized.replace(/\n/g, "\\n"));

  // SE2 no-scroll gate: recognition RESULT screen (flex-fill card).
  await checkSE2("result", ".modalbody");

  if (cspViolations.length) return fail("CSP violation(s) occurred during Paddle OCR.");
  const cspFromPage = await page.evaluate(() => window.__csp || []);
  if (cspFromPage.length) { cspViolations.push(...cspFromPage); return fail("securitypolicyviolation events fired."); }

  // ---- full-image 全体読取 — DBNet detection + rec ----
  // Helper: inject an in-page multi-line label (3 lines). Used by the full-image
  // read below and by the cold-start guard after a reload.
  async function injectMultiLineLabel(filename) {
    await page.evaluate((filename) => {
      const c = document.createElement("canvas");
      c.width = 760; c.height = 260;
      const x = c.getContext("2d");
      x.fillStyle = "#fff"; x.fillRect(0, 0, c.width, c.height);
      x.fillStyle = "#000"; x.font = "30px monospace"; x.textBaseline = "top";
      x.fillText("MODEL: KX-1234AB", 30, 30);
      x.fillText("S/N 5X-98765", 30, 110);
      x.fillText("MADE IN JAPAN", 30, 190);
      const input = document.querySelector('input[type=file]:not([capture])');
      return new Promise((resolve) => {
        c.toBlob((blob) => {
          const file = new File([blob], filename, { type: "image/png" });
          const dt = new DataTransfer();
          dt.items.add(file);
          input.files = dt.files;
          input.dispatchEvent(new Event("change", { bubbles: true }));
          resolve();
        }, "image/png");
      });
    }, filename);
  }
  await page.getByText("キャンセル", { exact: true }).click();       // result -> input
  await page.waitForSelector(".card", { timeout: 8000 });
  await injectMultiLineLabel("multiline-label.png");
  await page.waitForSelector(".crop-stage", { timeout: 10000 });

  // 「全体読取」 runs DBNet detection to find every text line, crops each,
  // and recognizes it. ORT is already warm (the cropped read above loaded the
  // rec model); this read additionally loads the DBNet det model.
  const detBeforeClassic = countDet();
  await page.getByText("全体読取", { exact: true }).click();
  await assertResult("Paddle-det-full", "KX[-—_ ]?1234AB", "98765");
  const engine2 = await page.evaluate(() => { const e = document.querySelector(".engine b"); return e ? e.textContent : ""; });
  if (!/PaddleOCR/.test(engine2)) return fail("Expected PaddleOCR engine for full-image (det+rec) path, got: " + engine2);
  if (countDet() <= detBeforeClassic) {
    return fail("Full-image 全体読取 should have loaded the DBNet det model, but det request count did not increase (" +
      detBeforeClassic + " -> " + countDet() + ").");
  }
  log("Step 3a: full-image 全体読取 OCR via DBNet detection + " + engine2 + " matched (det count " + detBeforeClassic + " -> " + countDet() + ").");

  if (cspViolations.length) return fail("CSP violation(s) occurred during full-image OCR.");
  const cspFull = await page.evaluate(() => window.__csp || []);
  if (cspFull.length) { cspViolations.push(...cspFull); return fail("securitypolicyviolation during full-image OCR."); }

  // ---- cold-start guard: 全体読取 as the FIRST OCR after a reload ----
  // Regression guard for c8863b5: after a cold reload (window.ort not yet
  // warmed), paddleRecognizeFull must load ORT via getDet BEFORE reading
  // window.ort; otherwise this crashes with "Cannot read properties of
  // undefined (reading 'Tensor')". A cropped read below then warms ORT and
  // produces the record the save step expects.
  await page.reload({ waitUntil: "load" });
  await page.waitForSelector("header h1", { timeout: 10000 });
  await injectMultiLineLabel("multiline-label-2.png");
  await page.waitForSelector(".crop-stage", { timeout: 10000 });
  await page.getByText("全体読取", { exact: true }).click();
  await assertResult("classic-full-cold-start", "KX[-—_ ]?1234AB", "98765");
  log("Step 3b: full-image read works as the first OCR after reload (cold ORT).");
  await page.locator(".ocr-modal").getByText("再読取", { exact: true }).click();
  await page.waitForSelector(".crop-stage", { timeout: 10000 });
  await expandCropToFull();
  await page.getByText("指定範囲読取", { exact: true }).click();
  await assertResult("Paddle-crop-postreload", "KX[-—_ ]?1234AB", "98765");

  // Save the record. Lands on the 一覧 'day' view (the saved record's day),
  // where the record is visible; the calendar is not shown in day view.
  await page.getByText("保存する", { exact: true }).click();
  await page.waitForFunction(() => document.querySelector("header .nav button.active") &&
    document.querySelector("header .nav button.active").textContent.includes("カレンダー"), { timeout: 8000 });
  await page.waitForSelector(".rec .txt", { timeout: 8000 });

  const now = new Date();
  const todayHdrDay = now.getFullYear() + "年" + (now.getMonth() + 1) + "月" + now.getDate() + "日";
  const dayViewOk = await page.evaluate((hdrDay) => {
    const nav = document.querySelector(".navlabel");   // day view shows the date in the nav label
    const recText = [...document.querySelectorAll(".rec .txt")].map((e) => e.textContent).join("\n");
    return { hasToday: !!nav && nav.textContent.startsWith(hdrDay), hasText: /KX/i.test(recText) && /98765/.test(recText) };
  }, todayHdrDay);
  if (!dayViewOk.hasToday) return fail("Saved record's date not shown in the day-view nav label (" + todayHdrDay + ").");
  if (!dayViewOk.hasText) return fail("Saved record text not found in the day view after saving.");
  // Day view carries ←前の日 / 次の日→ nav (small link-style); with a single
  // record-day both arrows are disabled.
  const dayNav = await page.evaluate(() => {
    const btns = [...document.querySelectorAll(".navrow .navbtn")];
    return { count: btns.length, allDisabled: btns.length === 2 && btns.every((b) => b.disabled) };
  });
  if (!dayNav.allDisabled) return fail("Day view prev/next-day nav missing or not disabled at the only record-day (buttons=" + dayNav.count + ").");
  log("Step 4: after 保存, landed on the day view showing today's record (" + todayHdrDay + "); 前の日/次の日 disabled at the single record-day.");

  // Header タブは「カレンダー」。押すとカレンダー画面へ(戻るボタンは廃止)。
  // (day view has both the header tab and the view toggle labelled カレンダー,
  // so scope this click to the header.)
  await page.locator("header").getByText("カレンダー", { exact: true }).click();
  await page.waitForSelector(".calgrid", { timeout: 8000 });
  const badge = await page.evaluate(() => !!document.querySelector(".calcell.has .caldot"));
  if (!badge) return fail("Calendar badge (.caldot) not shown for a day with records.");
  log("Step 4a: 「カレンダー」タブでカレンダー画面＋日バッジを表示。");
  // SE2 gate: the calendar screen must fit without scrolling.
  await checkSE2("calendar", "main");

  // ---- List-mode transitions via the [カレンダー | 月単位 | 日単位] toggle ----
  // calendar -> 月単位 (month list).
  await page.locator(".viewtoggle").getByText("月単位", { exact: true }).click();
  await page.waitForSelector(".datehdr-link", { timeout: 8000 });
  const monthOk = await page.evaluate(() =>
    !!document.querySelector(".datehdr-link") &&
    !document.querySelector(".calgrid") &&
    [...document.querySelectorAll(".rec .txt")].some((e) => /KX/i.test(e.textContent)));
  if (!monthOk) return fail("月単位 view: missing tappable date header / records, or still shows the calendar grid.");
  // 月単位 has its own month nav (← 前の月 / 次の月 →): the year-month label changes.
  const mlabel0 = (await page.locator(".navrow .navlabel").textContent()).trim();
  await page.locator(".navrow .navbtn").last().click();        // 次の月 →
  const mlabel1 = (await page.locator(".navrow .navlabel").textContent()).trim();
  if (mlabel1 === mlabel0) return fail("月単位 の月移動で年月ラベルが変化しない (" + mlabel0 + ").");
  await page.locator(".navrow .navbtn").first().click();       // ← 前の月 (back)
  await page.waitForSelector(".datehdr-link", { timeout: 8000 });
  // 月単位 -> 日単位 by tapping a date header.
  await page.locator(".datehdr-link").first().click();
  await page.waitForFunction(() => !document.querySelector(".datehdr-link") && !!document.querySelector(".rec .txt"), null, { timeout: 8000 });
  const dayFromMonth = await page.evaluate(() => {
    const nav = document.querySelector(".navrow .navlabel");
    return !!nav && /日/.test(nav.textContent) && !document.querySelector(".calgrid");
  });
  if (!dayFromMonth) return fail("月単位の日付見出しタップで日単位ビューに入れない。");
  // 日単位 -> カレンダー (toggle).
  await page.locator(".viewtoggle").getByText("カレンダー", { exact: true }).click();
  await page.waitForSelector(".calgrid", { timeout: 8000 });
  // カレンダー -> 日単位 (toggle).
  await page.locator(".viewtoggle").getByText("日単位", { exact: true }).click();
  await page.waitForFunction(() => !document.querySelector(".calgrid") && !!document.querySelector(".rec .txt"), null, { timeout: 8000 });
  // Back to calendar for the following steps.
  await page.locator(".viewtoggle").getByText("カレンダー", { exact: true }).click();
  await page.waitForSelector(".calgrid", { timeout: 8000 });
  log("Step 4b: カレンダー↔月単位↔日単位 の相互遷移＋月/日ナビを確認。");

  // Reload -> persistence. Entering 一覧 shows the calendar; open the day.
  await page.reload({ waitUntil: "load" });
  await page.waitForSelector("header h1", { timeout: 10000 });
  await page.getByText("カレンダー", { exact: true }).click();
  await openDayWithRecords();
  const persisted = await page.evaluate(() =>
    [...document.querySelectorAll(".rec .txt")].some((e) => /KX/i.test(e.textContent) && /98765/.test(e.textContent)));
  if (!persisted) return fail("Record did not persist across reload (IndexedDB).");
  log("Step 5: record persisted across reload (IndexedDB); 一覧→カレンダー→日選択で表示。");

  // ---- edit flow: 編集 -> textarea (pre-filled) -> 保存 -> list + persistence ----
  await page.getByText("編集", { exact: true }).click();
  await page.waitForSelector(".rec textarea", { timeout: 5000 });
  const prefilledOk = await page.evaluate(() => {
    const ta = document.querySelector(".rec textarea");
    return !!ta && /KX/i.test(ta.value) && /98765/.test(ta.value);
  });
  if (!prefilledOk) return fail("Edit textarea was not pre-filled with the record's existing text.");
  // While editing, the other per-record actions (再読取/コピー/編集/削除) must
  // not be rendered.
  const otherActionsHidden = await page.evaluate(() =>
    !document.querySelector(".rec .reread") &&
    !document.querySelector(".rec .txt-acts") &&
    !document.querySelector(".rec .del-x"));
  if (!otherActionsHidden) return fail("再読取/コピー/編集/削除 were still present while a record was in edit mode.");
  await page.evaluate(() => {
    const ta = document.querySelector(".rec textarea");
    ta.value = ta.value + " EDITED-999";
    ta.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await page.getByText("保存", { exact: true }).click();
  await page.waitForFunction(() => !document.querySelector(".rec textarea"), { timeout: 5000 });
  const editShowsInList = await page.evaluate(() =>
    [...document.querySelectorAll(".rec .txt")].some((e) => /EDITED-999/.test(e.textContent)));
  if (!editShowsInList) return fail("Edited text was not reflected in the list after saving.");
  log("Step 5a: 編集 -> textarea (pre-filled) -> 保存 updated the list text; other actions were hidden while editing.");

  await page.reload({ waitUntil: "load" });
  await page.waitForSelector("header h1", { timeout: 10000 });
  await page.getByText("カレンダー", { exact: true }).click();
  await openDayWithRecords();
  const editPersisted = await page.evaluate(() =>
    [...document.querySelectorAll(".rec .txt")].some((e) => /EDITED-999/.test(e.textContent)));
  if (!editPersisted) return fail("Edited record text did not persist across reload (IndexedDB).");
  log("Step 5b: edited text persisted across reload (IndexedDB).");

  // ---- lightbox on saved thumbnail ----
  await page.click(".rec .thumb");
  await page.waitForSelector(".lightbox img", { timeout: 5000 });
  const lbSrcOk = await page.evaluate(() => {
    const img = document.querySelector(".lightbox img");
    return !!img && img.src.startsWith("data:image/");
  });
  if (!lbSrcOk) return fail("Lightbox image did not show the saved data URL.");
  await page.click(".lightbox");
  await page.waitForFunction(() => !document.querySelector(".lightbox"), { timeout: 5000 });
  log("Step 5c: thumbnail tap opened the lightbox; tap closed it.");

  // ---- re-OCR from a saved record (B案: overwrites the SAME record) ----
  // 再読み取り opens the recognition MODAL from the 一覧 (origin=list). The modal
  // carries no 撮影/一覧 tabs. キャンセル returns to the list unchanged; 上書き保存
  // overwrites the source record in place (same calendar entry, updated text)
  // instead of creating a new record — the reported UX bug this fixes.
  const recCountBefore = await page.evaluate(() => document.querySelectorAll(".rec").length);

  // (a) cancel path: 再読み取り -> recognition modal -> キャンセル -> back to the
  //     list, record count unchanged.
  await page.locator(".rec").getByText("再読取", { exact: true }).first().click();
  await page.waitForSelector(".ocr-modal .crop-stage", { timeout: 10000 });
  const modalHasTabs = await page.evaluate(() => !!document.querySelector(".ocr-modal .nav"));
  if (modalHasTabs) return fail("Recognition modal must not contain 撮影/一覧 tabs.");
  await page.getByText("キャンセル", { exact: true }).click();
  await page.waitForSelector(".rec .txt", { timeout: 8000 });
  const afterCancelCount = await page.evaluate(() => document.querySelectorAll(".rec").length);
  if (afterCancelCount !== recCountBefore) {
    return fail("再認識のキャンセルでレコード数が変化した (" + recCountBefore + " -> " + afterCancelCount + ").");
  }
  log("Step 5d: 再読み取り -> 認識モーダル(タブなし) -> キャンセルで一覧へ戻り、件数不変。");

  // (b) overwrite path: 再読み取り -> read -> tag text -> 上書き保存 ->
  //     the SAME record is updated (count unchanged, marker text present).
  await page.locator(".rec").getByText("再読取", { exact: true }).first().click();
  await page.waitForSelector(".ocr-modal .crop-stage", { timeout: 10000 });
  await expandCropToFull();
  await page.getByText("指定範囲読取", { exact: true }).click();
  await assertResult("Re-OCR-from-saved", "KX[-—_ ]?1234AB", "98765");
  const overwriteBtnCount = await page.getByText("上書き保存", { exact: true }).count();
  if (overwriteBtnCount < 1) return fail("再認識の結果画面に「上書き保存」ボタンが無い (origin=list の上書きモードになっていない)。");
  const preSave = await page.evaluate(() => {
    const ta = document.querySelector(".ocr-modal textarea");
    ta.value = ta.value + " REOCR-777";
    ta.dispatchEvent(new Event("input", { bubbles: true }));
    return { textareas: document.querySelectorAll("textarea").length, modalVal: ta.value };
  });
  log("Step 5e pre-save: #textareas=" + preSave.textareas + " modalVal=" + JSON.stringify(preSave.modalVal));
  await page.getByText("上書き保存", { exact: true }).click();
  await page.waitForFunction(() => document.querySelector("header .nav button.active") &&
    document.querySelector("header .nav button.active").textContent.includes("カレンダー"), { timeout: 8000 });
  await page.waitForSelector(".rec .txt", { timeout: 8000 });
  // Wait for the overwrite to reflect in the list (guards any refresh timing).
  let markerSeen = true;
  try {
    await page.waitForFunction(() =>
      [...document.querySelectorAll(".rec .txt")].some((e) => /REOCR-777/.test(e.textContent)), null, { timeout: 8000 });
  } catch (e) { markerSeen = false; }
  const afterOverwrite = await page.evaluate(() => ({
    count: document.querySelectorAll(".rec").length,
    txts: [...document.querySelectorAll(".rec .txt")].map((e) => e.textContent)
  }));
  if (afterOverwrite.count !== recCountBefore) {
    return fail("再認識の上書き保存で新しいカレンダー記録が増えた (" + recCountBefore + " -> " + afterOverwrite.count + ")。同一レコードを上書きすべき。");
  }
  if (!markerSeen) return fail("再認識の上書き保存後、更新テキスト(REOCR-777)が一覧に反映されていない。list txts: " + JSON.stringify(afterOverwrite.txts));
  log("Step 5e: 再読み取り -> 上書き保存で同一レコードを更新(件数不変・テキスト反映)。");

  // Overwrite persists across reload as the same single record (no dup entry).
  await page.reload({ waitUntil: "load" });
  await page.waitForSelector("header h1", { timeout: 10000 });
  await page.getByText("カレンダー", { exact: true }).click();
  await openDayWithRecords();
  const overwritePersisted = await page.evaluate(() => ({
    count: document.querySelectorAll(".rec").length,
    marker: [...document.querySelectorAll(".rec .txt")].some((e) => /REOCR-777/.test(e.textContent))
  }));
  if (overwritePersisted.count !== recCountBefore) return fail("再認識上書き後のレコード数がリロードで変化した。");
  if (!overwritePersisted.marker) return fail("再認識の上書きテキストが永続化されていない (IndexedDB)。");
  log("Step 5f: 上書き保存はリロード後も同一レコードとして永続化(件数不変)。");

  // ---- Scroll behavior: in the day/month views the nav (toggle + prev/next)
  // stays fixed and ONLY the records scroll. Inject several records on today so
  // the list overflows, then at SE2 assert <main> does not scroll while the
  // .listbody does, and the toggle lives in the fixed .listhead. ----
  await page.evaluate(async () => {
    const c = document.createElement("canvas"); c.width = 12; c.height = 12;
    const img = c.toDataURL("image/png");
    const now = new Date();
    const pad = (n) => (n < 10 ? "0" + n : "" + n);
    const dateKey = now.getFullYear() + "-" + pad(now.getMonth() + 1) + "-" + pad(now.getDate());
    await new Promise((resolve, reject) => {
      const req = indexedDB.open("label_ocr_db", 1);
      req.onsuccess = () => {
        const db = req.result;
        const tx = db.transaction("records", "readwrite");
        const os = tx.objectStore("records");
        for (let k = 0; k < 8; k++) {
          os.put({
            id: "scroll-" + k + "-" + Math.random().toString(36).slice(2),
            createdAt: new Date(now.getTime() - (k + 1) * 1000).toISOString(),
            dateKey, text: "SCROLLTEST-" + k + "\nMODEL: KX-" + k, imageDataUrl: img
          });
        }
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      };
      req.onerror = () => reject(req.error);
    });
  });
  await page.reload({ waitUntil: "load" });
  await page.waitForSelector("header h1", { timeout: 10000 });
  await page.getByText("カレンダー", { exact: true }).click();
  await openDayWithRecords();                                   // calendar -> tap day -> day view
  // Assert the current listcol view keeps a fixed .listhead (toggle+nav) and
  // scrolls only .listbody; <main> must not scroll.
  const assertListScroll = async (modeName) => {
    await page.setViewportSize(SE2);
    await page.waitForTimeout(150);
    const s = await page.evaluate(() => {
      const main = document.querySelector("main");
      const bodyEl = document.querySelector(".listcol .listbody");
      return {
        recCount: document.querySelectorAll(".rec").length,
        mainOverflow: main ? main.scrollHeight - main.clientHeight : -1,
        bodyOverflow: bodyEl ? bodyEl.scrollHeight - bodyEl.clientHeight : -1,
        hasHead: !!document.querySelector(".listcol .listhead"), hasBody: !!bodyEl,
        toggleInHead: !!document.querySelector(".listcol .listhead .viewtoggle"),
        navInHead: !!document.querySelector(".listcol .listhead .navrow")
      };
    });
    await page.setViewportSize(BIG);
    log("Step 5g[" + modeName + "]: recCount=" + s.recCount + " mainOverflow=" + s.mainOverflow + " bodyOverflow=" + s.bodyOverflow);
    if (!s.hasHead || !s.hasBody) return fail(modeName + " view: not split into a fixed .listhead and a scrolling .listbody.");
    if (!s.toggleInHead || !s.navInHead) return fail(modeName + " view: the toggle / prev-next nav are not in the fixed .listhead.");
    if (s.bodyOverflow <= 2) return fail(modeName + " view: .listbody did not become scrollable with many records (overflow=" + s.bodyOverflow + ").");
    if (s.mainOverflow > 2) return fail(modeName + " view: <main> itself scrolls (" + s.mainOverflow + "px); only .listbody should.");
  };
  await assertListScroll("日単位");
  // Same for the 月単位 view (records under the month grouping).
  await page.locator(".viewtoggle").getByText("月単位", { exact: true }).click();
  await page.waitForSelector(".datehdr-link", { timeout: 8000 });
  await assertListScroll("月単位");
  log("Step 5g: nav stays fixed (.listhead) and only the records scroll (.listbody) in both 日単位 and 月単位.");

  // ---- Japanese OCR mode ----
  const cjkFamily = detectCjkFont();
  log(cjkFamily
    ? `CJK font detected on this system: "${cjkFamily}" -> running CJK-glyph variant.`
    : "No CJK font detected (fc-list has no cjk/noto-jp match) -> running ASCII-in-jpn-mode variant.");

  await page.getByText("撮影", { exact: true }).click();
  await page.waitForSelector(".card", { timeout: 8000 });
  log("Step 6: back to 撮影 (capture) to start a fresh jpn-mode read; mode is now chosen on the crop screen.");

  const variant = cjkFamily ? "cjk" : "ascii";
  await page.evaluate(({ variant, cjkFamily }) => {
    const c = document.createElement("canvas");
    c.width = 700; c.height = 220;
    const x = c.getContext("2d");
    x.fillStyle = "#fff"; x.fillRect(0, 0, c.width, c.height);
    x.fillStyle = "#000"; x.textBaseline = "top";
    if (variant === "cjk") {
      x.font = `32px "${cjkFamily}"`;
      // 品番 AB-1234: kanji + latin + embedded digits, all read reliably by the
      // japan PP-OCRv3 rec model. (Isolated uppercase X adjacent to kanji, e.g.
      // "型番 KX", can be misread as katakana メ by this model — a documented
      // limitation; the robust digit/kanji/kana coverage is what the gates
      // below exercise.)
      x.fillText("品番 AB-1234", 30, 60);
    } else {
      x.font = "28px monospace";
      x.fillText("MODEL KX-9876", 30, 50);
      x.fillText("TYPE JP-TEST", 30, 120);
    }
    return new Promise((resolve) => {
      c.toBlob((blob) => {
        const file = new File([blob], "label-jpn.png", { type: "image/png" });
        const input = document.querySelector('input[type=file]:not([capture])');
        const dt = new DataTransfer();
        dt.items.add(file);
        input.files = dt.files;
        input.dispatchEvent(new Event("change", { bubbles: true }));
        resolve();
      }, "image/png");
    });
  }, { variant, cjkFamily });
  log(`Step 8: jpn-mode ${variant === "cjk" ? "CJK label (品番 AB-1234)" : "ASCII label (MODEL KX-9876 / TYPE JP-TEST)"} image injected; running cropped PaddleOCR (japan) path...`);

  await selectMode("jpn");
  await expandCropToFull();
  await page.getByText("指定範囲読取", { exact: true }).click();

  try {
    await page.waitForSelector("textarea", { timeout: 150000 });
    await page.waitForFunction((v) => {
      const ta = document.querySelector("textarea");
      if (!ta) return false;
      const t = ta.value;
      if (v === "cjk") {
        return /AB/i.test(t) && /1234/.test(t) && /[぀-ヿ㐀-䶿一-鿿]/.test(t);
      }
      return /KX/i.test(t) && /9876/.test(t);
    }, variant, { timeout: 150000 });
  } catch (e) {
    const ta = await page.evaluate(() => { const t = document.querySelector("textarea"); return t ? t.value : "(no textarea)"; });
    return fail("Japanese-mode OCR text assertion failed (variant: " + variant + "). textarea value was:\n" + ta);
  }
  const jpnRecognized = await page.evaluate(() => document.querySelector("textarea").value);
  const engine3 = await page.evaluate(() => { const e = document.querySelector(".engine b"); return e ? e.textContent : ""; });
  if (!/PaddleOCR/.test(engine3)) return fail("Expected PaddleOCR engine for jpn cropped path, got: " + engine3);
  log(`Step 9: jpn-mode cropped OCR via ${engine3} succeeded (${variant} variant). Recognized:\n  ` + jpnRecognized.replace(/\n/g, "\\n"));

  if (cspViolations.length) return fail("CSP violation(s) occurred during Japanese-mode OCR.");
  const cspFromPage2 = await page.evaluate(() => window.__csp || []);
  if (cspFromPage2.length) { cspViolations.push(...cspFromPage2); return fail("securitypolicyviolation events fired during Japanese-mode OCR."); }
  log("Step 9a: jpn mode ran entirely on the self-hosted japan PP-OCRv3 rec model (models/japan_rec.onnx).");

  // ---- ACCEPTANCE GATE: embedded half-width digits in Japanese text ----
  // The user problem: kanji text with embedded half-width digits (an address
  // like 東京都千代田区1-2-3, or unit specs like 定格 100V 50Hz 1.5A) must keep
  // the digits intact. The japan PP-OCRv3 rec model + full-width normalization
  // recover them. Only meaningful with a CJK-capable font; skipped otherwise.
  // Unit letters are compared case-insensitively: this rec model can emit a
  // lowercase v for V or an uppercase Z for z (a documented case quirk on
  // isolated Latin), which does not affect digit/unit survival.
  if (cjkFamily) {
    // The app normalizes full-width->half-width in jpn mode already; normalize
    // here too so the assertion is robust whichever form the engine emitted.
    const normW = (s) => s
      .replace(/[！-～]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0))
      .replace(/[‐-―−]/g, "-");
    async function runJpnCropAccept(text, filename) {
      await page.getByText("キャンセル", { exact: true }).click();
      await page.waitForSelector(".card", { timeout: 8000 });
      await page.evaluate(({ text, filename, cjkFamily }) => {
        const c = document.createElement("canvas");
        c.width = 780; c.height = 110;
        const x = c.getContext("2d");
        x.fillStyle = "#fff"; x.fillRect(0, 0, c.width, c.height);
        x.fillStyle = "#000"; x.textBaseline = "top"; x.font = `32px "${cjkFamily}"`;
        x.fillText(text, 24, 38);
        return new Promise((resolve) => {
          c.toBlob((blob) => {
            const file = new File([blob], filename, { type: "image/png" });
            const input = document.querySelector('input[type=file]:not([capture])');
            const dt = new DataTransfer();
            dt.items.add(file);
            input.files = dt.files;
            input.dispatchEvent(new Event("change", { bubbles: true }));
            resolve();
          }, "image/png");
        });
      }, { text, filename, cjkFamily });
      await expandCropToFull();
      await page.getByText("指定範囲読取", { exact: true }).click();
      await page.waitForFunction(() => {
        const ta = document.querySelector("textarea");
        return ta && ta.value.trim().length > 0;
      }, { timeout: 150000 });
      return await page.evaluate(() => document.querySelector("textarea").value);
    }

    // Image A: 東京都千代田区1-2-3 -> must contain 東京都, 千代田区, and 1-2-3.
    const rawA = await runJpnCropAccept("東京都千代田区1-2-3", "addr-A.png");
    const normA = normW(rawA);
    log("Acceptance A (東京都千代田区1-2-3) recognized:\n  raw: " + rawA.replace(/\n/g, "\\n") + "\n  norm: " + normA.replace(/\n/g, "\\n"));
    for (const need of ["東京都", "千代田区", "1-2-3"]) {
      if (normA.indexOf(need) < 0) {
        return fail("Acceptance A failed: recognized text missing \"" + need + "\".\n  normalized: " + normA + "\n  raw: " + rawA);
      }
    }
    log("Acceptance A PASSED: 東京都 / 千代田区 / 1-2-3 all present.");

    if (cspViolations.length) return fail("CSP violation(s) during acceptance A.");
    const cspA = await page.evaluate(() => window.__csp || []);
    if (cspA.length) { cspViolations.push(...cspA); return fail("securitypolicyviolation during acceptance A."); }

    // Image B: 定格 100V 50Hz 1.5A -> must contain 100V, 50Hz, 1.5A (unit
    // letters case-insensitive; see note above).
    const rawB = await runJpnCropAccept("定格 100V 50Hz 1.5A", "spec-B.png");
    const normB = normW(rawB).replace(/\s+/g, " ");
    const flatB = normB.replace(/\s+/g, "").toUpperCase();
    log("Acceptance B (定格 100V 50Hz 1.5A) recognized:\n  raw: " + rawB.replace(/\n/g, "\\n") + "\n  norm: " + normB.replace(/\n/g, "\\n"));
    for (const need of ["100V", "50HZ", "1.5A"]) {
      if (flatB.indexOf(need) < 0) {
        return fail("Acceptance B failed: recognized text missing \"" + need + "\" (case-insensitive).\n  normalized: " + normB + "\n  raw: " + rawB);
      }
    }
    log("Acceptance B PASSED: 100V / 50Hz / 1.5A all present (case-insensitive).");

    if (cspViolations.length) return fail("CSP violation(s) during acceptance B.");
    const cspB = await page.evaluate(() => window.__csp || []);
    if (cspB.length) { cspViolations.push(...cspB); return fail("securitypolicyviolation during acceptance B."); }

    // Image C (kana gate): 型番たしかめ 12-34 -> hiragana must SURVIVE (must NOT
    // be ASCII-stripped, which is what the eng path would do) and the embedded
    // digits 12-34 must read back exactly.
    const rawC = await runJpnCropAccept("型番たしかめ 12-34", "kana-C.png");
    const normC = normW(rawC);
    log("Acceptance C kana (型番たしかめ 12-34) recognized:\n  raw: " + rawC.replace(/\n/g, "\\n") + "\n  norm: " + normC.replace(/\n/g, "\\n"));
    if (!/[぀-ゟ]/.test(normC)) return fail("Acceptance C (kana) failed: no hiragana survived — kana must not be ASCII-stripped in jpn mode.\n  norm: " + normC);
    if (normC.replace(/\s+/g, "").indexOf("12-34") < 0) return fail("Acceptance C (kana) failed: embedded digits 12-34 missing.\n  norm: " + normC);
    log("Acceptance C PASSED: hiragana survived and 12-34 read exactly.");

    if (cspViolations.length) return fail("CSP violation(s) during acceptance C.");
    const cspC = await page.evaluate(() => window.__csp || []);
    if (cspC.length) { cspViolations.push(...cspC); return fail("securitypolicyviolation during acceptance C."); }
  } else {
    log("Acceptance A/B/C skipped: no CJK font available to render kanji labels.");
  }

  // ---- 単語フィルタ (word filter) test: decoy cert-mark image on the
  // cropped 英数字 (Paddle) path ----
  // A circled "R" (plausible misread source for registered-trademark /
  // certification-mark logos), a boxed kanji "検" (IPAGothic, only drawn if
  // a CJK font is available), a stray triangle shape, plus the usual
  // model/serial lines and two real-English-word lines ("MADE" / "JAPAN").
  // MADE and JAPAN are kept on separate lines here (this test predates
  // word-level segmentation and is left as-is since it's still a valid,
  // independent check of the dictionary/pattern token classifier); the
  // "MADE IN JAPAN" *same-line* recovery via per-word segmentation is
  // covered by the dedicated word-segmentation acceptance test above, which
  // confirms this rec model's CTC output -- which does not reliably predict
  // an inter-word space when a whole line is decoded in one shot -- is no
  // longer a blocker now that each word is cropped and recognized on its own.
  // Note: PaddleOCR's rec-only pipeline already strips all non-ASCII output
  // (see paddleRecognize's ascii-strip), so the boxed kanji can never reach
  // this path's text regardless of the new word filter -- it's included for
  // scene realism and to prove the extra glyph doesn't break line/band
  // detection. The CJK single-run-length rule is exercised end-to-end by
  // the jpn-mode tests above/below instead.
  async function generateDecoyLabelDataUrl(cjkFamily) {
    return await page.evaluate(({ cjkFamily }) => {
      const c = document.createElement("canvas");
      c.width = 760; c.height = 320;
      const ctx = c.getContext("2d");
      ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, c.width, c.height);
      ctx.fillStyle = "#000"; ctx.strokeStyle = "#000"; ctx.lineWidth = 2;

      // Circled "R" -- registered-trademark-style cert mark misread source.
      ctx.beginPath(); ctx.arc(40, 40, 20, 0, Math.PI * 2); ctx.stroke();
      ctx.font = "22px monospace"; ctx.textAlign = "center"; ctx.textBaseline = "middle";
      ctx.fillText("R", 40, 41);

      // Boxed kanji "検" -- squared cert-mark misread source (only if a CJK
      // font is available in this environment).
      if (cjkFamily) {
        ctx.strokeRect(85, 20, 40, 40);
        ctx.font = `26px "${cjkFamily}"`;
        ctx.fillText("検", 105, 41);
      }

      // Stray triangle shape (no character inside, just geometry to misread).
      ctx.beginPath();
      ctx.moveTo(150, 55); ctx.lineTo(170, 20); ctx.lineTo(190, 55); ctx.closePath();
      ctx.stroke();

      ctx.textAlign = "left"; ctx.textBaseline = "top"; ctx.font = "26px monospace";
      ctx.fillText("MODEL: KX-1234AB", 30, 90);
      ctx.fillText("S/N 5X-98765", 30, 150);
      ctx.fillText("MADE", 30, 210);
      ctx.fillText("JAPAN", 30, 270);
      return c.toDataURL("image/png");
    }, { cjkFamily });
  }

  const DECOY_LABEL_STRINGS = ["MODEL: KX-1234AB", "S/N 5X-98765", "MADE", "JAPAN"];
  const decoyDataUrl = await generateDecoyLabelDataUrl(cjkFamily);
  log("Step 10: decoy label image generated (circled R, boxed kanji, triangle, model/serial, MADE, JAPAN).");

  await page.getByText("キャンセル", { exact: true }).click();
  await page.waitForSelector(".card", { timeout: 8000 });
  await injectDataUrlFile(decoyDataUrl, "decoy-label.png");
  await selectMode("eng");
  await expandCropToFull();
  await page.getByText("指定範囲読取", { exact: true }).click();
  await assertResult("Decoy-Paddle-crop", "KX[-—_ ]?1234AB", "98765");
  const engineDecoy = await page.evaluate(() => { const e = document.querySelector(".engine b"); return e ? e.textContent : ""; });
  if (!/PaddleOCR/.test(engineDecoy)) return fail("Expected PaddleOCR engine for decoy cropped 英数字 path, got: " + engineDecoy);

  const wfLabelOn = await page.evaluate(() => { const b = document.querySelector(".wftoggle"); return b ? b.textContent : ""; });
  if (wfLabelOn !== "ON") return fail("Expected 単語フィルタ toggle to default to ON, got: " + wfLabelOn);

  const decoyFilteredText = await page.evaluate(() => document.querySelector("textarea").value);
  if (!/MADE/.test(decoyFilteredText)) return fail("Decoy test: filtered text missing MADE. Text was:\n" + decoyFilteredText);
  if (!/JAPAN/.test(decoyFilteredText)) return fail("Decoy test: filtered text missing JAPAN. Text was:\n" + decoyFilteredText);
  const decoyTokens = decoyFilteredText.split(/\s+/).filter(Boolean);
  const singleCharTok = decoyTokens.find((t) => [...t].length === 1);
  if (singleCharTok) return fail("Decoy test: found a standalone single-character token (\"" + singleCharTok + "\") in filtered text:\n" + decoyFilteredText);
  const garbageDecoy = countGarbage(decoyFilteredText, DECOY_LABEL_STRINGS);
  log("Step 11: decoy-image Paddle-crop filtered text (garbage=" + garbageDecoy + "):\n  " + decoyFilteredText.replace(/\n/g, "\\n"));
  if (garbageDecoy > 2) return fail("Decoy test garbage count too high (" + garbageDecoy + " > 2). Filtered text:\n" + decoyFilteredText);

  if (cspViolations.length) return fail("CSP violation(s) occurred during decoy-image OCR.");
  const cspFromPage5 = await page.evaluate(() => window.__csp || []);
  if (cspFromPage5.length) { cspViolations.push(...cspFromPage5); return fail("securitypolicyviolation events fired during decoy-image OCR."); }

  await page.getByText("キャンセル", { exact: true }).click();
  await page.waitForSelector(".card", { timeout: 8000 });

  // ---- Acceptance test: word-level segmentation on the Paddle path ----
  // One line "MADE IN JAPAN" (monospace, generous word spacing) plus the
  // usual MODEL/S-N lines, through the cropped 英数字 (Paddle) path. Each
  // line band is now further split into per-word boxes by column-gap
  // segmentation (segmentWordsInLine) and each word is recognized
  // independently, then rejoined with single spaces -- so MADE / IN / JAPAN
  // should come back as separate tokens on the SAME output line, instead of
  // requiring separate photographed lines (this rec model rarely emits an
  // inter-word space when a whole line is decoded in one shot).
  async function generateWordSegLabelDataUrl() {
    return await page.evaluate(() => {
      const c = document.createElement("canvas");
      c.width = 760; c.height = 260;
      const ctx = c.getContext("2d");
      ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, c.width, c.height);
      ctx.fillStyle = "#000"; ctx.textBaseline = "top"; ctx.font = "28px monospace";
      ctx.fillText("MODEL: KX-1234AB", 30, 30);
      ctx.fillText("S/N 5X-98765", 30, 90);
      // Generous inter-word spacing (well past the word-gap split
      // threshold) -- letters within a word keep normal monospace kerning
      // (well under it), so this should split into 3 word boxes.
      ctx.fillText("MADE     IN     JAPAN", 30, 170);
      return c.toDataURL("image/png");
    });
  }

  const wordSegDataUrl = await generateWordSegLabelDataUrl();
  log("Step 12: word-segmentation label image generated (MODEL/S-N lines + one 'MADE     IN     JAPAN' line).");

  await injectDataUrlFile(wordSegDataUrl, "wordseg-label.png");
  await selectMode("eng");
  await expandCropToFull();
  await page.getByText("指定範囲読取", { exact: true }).click();
  await assertResult("WordSeg-Paddle-crop", "KX[-—_ ]?1234AB", "98765");
  const engineWordSeg = await page.evaluate(() => { const e = document.querySelector(".engine b"); return e ? e.textContent : ""; });
  if (!/PaddleOCR/.test(engineWordSeg)) return fail("Expected PaddleOCR engine for word-segmentation cropped 英数字 path, got: " + engineWordSeg);
  const wordSegText = await page.evaluate(() => document.querySelector("textarea").value);
  log("Step 12b: word-segmentation Paddle-crop recognized:\n  " + wordSegText.replace(/\n/g, "\\n"));
  const madeJapanSameLine = wordSegText.split("\n").some((line) => /MADE/i.test(line) && /JAPAN/i.test(line));
  if (!madeJapanSameLine) return fail("Word-segmentation test: MADE and JAPAN not found on the same output line. Text was:\n" + wordSegText);
  const fullPhraseLine = wordSegText.split("\n").some((line) => /MADE\s+IN\s+JAPAN/i.test(line));
  log(fullPhraseLine
    ? "Step 12c: full phrase 'MADE IN JAPAN' recovered on one line (IN survived)."
    : "Step 12c: MADE + JAPAN recovered on one line, but IN did not survive as its own recognized word (rec misread) -- acceptable per spec relaxation.");

  if (cspViolations.length) return fail("CSP violation(s) occurred during word-segmentation OCR.");
  const cspFromPage6 = await page.evaluate(() => window.__csp || []);
  if (cspFromPage6.length) { cspViolations.push(...cspFromPage6); return fail("securitypolicyviolation events fired during word-segmentation OCR."); }

  await page.getByText("キャンセル", { exact: true }).click();
  await page.waitForSelector(".card", { timeout: 8000 });

  // ---- Acceptance test: barcode-neighbor digits are no longer dropped ----
  // A barcode-like block (40 vertical black stripes, random widths, ~60px
  // tall, spanning ~70% width) directly above the digit line
  // "4 901234 567894" (EAN-style: lone leading digit + two 6-digit groups),
  // and nothing else. Before the barcode-robust banding fix + per-word
  // rejection, the stripe block's own row-ink either starved the relative
  // threshold so the sparser digit row never became its own band, or the
  // two bands merged and the combined whole-line decode failed the
  // score<0.5 gate, dropping the real digits along with the barcode. Now:
  // barcode-robust banding keeps them as separate bands, word segmentation
  // isolates "4" / "901234" / "567894" as separate boxes, and the per-word
  // score gate rejects the barcode segment(s) alone without taking the
  // digits with it. The lone leading "4" survives the 単語フィルタ only via
  // the new EAN single-digit exception (line has >= 6 digits total).
  async function generateBarcodeDigitsDataUrl() {
    return await page.evaluate(() => {
      function mulberry32(seed) {
        return function () {
          seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
          let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
          t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
          return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
        };
      }
      const rand = mulberry32(0xBA5C0DE);
      const c = document.createElement("canvas");
      c.width = 760; c.height = 200;
      const ctx = c.getContext("2d");
      ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, c.width, c.height);
      ctx.fillStyle = "#000";

      // 40 vertical stripes, random widths, spanning ~70% of the width,
      // ~60px tall, starting near the top.
      const barcodeX0 = c.width * 0.15, barcodeW = c.width * 0.7, barcodeY0 = 15, barcodeH = 60;
      const stripeCount = 40;
      const widths = [];
      let totalW = 0;
      for (let i = 0; i < stripeCount; i++) { const sw = 2 + rand() * 6; widths.push(sw); totalW += sw; }
      const scaleW = barcodeW / totalW;
      let x = barcodeX0;
      for (let i = 0; i < stripeCount; i++) {
        const sw = widths[i] * scaleW;
        if (i % 2 === 0) ctx.fillRect(x, barcodeY0, sw, barcodeH);
        x += sw;
      }

      // Digit line directly under the barcode: lone leading digit + two
      // 6-digit groups, generously spaced so each is its own word segment.
      ctx.font = "32px monospace"; ctx.textBaseline = "top";
      ctx.fillText("4     901234     567894", barcodeX0, barcodeY0 + barcodeH + 12);
      return c.toDataURL("image/png");
    });
  }

  const BARCODE_LABEL_STRINGS = ["4", "901234", "567894"];
  const barcodeDataUrl = await generateBarcodeDigitsDataUrl();
  log("Step 13: barcode-neighbor label image generated (40-stripe barcode block + '4 901234 567894' digit line, nothing else).");

  await injectDataUrlFile(barcodeDataUrl, "barcode-digits.png");
  await selectMode("eng");
  await expandCropToFull();
  await page.getByText("指定範囲読取", { exact: true }).click();
  await assertResult("Barcode-Paddle-crop", "901234", "567894");
  const engineBarcode = await page.evaluate(() => { const e = document.querySelector(".engine b"); return e ? e.textContent : ""; });
  if (!/PaddleOCR/.test(engineBarcode)) return fail("Expected PaddleOCR engine for barcode-neighbor cropped 英数字 path, got: " + engineBarcode);
  const barcodeText = await page.evaluate(() => document.querySelector("textarea").value);
  const barcodeTokens = barcodeText.split(/\s+/).filter(Boolean);
  if (!barcodeTokens.includes("4")) {
    return fail("Barcode test: standalone digit '4' token not found (EAN single-digit word-filter exception). Tokens: " +
      JSON.stringify(barcodeTokens) + "\nText:\n" + barcodeText);
  }
  const garbageBarcode = countGarbage(barcodeText, BARCODE_LABEL_STRINGS);
  log("Step 13b: barcode-neighbor Paddle-crop recognized (garbage=" + garbageBarcode + "):\n  " + barcodeText.replace(/\n/g, "\\n"));
  if (garbageBarcode > 2) return fail("Barcode test garbage count too high (" + garbageBarcode + " > 2); barcode stripes likely surfaced tokens. Text:\n" + barcodeText);

  if (cspViolations.length) return fail("CSP violation(s) occurred during barcode-neighbor OCR.");
  const cspFromPage7 = await page.evaluate(() => window.__csp || []);
  if (cspFromPage7.length) { cspViolations.push(...cspFromPage7); return fail("securitypolicyviolation events fired during barcode-neighbor OCR."); }

  await page.getByText("キャンセル", { exact: true }).click();
  await page.waitForSelector(".card", { timeout: 8000 });

  // ---- Noise-robustness test (acceptance gate for the hallucination fixes) ----
  // A background-noise-only crop should not surface hallucinated characters:
  // eng via confidence rejection (score < 0.5) + ASCII-only post-filter, jpn via
  // the same score gate + the 単語フィルタ token classifier.
  const noisyDataUrl = await generateNoisyLabelDataUrl();
  log("Step 14: noisy label image generated (gradient bg + ~800 speckles + vignette).");

  await injectDataUrlFile(noisyDataUrl, "noisy-label.png");
  await selectMode("eng");
  await expandCropToFull();
  await page.getByText("指定範囲読取", { exact: true }).click();
  await assertResult("Noise-Paddle-crop", "KX[-—_ ]?1234AB", "98765");
  const noisyPaddleText = await page.evaluate(() => document.querySelector("textarea").value);
  const engineNoisyPaddle = await page.evaluate(() => { const e = document.querySelector(".engine b"); return e ? e.textContent : ""; });
  if (!/PaddleOCR/.test(engineNoisyPaddle)) return fail("Expected PaddleOCR engine for noisy cropped 英数字 path, got: " + engineNoisyPaddle);
  const garbagePaddle = countGarbage(noisyPaddleText, NOISE_LABEL_STRINGS);
  log("Step 15: noisy-image Paddle-crop recognized (garbage=" + garbagePaddle + "):\n  " + noisyPaddleText.replace(/\n/g, "\\n"));
  if (garbagePaddle > 3) return fail("Noise test (Paddle) garbage count too high (" + garbagePaddle + " > 3). Recognized text:\n" + noisyPaddleText);

  // ---- 単語フィルタ toggle test ----
  // This noisy image is where the word filter has visible work to do: it's
  // the mechanism-proof the spec asks for -- toggle OFF must reveal the raw
  // (pre-word-filter) text, and raw garbage must never be *lower* than
  // filtered garbage (the filter only ever removes noise, never adds it).
  const wfLabelNoisyOn = await page.evaluate(() => { const b = document.querySelector(".wftoggle"); return b ? b.textContent : ""; });
  if (wfLabelNoisyOn !== "ON") return fail("Expected 単語フィルタ toggle to default to ON, got: " + wfLabelNoisyOn);
  await page.click(".wftoggle");
  await page.waitForFunction(() => {
    const b = document.querySelector(".wftoggle"); return b && b.textContent === "OFF";
  }, { timeout: 3000 });
  const noisyPaddleRawText = await page.evaluate(() => document.querySelector("textarea").value);
  const garbagePaddleRaw = countGarbage(noisyPaddleRawText, NOISE_LABEL_STRINGS);
  log("Step 15b: 単語フィルタ toggled OFF on noisy Paddle-crop; raw garbage=" + garbagePaddleRaw + ":\n  " + noisyPaddleRawText.replace(/\n/g, "\\n"));
  if (!/KX/i.test(noisyPaddleRawText) || !/98765/.test(noisyPaddleRawText)) {
    return fail("Toggled-off raw text lost expected model/serial content:\n" + noisyPaddleRawText);
  }
  if (garbagePaddleRaw < garbagePaddle) {
    return fail("Toggle mechanism check failed: raw garbage (" + garbagePaddleRaw + ") should be >= filtered garbage (" + garbagePaddle +
      ").\nraw: " + noisyPaddleRawText + "\nfiltered: " + noisyPaddleText);
  }
  // Toggle back ON, restoring the default for the rest of the run.
  await page.click(".wftoggle");
  await page.waitForFunction(() => {
    const b = document.querySelector(".wftoggle"); return b && b.textContent === "ON";
  }, { timeout: 3000 });
  log("Step 15c: toggle mechanism confirmed (raw garbage=" + garbagePaddleRaw + " >= filtered garbage=" + garbagePaddle + ").");

  if (cspViolations.length) return fail("CSP violation(s) occurred during noisy Paddle OCR.");
  const cspFromPage3 = await page.evaluate(() => window.__csp || []);
  if (cspFromPage3.length) { cspViolations.push(...cspFromPage3); return fail("securitypolicyviolation events fired during noisy Paddle OCR."); }

  // Same noisy image through the cropped jpn PaddleOCR path (japan rec model +
  // the score gate + word filter reject the speckle without hallucinating).
  await page.getByText("キャンセル", { exact: true }).click();
  await page.waitForSelector(".card", { timeout: 8000 });
  await injectDataUrlFile(noisyDataUrl, "noisy-label-2.png");
  await selectMode("jpn");
  await expandCropToFull();
  await page.getByText("指定範囲読取", { exact: true }).click();
  await assertResult("Noise-jpn-Paddle-crop", "KX", "98765|1234");
  const noisyTessText = await page.evaluate(() => document.querySelector("textarea").value);
  const engineNoisyTess = await page.evaluate(() => { const e = document.querySelector(".engine b"); return e ? e.textContent : ""; });
  if (!/PaddleOCR/.test(engineNoisyTess)) return fail("Expected PaddleOCR engine for noisy cropped jpn path, got: " + engineNoisyTess);
  const garbageTess = countGarbage(noisyTessText, NOISE_LABEL_STRINGS);
  log("Step 16: noisy-image jpn PaddleOCR-crop recognized (garbage=" + garbageTess + "):\n  " + noisyTessText.replace(/\n/g, "\\n"));
  if (garbageTess > 6) return fail("Noise test (jpn) garbage count too high (" + garbageTess + " > 6). Recognized text:\n" + noisyTessText);

  if (cspViolations.length) return fail("CSP violation(s) occurred during noisy jpn OCR.");
  const cspFromPage4 = await page.evaluate(() => window.__csp || []);
  if (cspFromPage4.length) { cspViolations.push(...cspFromPage4); return fail("securitypolicyviolation events fired during noisy jpn OCR."); }

  await page.getByText("キャンセル", { exact: true }).click();
  await page.waitForSelector(".card", { timeout: 8000 });

  // ---- Perspective (台形補正) test ----
  // Render the standard label, then warp it onto a larger gray canvas using a
  // known trapezoid quad (top edge inset 12% each side) via a test-side
  // inverse-homography sampler. Feed it in, switch to 台形補正, drag the 4
  // corner handles onto the known quad, run the 英数字/Paddle path, assert the
  // model/serial survive the de-warp.
  const perspQuad = {
    tl: { fx: 0.2264, fy: 0.16 }, tr: { fx: 0.7736, fy: 0.16 },
    br: { fx: 0.86, fy: 0.84 }, bl: { fx: 0.14, fy: 0.84 }
  };
  async function generatePerspectiveLabelDataUrl(quad) {
    return await page.evaluate((quad) => {
      // Flat source label.
      const lw = 560, lh = 180;
      const lc = document.createElement("canvas"); lc.width = lw; lc.height = lh;
      const lx = lc.getContext("2d");
      lx.fillStyle = "#fff"; lx.fillRect(0, 0, lw, lh);
      lx.fillStyle = "#000"; lx.font = "26px monospace"; lx.textBaseline = "top";
      lx.fillText("MODEL: KX-1234AB", 24, 40);
      lx.fillText("S/N 5X-98765", 24, 105);
      const ld = lx.getImageData(0, 0, lw, lh).data;

      // Big canvas, gray background.
      const Wc = 820, Hc = 460;
      const c = document.createElement("canvas"); c.width = Wc; c.height = Hc;
      const ctx = c.getContext("2d");
      ctx.fillStyle = "#8a8a8a"; ctx.fillRect(0, 0, Wc, Hc);
      const img = ctx.getImageData(0, 0, Wc, Hc); const od = img.data;

      // Quad in big-canvas pixels (label placement).
      const Q = {
        tl: { x: quad.tl.fx * Wc, y: quad.tl.fy * Hc }, tr: { x: quad.tr.fx * Wc, y: quad.tr.fy * Hc },
        br: { x: quad.br.fx * Wc, y: quad.br.fy * Hc }, bl: { x: quad.bl.fx * Wc, y: quad.bl.fy * Hc }
      };
      // Homography mapping big-canvas coords -> flat label coords (Gauss-Jordan).
      function solveH(src, dst) {
        const A = [], b = [];
        for (let i = 0; i < 4; i++) {
          const x = src[i].x, y = src[i].y, X = dst[i].x, Y = dst[i].y;
          A.push([x, y, 1, 0, 0, 0, -x * X, -y * X]); b.push(X);
          A.push([0, 0, 0, x, y, 1, -x * Y, -y * Y]); b.push(Y);
        }
        const n = 8;
        for (let col = 0; col < n; col++) {
          let piv = col;
          for (let r = col + 1; r < n; r++) if (Math.abs(A[r][col]) > Math.abs(A[piv][col])) piv = r;
          if (piv !== col) { const t = A[piv]; A[piv] = A[col]; A[col] = t; const tb = b[piv]; b[piv] = b[col]; b[col] = tb; }
          const pv = A[col][col]; if (Math.abs(pv) < 1e-12) continue;
          for (let r = 0; r < n; r++) {
            if (r === col) continue; const f = A[r][col] / pv; if (f === 0) continue;
            for (let cc = col; cc < n; cc++) A[r][cc] -= f * A[col][cc]; b[r] -= f * b[col];
          }
        }
        const hh = new Array(9);
        for (let i = 0; i < n; i++) hh[i] = Math.abs(A[i][i]) < 1e-12 ? 0 : b[i] / A[i][i];
        hh[8] = 1; return hh;
      }
      const srcPts = [Q.tl, Q.tr, Q.br, Q.bl];
      const dstPts = [{ x: 0, y: 0 }, { x: lw, y: 0 }, { x: lw, y: lh }, { x: 0, y: lh }];
      const H = solveH(srcPts, dstPts);
      const xs = srcPts.map((p) => p.x), ys = srcPts.map((p) => p.y);
      const bx0 = Math.max(0, Math.floor(Math.min.apply(null, xs))), by0 = Math.max(0, Math.floor(Math.min.apply(null, ys)));
      const bx1 = Math.min(Wc, Math.ceil(Math.max.apply(null, xs))), by1 = Math.min(Hc, Math.ceil(Math.max.apply(null, ys)));
      for (let y = by0; y < by1; y++) {
        for (let x = bx0; x < bx1; x++) {
          const den = H[6] * x + H[7] * y + H[8];
          const lxp = (H[0] * x + H[1] * y + H[2]) / den, lyp = (H[3] * x + H[4] * y + H[5]) / den;
          if (lxp < 0 || lyp < 0 || lxp > lw - 1 || lyp > lh - 1) continue;
          const x0 = lxp | 0, y0 = lyp | 0;
          const x1 = Math.min(x0 + 1, lw - 1), y1 = Math.min(y0 + 1, lh - 1);
          const fx = lxp - x0, fy = lyp - y0; const oi = (y * Wc + x) * 4;
          for (let ch = 0; ch < 3; ch++) {
            const p00 = ld[(y0 * lw + x0) * 4 + ch], p10 = ld[(y0 * lw + x1) * 4 + ch];
            const p01 = ld[(y1 * lw + x0) * 4 + ch], p11 = ld[(y1 * lw + x1) * 4 + ch];
            const a = p00 + (p10 - p00) * fx, bb = p01 + (p11 - p01) * fx;
            od[oi + ch] = a + (bb - a) * fy;
          }
          od[oi + 3] = 255;
        }
      }
      ctx.putImageData(img, 0, 0);
      return c.toDataURL("image/png");
    }, quad);
  }

  const perspDataUrl = await generatePerspectiveLabelDataUrl(perspQuad);
  await injectDataUrlFile(perspDataUrl, "persp-label.png");
  await selectMode("eng");
  await page.waitForSelector(".crop-stage", { timeout: 10000 });
  log("Step 17: perspective-distorted label injected (trapezoid, top edge inset 12% each side).");

  // Enter 台形補正 mode (this also runs the auto-suggest quad detector).
  await page.getByText("台形補正", { exact: true }).click();
  await page.waitForSelector(".crop-handle.qh-tl", { timeout: 10000 });

  // Auto-suggest sanity: did the detector move corners off the exact rect
  // corners, or fall back cleanly? Assert no JS errors either way.
  const suggested = await page.evaluate(() => {
    const g = (k) => {
      const el = document.querySelector(".crop-handle.qh-" + k);
      const s = document.querySelector(".crop-stage");
      const eb = el.getBoundingClientRect(), sb = s.getBoundingClientRect();
      return { x: (eb.x + eb.width / 2 - sb.x) / sb.width, y: (eb.y + eb.height / 2 - sb.y) / sb.height };
    };
    return { tl: g("tl"), tr: g("tr"), br: g("br"), bl: g("bl") };
  });
  // Rect default corners are x in {0.1,0.9}, y in {0.35,0.65}.
  const rectCorners = { tl: { x: 0.1, y: 0.35 }, tr: { x: 0.9, y: 0.35 }, br: { x: 0.9, y: 0.65 }, bl: { x: 0.1, y: 0.65 } };
  let movedOff = false;
  for (const k of ["tl", "tr", "br", "bl"]) {
    if (Math.abs(suggested[k].x - rectCorners[k].x) > 0.02 || Math.abs(suggested[k].y - rectCorners[k].y) > 0.02) movedOff = true;
  }
  log("Step 17a: auto-suggest " + (movedOff ? "moved corners off the rect defaults (detection did something)" : "fell back to rect corners (clean fallback)") + ".");
  if (errors.length) return fail("JS errors during 台形補正 auto-suggest.");

  // Drag the 4 handles onto the known quad corners.
  {
    const stage = await (await page.$(".crop-stage")).boundingBox();
    for (const key of ["tl", "tr", "br", "bl"]) {
      const tx = stage.x + perspQuad[key].fx * stage.width;
      const ty = stage.y + perspQuad[key].fy * stage.height;
      await dragHandle(".crop-handle.qh-" + key, tx, ty);
    }
  }
  await page.getByText("指定範囲読取", { exact: true }).click();
  await assertResult("Perspective-Paddle-quad", "KX[-—_ ]?1234AB", "98765");
  const enginePersp = await page.evaluate(() => { const e = document.querySelector(".engine b"); return e ? e.textContent : ""; });
  if (!/PaddleOCR/.test(enginePersp)) return fail("Expected PaddleOCR engine for perspective quad path, got: " + enginePersp);
  const perspText = await page.evaluate(() => document.querySelector("textarea").value);
  log("Step 17b: perspective-corrected quad OCR via " + enginePersp + " matched. Recognized:\n  " + perspText.replace(/\n/g, "\\n"));

  if (cspViolations.length) return fail("CSP violation(s) occurred during perspective OCR.");
  const cspPersp = await page.evaluate(() => window.__csp || []);
  if (cspPersp.length) { cspViolations.push(...cspPersp); return fail("securitypolicyviolation events fired during perspective OCR."); }

  await page.getByText("キャンセル", { exact: true }).click();
  await page.waitForSelector(".card", { timeout: 8000 });

  // ---- Automatic deskew test ----
  // Rotate the standard label 12° onto a white background, feed it in, normal
  // 矩形 mode, expand rect to full, read. This must pass BECAUSE of the
  // automatic deskew (row-projection-variance estimator + canvas rotate):
  // with deskew disabled during development this same 12° crop returned an
  // empty/garbled result from the Paddle rec path (an 8° tilt still read on
  // its own, so 12° — the edge of the ±12° search range — is used to make the
  // test genuinely depend on the correction).
  async function generateRotatedLabelDataUrl(deg) {
    return await page.evaluate((deg) => {
      const lw = 700, lh = 240;
      const lc = document.createElement("canvas"); lc.width = lw; lc.height = lh;
      const lx = lc.getContext("2d");
      lx.fillStyle = "#fff"; lx.fillRect(0, 0, lw, lh);
      lx.fillStyle = "#000"; lx.font = "30px monospace"; lx.textBaseline = "top";
      lx.fillText("MODEL: KX-1234AB", 40, 60);
      lx.fillText("S/N 5X-98765", 40, 140);
      const rad = deg * Math.PI / 180;
      const cos = Math.abs(Math.cos(rad)), sin = Math.abs(Math.sin(rad));
      const nw = Math.ceil(lw * cos + lh * sin), nh = Math.ceil(lw * sin + lh * cos);
      const c = document.createElement("canvas"); c.width = nw; c.height = nh;
      const ctx = c.getContext("2d");
      ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, nw, nh);
      ctx.translate(nw / 2, nh / 2); ctx.rotate(rad); ctx.drawImage(lc, -lw / 2, -lh / 2);
      return c.toDataURL("image/png");
    }, deg);
  }
  const rotDataUrl = await generateRotatedLabelDataUrl(12);
  await injectDataUrlFile(rotDataUrl, "rot12-label.png");
  await page.waitForSelector(".crop-stage", { timeout: 10000 });
  log("Step 18: 12°-rotated label injected (矩形 mode; relies on automatic deskew).");
  const deskewCountBefore = deskewMsgs.length;
  await expandCropToFull();
  await page.getByText("指定範囲読取", { exact: true }).click();
  await assertResult("Deskew-Paddle-crop", "KX[-—_ ]?1234AB", "98765");
  const deskewText = await page.evaluate(() => document.querySelector("textarea").value);
  const chosenAngle = deskewMsgs.slice(deskewCountBefore).join(" | ") || "(none captured)";
  log("Step 18b: deskew test matched. Chosen deskew angle log(s): " + chosenAngle + "\n  Recognized: " + deskewText.replace(/\n/g, "\\n"));

  if (cspViolations.length) return fail("CSP violation(s) occurred during deskew OCR.");
  const cspDeskew = await page.evaluate(() => window.__csp || []);
  if (cspDeskew.length) { cspViolations.push(...cspDeskew); return fail("securitypolicyviolation events fired during deskew OCR."); }

  await page.getByText("キャンセル", { exact: true }).click();

  if (errors.length) return fail("JS errors were collected during the run.");
  if (cspViolations.length) return fail("CSP violations were collected during the run.");

  await browser.close();
  server.close();
  log("\n==================== VERIFY PASSED ====================");
  log(`No CSP violations, no JS errors. PaddleOCR eng (crop + DBNet full-image) + save + calendar + persistence all OK. Japanese-mode PaddleOCR (japan rec, ${variant} variant) OK.`);
  process.exit(0);
}

main().catch((e) => { console.error("verify.mjs crashed:", e); process.exit(1); });
