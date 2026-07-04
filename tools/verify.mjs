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
const VER = { vue: "3.4.38", tess: "5.1.1", core: "5.1.1", eng: "1.0.0", jpn: "1.0.0" };
const CACHE_FILES = {
  "vue.runtime.global.prod.js": join(cacheDir, "vue", "vue.runtime.global.prod.js"),
  "tesseract.min.js": join(cacheDir, "tesseract.js", "dist", "tesseract.min.js"),
  "worker.min.js": join(cacheDir, "tesseract.js", "dist", "worker.min.js"),
  "tesseract-core-simd-lstm.wasm.js": join(cacheDir, "tesseract.js-core", "tesseract-core-simd-lstm.wasm.js"),
  "tesseract-core.wasm.js": join(cacheDir, "tesseract.js-core", "tesseract-core.wasm.js"),
  "tesseract-core-simd.wasm.js": join(cacheDir, "tesseract.js-core", "tesseract-core-simd.wasm.js"),
  "tesseract-core-lstm.wasm.js": join(cacheDir, "tesseract.js-core", "tesseract-core-lstm.wasm.js"),
  "eng.traineddata.gz": join(cacheDir, "eng", "eng.traineddata.gz"),
  "jpn.traineddata.gz": join(cacheDir, "jpn", "jpn.traineddata.gz")
};

function log(...a) { console.log(...a); }

