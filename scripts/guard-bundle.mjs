/*
 * Copyright (c) 2026 Aergic Labs, LLC
 * SPDX-License-Identifier: AGPL-3.0-only
 */

/**
 * Guard: a built target's bundle must contain no competitor identifiers.
 *
 * Runs after esbuild in build-vsix.mjs. The per-vendor VSIX is sold/shipped as
 * a standalone asset, so it must not leak any other vendor's name (e.g. the
 * Trae VSIX must not contain "kiro" anywhere, case-insensitive). Isolation is
 * achieved by dynamic-import tree-shaking; this guard enforces it so a stray
 * string or comment in a shared file (which esbuild keeps, since minify is off)
 * can't regress the guarantee silently.
 *
 * Devin keeps "windsurf": its IDE is the rebranded Windsurf binary and its
 * download URLs / product.json keys legitimately reference it.
 */

import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import path from "node:path";

/** Forbidden substrings per build target (case-insensitive). */
export const FORBIDDEN_TERMS = {
  kiro: ["trae", "icube", "devin", "windsurf"],
  trae: ["kiro", "devin", "windsurf"],
  devin: ["kiro", "trae", "icube"],
};

/**
 * Return the list of forbidden terms found in `text`, each with an occurrence
 * count and a short context snippet. Pure function — unit tested.
 *
 * A term matches only at a *token start* (negative lookbehind for a letter), so
 * distinctive brand strings are caught even when embedded in a larger
 * identifier (e.g. "kiro" in "kiroAgent"), while innocent substrings are not
 * (e.g. "trae" inside "reportExtraError"). Matching is case-insensitive.
 */
export function findForbidden(text, terms) {
  const hits = [];
  for (const term of terms) {
    const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(`(?<![a-z])${escaped}`, "gi");
    let count = 0;
    let firstIdx = -1;
    let m;
    while ((m = re.exec(text)) !== null) {
      count++;
      if (firstIdx < 0) firstIdx = m.index;
    }
    if (count > 0) {
      hits.push({
        term,
        count,
        snippet: text.slice(Math.max(0, firstIdx - 30), firstIdx + term.length + 30),
      });
    }
  }
  return hits;
}

/** Recursively collect text files under a directory. */
function collectTextFiles(dir, exts, acc = []) {
  if (!existsSync(dir)) return acc;
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) collectTextFiles(full, exts, acc);
    else if (exts.some((e) => entry.endsWith(e))) acc.push(full);
  }
  return acc;
}

/**
 * Scan all shipped text artifacts for a target. Returns a list of
 * { file, hits } for any file containing forbidden terms.
 */
export function scanTarget(root, target) {
  const terms = FORBIDDEN_TERMS[target];
  if (!terms) throw new Error(`guard-bundle: unknown target "${target}"`);

  const files = [
    path.join(root, "dist", "extension.js"),
    ...collectTextFiles(path.join(root, "src", "webview"), [
      ".js",
      ".html",
      ".css",
      ".md",
    ]),
  ];

  const findings = [];
  for (const file of files) {
    if (!existsSync(file)) continue;
    const hits = findForbidden(readFileSync(file, "utf-8"), terms);
    if (hits.length > 0) findings.push({ file, hits });
  }
  return findings;
}

// ── CLI ──────────────────────────────────────────────────────
const invokedDirectly =
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.dirname, "guard-bundle.mjs");

if (invokedDirectly) {
  const target =
    process.env.TARGET ||
    process.argv.find((a) => a.startsWith("--target="))?.split("=")[1];
  const root = path.resolve(import.meta.dirname, "..");

  // This is a build-time guard: it needs a TARGET and a built bundle. When run
  // without a target (e.g. as part of `npm run lint`), skip rather than fail.
  if (!target) {
    console.log("guard-bundle: no TARGET set — skipping (build-time guard).");
    process.exit(0);
  }
  if (!FORBIDDEN_TERMS[target]) {
    console.error(
      `guard-bundle: unknown target "${target}" (expected kiro|trae|devin)`,
    );
    process.exit(1);
  }

  const distBundle = path.join(root, "dist", "extension.js");
  if (!existsSync(distBundle)) {
    console.error("guard-bundle: dist/extension.js not found — build first");
    process.exit(1);
  }

  const findings = scanTarget(root, target);
  if (findings.length > 0) {
    console.error(
      `guard-bundle: FORBIDDEN competitor strings found in the "${target}" build:`,
    );
    for (const { file, hits } of findings) {
      for (const { term, count, snippet } of hits) {
        console.error(
          `  ${file}: "${term}" ×${count}  …${snippet.replace(/\s+/g, " ")}…`,
        );
      }
    }
    process.exit(1);
  }

  console.log(`guard-bundle: ${target} bundle clean (no competitor strings).`);
}
