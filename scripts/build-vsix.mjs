/*
 * Copyright (c) 2026 Aergic Labs, LLC
 * SPDX-License-Identifier: AGPL-3.0-only
 */

/**
 * Build a vendor-specific VSIX.
 * Usage: node scripts/build-vsix.mjs --target=kiro|trae|windsurf
 *
 * Platform differentiation happens at build time via the __TARGET__ define
 * (tree-shaken by esbuild) and vendor/<target>/package.json merge. A single
 * .vscodeignore covers all targets.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { execSync } from "node:child_process";

const target = process.argv
  .find((a) => a.startsWith("--target="))
  ?.split("=")[1];
if (
  !target ||
  (target !== "kiro" &&
    target !== "trae" &&
    target !== "windsurf" &&
    target !== "devin")
) {
  console.error(
    "Usage: node scripts/build-vsix.mjs --target=kiro|trae|windsurf|devin",
  );
  process.exit(1);
}

const root = path.resolve(import.meta.dirname, "..");
const basePkgPath = path.join(root, "package.json");
const vendorPkgPath = path.join(root, "vendor", target, "package.json");
const bakPkgPath = path.join(root, "package.json.bak");

// Read version from package.json
const basePkg = JSON.parse(fs.readFileSync(basePkgPath, "utf-8"));
const version = basePkg.version;

// Remove any old VSIX for this target to ensure fresh build
const outFile = `artizo-${target}-${version}.vsix`;
const outPath = path.join(root, outFile);
// Also remove any older versioned VSIX files
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

// Merge vendor package.json over base
const vendorOverride = JSON.parse(fs.readFileSync(vendorPkgPath, "utf-8"));
const merged = { ...basePkg, ...vendorOverride };
delete merged.scripts;
delete merged.devDependencies;

try {
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

  console.log("Downloading busybox...");
  execSync("node scripts/download-busybox.mjs", {
    cwd: root,
    stdio: "inherit",
  });

  console.log(`Packaging ${outFile}...`);

  // Write merged package.json only for vsce, restore immediately
  fs.copyFileSync(basePkgPath, bakPkgPath);
  fs.writeFileSync(basePkgPath, JSON.stringify(merged, null, 2) + "\n");
  try {
    execSync(
      `npx vsce package --no-dependencies --allow-missing-repository --readme-path vendor/${target}/README.md -o ${outFile}`,
      {
        cwd: root,
        stdio: "inherit",
        env: { ...process.env, TARGET: target },
      },
    );
  } finally {
    fs.copyFileSync(bakPkgPath, basePkgPath);
    fs.unlinkSync(bakPkgPath);
  }

  console.log(`Done: ${outFile}`);
} catch (err) {
  console.error(err.message);
  process.exit(1);
}
