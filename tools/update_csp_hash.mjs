#!/usr/bin/env node
// Recompute the sha256 hashes of the inline <script> and <style> blocks in
// index.html and rewrite the matching 'sha256-...' tokens in the CSP meta tag.
// Plain Node, no dependencies. Run after every edit to index.html.
//
//   node tools/update_csp_hash.mjs [path/to/index.html]

import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const file = resolve(process.argv[2] || resolve(here, "..", "index.html"));

let html = readFileSync(file, "utf8");

function sha256b64(str) {
  return "sha256-" + createHash("sha256").update(str, "utf8").digest("base64");
}

// Grab the *inline* script (the one with no attributes) and the style block.
// The exact bytes between the tags are what the browser hashes.
const scriptMatch = html.match(/<script>([\s\S]*?)<\/script>/);
const styleMatch = html.match(/<style>([\s\S]*?)<\/style>/);
if (!scriptMatch) throw new Error("No inline <script> (attribute-less) found in " + file);
if (!styleMatch) throw new Error("No <style> block found in " + file);

const scriptHash = sha256b64(scriptMatch[1]);
const styleHash = sha256b64(styleMatch[1]);

// Rewrite the first sha256 token inside script-src and style-src respectively.
function replaceHashInDirective(cspContent, directive, newHash) {
  const re = new RegExp("(" + directive + "\\s+)'sha256-[^']*'");
  if (!re.test(cspContent)) {
    throw new Error("Could not find a 'sha256-...' token in the " + directive + " directive");
  }
  return cspContent.replace(re, `$1'${newHash}'`);
}

const cspRe = /(<meta http-equiv="Content-Security-Policy" content=")([^"]*)(">)/;
const cspM = html.match(cspRe);
if (!cspM) throw new Error("CSP meta tag not found in " + file);

let csp = cspM[2];
csp = replaceHashInDirective(csp, "script-src", scriptHash);
csp = replaceHashInDirective(csp, "style-src", styleHash);

const updated = html.replace(cspRe, `$1${csp}$3`);
if (updated !== html) {
  writeFileSync(file, updated);
}

console.log("index.html :", file);
console.log("script-src :", `'${scriptHash}'`);
console.log("style-src  :", `'${styleHash}'`);
console.log(updated !== html ? "CSP meta updated." : "CSP meta already up to date.");
