/*
 * Copyright (c) 2026 Aergic Labs, LLC
 * SPDX-License-Identifier: AGPL-3.0-only
 */

/**
 * Build a vendor-specific VSIX.
 * Usage: node scripts/build-vsix.mjs --target=kiro|trae|devin
 *
 * Builds the esbuild bundle in the working tree, then assembles the VSIX in a
 * temp directory so the working tree's package.json is never mutated.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { execSync } from "node:child_process";

const target = process.argv
  .find((a) => a.startsWith("--target="))
  ?.split("=")[1];
if (!target || (target !== "kiro" && target !== "trae" && target !== "devin")) {
  console.error("Usage: node scripts/build-vsix.mjs --target=kiro|trae|devin");
  process.exit(1);
}

const root = path.resolve(import.meta.dirname, "..");
const basePkgPath = path.join(root, "package.json");
const vendorDir = path.join(root, "vendor", target);
const vendorPkgPath = path.join(vendorDir, "package.json");
const templatePath = path.join(root, "vendor", "README.template.md");

// Read version from package.json
const basePkg = JSON.parse(fs.readFileSync(basePkgPath, "utf-8"));
const version = basePkg.version;

// Remove any old VSIX for this target
const outFile = `artizo-${target}-${version}.vsix`;
const outPath = path.join(root, outFile);
for (const f of fs.readdirSync(root)) {
  if (
    f.startsWith(`artizo-${target}-`) &&
    f.endsWith(".vsix") &&
    f !== outFile
  ) {
    fs.unlinkSync(path.join(root, f));
    console.log(`Removed old ${f}`);
  }
}
if (fs.existsSync(outPath)) {
  fs.unlinkSync(outPath);
  console.log(`Removed old ${outFile}`);
}

try {
  // ── Build steps (in working tree) ──────────────────────────

  // Clean stale bundles from previous builds
  const distDir = path.join(root, "dist");
  for (const f of fs.readdirSync(distDir)) {
    if (f.startsWith("extension-") && f.endsWith(".js")) {
      fs.unlinkSync(path.join(distDir, f));
    }
  }

  // Strip CR from scripts that must have LF endings for Unix containers
  for (const f of ["tools/setup.sh", "tools/relay.js"]) {
    const fp = path.join(root, f);
    if (fs.existsSync(fp)) {
      let content = fs.readFileSync(fp, "utf-8");
      if (content.includes("\r")) {
        content = content.replace(/\r/g, "");
        fs.writeFileSync(fp, content, "utf-8");
        console.log(`  Normalized ${f} to LF`);
      }
    }
  }

  console.log(`Building for ${target}...`);
  execSync("node esbuild.config.mjs", {
    cwd: root,
    stdio: "inherit",
    env: { ...process.env, TARGET: target },
  });

  console.log("Guarding bundle for competitor strings...");
  execSync(`node scripts/guard-bundle.mjs --target=${target}`, {
    cwd: root,
    stdio: "inherit",
    env: { ...process.env, TARGET: target },
  });

  console.log("Downloading busybox...");
  execSync("node scripts/download-busybox.mjs", {
    cwd: root,
    stdio: "inherit",
  });

  // ── Assemble in temp directory ──────────────────────────────

  const stageDir = fs.mkdtempSync(path.join(os.tmpdir(), "artizo-pack-"));
  console.log(`Packaging in ${stageDir}...`);

  // Merge vendor package.json over base
  const vendorOverride = JSON.parse(fs.readFileSync(vendorPkgPath, "utf-8"));
  const merged = { ...basePkg, ...vendorOverride };
  delete merged.scripts;
  delete merged.devDependencies;

  // Generate vendor README from template
  const vendorPkg = JSON.parse(fs.readFileSync(vendorPkgPath, "utf-8"));
  const platform = vendorPkg.platform;
  let readme = fs.readFileSync(templatePath, "utf-8");
  readme = readme.replace(/\{\{NAME\}\}/g, platform.name);
  readme = readme.replace(
    /\{\{URL\}\}/g,
    platform.name === "Kiro"
      ? "https://kiro.dev"
      : platform.name === "Trae"
        ? "https://trae.ai"
        : "https://devin.ai",
  );

  // Copy project files, skipping dirs that .vscodeignore would exclude anyway
  // and skipping node_modules (huge, not packaged).
  const SKIP = new Set([
    "node_modules",
    "vendor",
    ".git",
    "plans",
    "coverage",
    "dist/meta.json",
  ]);
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const name = entry.name;
    if (SKIP.has(name)) continue;
    if (name.startsWith("package.json.bak") || name.endsWith(".vsix")) continue;
    const src = path.join(root, name);
    const dest = path.join(stageDir, name);
    if (entry.isDirectory()) {
      fs.cpSync(src, dest, { recursive: true });
    } else {
      fs.copyFileSync(src, dest);
    }
  }

  // Write vendor README after copy so it replaces any root README.md that was copied
  fs.writeFileSync(path.join(stageDir, "readme.md"), readme);

  // Write merged package.json after copy so it replaces the root one
  fs.writeFileSync(
    path.join(stageDir, "package.json"),
    JSON.stringify(merged, null, 2) + "\n",
  );

  // Clean up stale meta.json that may have been copied
  const metaPath = path.join(stageDir, "dist", "meta.json");
  if (fs.existsSync(metaPath)) fs.unlinkSync(metaPath);

  // Also clean any source maps
  for (const f of fs
    .readdirSync(path.join(stageDir, "dist"))
    .filter((f) => f.endsWith(".map"))) {
    fs.unlinkSync(path.join(stageDir, "dist", f));
  }

  // ── Package ─────────────────────────────────────────────────
  execSync(
    `npx vsce package --no-dependencies --allow-missing-repository -o ${outPath}`,
    {
      cwd: stageDir,
      stdio: "inherit",
    },
  );

  console.log(`Done: ${outFile}`);

  // ── Cleanup ─────────────────────────────────────────────────
  fs.rmSync(stageDir, { recursive: true, force: true });
} catch (err) {
  console.error(err.message);
  process.exit(1);
}