// Does this container have a CJK-capable font installed? If not, canvas-rendered
// Japanese glyphs would come out as tofu boxes and OCR-ing them proves nothing.
// In that case we fall back to an ASCII-only image in jpn mode, which still
// proves the jpn worker/traineddata pipeline works end-to-end.
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
  grab("tess", `https://registry.npmjs.org/tesseract.js/-/tesseract.js-${VER.tess}.tgz`);
  grab("core", `https://registry.npmjs.org/tesseract.js-core/-/tesseract.js-core-${VER.core}.tgz`);
  grab("eng", `https://registry.npmjs.org/@tesseract.js-data/eng/-/eng-${VER.eng}.tgz`);
  grab("jpn", `https://registry.npmjs.org/@tesseract.js-data/jpn/-/jpn-${VER.jpn}.tgz`);

  mkdirSync(join(cacheDir, "vue"), { recursive: true });
  mkdirSync(join(cacheDir, "tesseract.js", "dist"), { recursive: true });
  mkdirSync(join(cacheDir, "tesseract.js-core"), { recursive: true });
  mkdirSync(join(cacheDir, "eng"), { recursive: true });
  mkdirSync(join(cacheDir, "jpn"), { recursive: true });
  copyFileSync(join(tmp, "vue", "package", "dist", "vue.runtime.global.prod.js"), CACHE_FILES["vue.runtime.global.prod.js"]);
  copyFileSync(join(tmp, "tess", "package", "dist", "tesseract.min.js"), CACHE_FILES["tesseract.min.js"]);
  copyFileSync(join(tmp, "tess", "package", "dist", "worker.min.js"), CACHE_FILES["worker.min.js"]);
  for (const f of ["tesseract-core-simd-lstm.wasm.js", "tesseract-core.wasm.js", "tesseract-core-simd.wasm.js", "tesseract-core-lstm.wasm.js"]) {
    copyFileSync(join(tmp, "core", "package", f), CACHE_FILES[f]);
  }
  copyFileSync(join(tmp, "eng", "package", "4.0.0_best_int", "eng.traineddata.gz"), CACHE_FILES["eng.traineddata.gz"]);
  copyFileSync(join(tmp, "jpn", "package", "4.0.0_best_int", "jpn.traineddata.gz"), CACHE_FILES["jpn.traineddata.gz"]);
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

  // Intercept jsdelivr; fulfill from the local cache.
  await context.route("https://cdn.jsdelivr.net/**", async (route) => {
    const url = new URL(route.request().url());
    const name = basename(url.pathname);
    const local = CACHE_FILES[name];
    if (local && existsSync(local)) {
      const isGz = name.endsWith(".gz");
      await route.fulfill({
        status: 200,
        contentType: isGz ? "application/octet-stream" : "text/javascript; charset=utf-8",
        body: readFileSync(local)
      });
    } else {
      unmappedCdn.push(url.pathname);
      await route.abort();
    }
  });

  const page = await context.newPage();
  page.on("console", (m) => {
    const t = m.text();
    if (/content security policy|refused to (load|execute|connect|apply)/i.test(t)) cspViolations.push(t);
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

  log(`\nServing ${repoRoot} at ${base}`);
  await page.goto(base + "/index.html", { waitUntil: "load" });
  await page.waitForSelector("header h1", { timeout: 10000 });
  log("Step 1: page loaded, Vue mounted (render functions, no template compiler).");

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
  log("Step 2: label image injected, OCR running...");

  try {
    await page.waitForSelector("textarea", { timeout: 120000 });
    await page.waitForFunction(() => {
      const ta = document.querySelector("textarea");
      return ta && /KX[-—_ ]?1234AB/i.test(ta.value) && /98765/.test(ta.value);
    }, { timeout: 120000 });
  } catch (e) {
    const ta = await page.evaluate(() => { const t = document.querySelector("textarea"); return t ? t.value : "(no textarea)"; });
    return fail("OCR text assertion failed. textarea value was:\n" + ta);
  }
  const recognized = await page.evaluate(() => document.querySelector("textarea").value);
  log("Step 3: OCR text matched /KX-?1234AB/ and /98765/. Recognized:\n  " + recognized.replace(/\n/g, "\\n"));

  if (cspViolations.length) return fail("CSP violation(s) occurred during OCR.");
  const cspFromPage = await page.evaluate(() => window.__csp || []);
  if (cspFromPage.length) { cspViolations.push(...cspFromPage); return fail("securitypolicyviolation events fired."); }

  // Save the record.
  await page.getByText("保存する", { exact: true }).click();
  await page.waitForFunction(() => document.querySelector("header .nav button.active") &&
    document.querySelector("header .nav button.active").textContent.includes("一覧"), { timeout: 8000 });

  const now = new Date();
  const pad = (n) => (n < 10 ? "0" + n : "" + n);
  const todayHdrDay = now.getFullYear() + "年" + (now.getMonth() + 1) + "月" + now.getDate() + "日";

  const listOk = await page.evaluate((hdrDay) => {
    const hdrs = [...document.querySelectorAll(".datehdr")].map((e) => e.textContent);
    const hasToday = hdrs.some((h) => h.startsWith(hdrDay));
    const recText = [...document.querySelectorAll(".rec .txt")].map((e) => e.textContent).join("\n");
    const badge = !!document.querySelector(".calcell.has .caldot");
    return { hasToday, hasText: /KX/i.test(recText) && /98765/.test(recText), badge };
  }, todayHdrDay);
  if (!listOk.hasToday) return fail("Saved record not shown under today's date header (" + todayHdrDay + ").");
  if (!listOk.hasText) return fail("Saved record text not found in list.");
  if (!listOk.badge) return fail("Calendar badge (.caldot) not shown for a day with records.");
  log("Step 4: record listed under today (" + todayHdrDay + ") and calendar shows a badge.");

  // Reload -> persistence.
  await page.reload({ waitUntil: "load" });
  await page.waitForSelector("header h1", { timeout: 10000 });
  await page.getByText("一覧", { exact: true }).click();
  await page.waitForSelector(".rec .txt", { timeout: 8000 });
  const persisted = await page.evaluate(() =>
    [...document.querySelectorAll(".rec .txt")].some((e) => /KX/i.test(e.textContent) && /98765/.test(e.textContent)));
  if (!persisted) return fail("Record did not persist across reload (IndexedDB).");
  log("Step 5: record persisted across reload (IndexedDB).");

  // ---- Japanese OCR mode ----
  const cjkFamily = detectCjkFont();
  log(cjkFamily
    ? `CJK font detected on this system: "${cjkFamily}" -> running CJK-glyph variant.`
    : "No CJK font detected (fc-list has no cjk/noto-jp match) -> running ASCII-in-jpn-mode variant.");

  await page.getByText("撮影", { exact: true }).click();
  await page.waitForSelector(".card", { timeout: 8000 });

  await page.getByText("日本語+英数字", { exact: true }).click();
  await page.waitForFunction(() => {
    const btns = [...document.querySelectorAll(".nav button")];
    const jpnBtn = btns.find((b) => b.textContent.includes("日本語"));
    return !!jpnBtn && jpnBtn.classList.contains("active");
  }, { timeout: 5000 });
  log("Step 6: switched capture view to 日本語+英数字 mode.");

  const hintShown = await page.evaluate(() =>
    [...document.querySelectorAll(".hint")].some((h) => /日本語/.test(h.textContent) && /MB/i.test(h.textContent)));
  if (!hintShown) return fail("Japanese-mode first-download size hint (.hint, mentions MB) not shown.");
  log("Step 7: first-download size hint shown for jpn mode.");

  const variant = cjkFamily ? "cjk" : "ascii";
  await page.evaluate(({ variant, cjkFamily }) => {
    const c = document.createElement("canvas");
    c.width = 700; c.height = 220;
    const x = c.getContext("2d");
    x.fillStyle = "#fff"; x.fillRect(0, 0, c.width, c.height);
    x.fillStyle = "#000"; x.textBaseline = "top";
    if (variant === "cjk") {
      x.font = `32px "${cjkFamily}"`;
      x.fillText("型番 KX-1234", 30, 60);
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
  log(`Step 8: jpn-mode ${variant === "cjk" ? "CJK label (型番 KX-1234)" : "ASCII label (MODEL KX-9876 / TYPE JP-TEST)"} image injected, OCR running (variant: ${variant})...`);

  try {
    await page.waitForSelector("textarea", { timeout: 150000 });
    await page.waitForFunction((v) => {
      const ta = document.querySelector("textarea");
      if (!ta) return false;
      const t = ta.value;
      if (v === "cjk") {
        return /KX/i.test(t) && /1234/.test(t) && /[぀-ヿ㐀-䶿一-鿿]/.test(t);
      }
      return /KX/i.test(t) && /9876/.test(t);
    }, variant, { timeout: 150000 });
  } catch (e) {
    const ta = await page.evaluate(() => { const t = document.querySelector("textarea"); return t ? t.value : "(no textarea)"; });
    return fail("Japanese-mode OCR text assertion failed (variant: " + variant + "). textarea value was:\n" + ta);
  }
  const jpnRecognized = await page.evaluate(() => document.querySelector("textarea").value);
  log(`Step 9: jpn-mode OCR succeeded (${variant} variant). Recognized:\n  ` + jpnRecognized.replace(/\n/g, "\\n"));

  if (cspViolations.length) return fail("CSP violation(s) occurred during Japanese-mode OCR.");
  const cspFromPage2 = await page.evaluate(() => window.__csp || []);
  if (cspFromPage2.length) { cspViolations.push(...cspFromPage2); return fail("securitypolicyviolation events fired during Japanese-mode OCR."); }

  await page.getByText("破棄", { exact: true }).click();

  if (errors.length) return fail("JS errors were collected during the run.");
  if (cspViolations.length) return fail("CSP violations were collected during the run.");

  await browser.close();
  server.close();
  log("\n==================== VERIFY PASSED ====================");
  log(`No CSP violations, no JS errors. OCR (eng) + save + calendar + persistence all OK. Japanese mode OCR (${variant} variant) OK.`);
  process.exit(0);
}

main().catch((e) => { console.error("verify.mjs crashed:", e); process.exit(1); });
