import * as esbuild from "esbuild";
import * as fs from "node:fs";
import * as path from "node:path";

const isWatch = process.argv.includes("--watch");
const target = process.env.TARGET || "kiro";

// Per-vendor feature flags; vendor names never ship in VSIX
const isTraeFamily = target === "trae";
const flags = {
  HAS_SECCOMP_UNCONFINED: isTraeFamily,
  HAS_HOME_SYMLINK: target === "devin",
  HAS_ARGV_PATCH: !isTraeFamily,
  HAS_KIRO_ADAPTER: target === "kiro",
  HAS_TRAE_ADAPTER: isTraeFamily,
  HAS_DEVIN_ADAPTER: target === "devin",
  HAS_VSCODIUM_ADAPTER: target === "vscodium",
};

/** @type {esbuild.BuildOptions} */
const buildOptions = {
  entryPoints: ["src/extension.ts"],
  bundle: true,
  outfile: "dist/extension.js",
  external: ["vscode"],
  format: "cjs",
  platform: "node",
  target: "node18",
  sourcemap: true,
  minify: false,
  minifySyntax: true,
  treeShaking: true,
  metafile: true,
  mainFields: ["module", "main"],
  banner: {
    js: `/*
 * Copyright (c) 2026 Aergic Labs, LLC
 * SPDX-License-Identifier: AGPL-3.0-only
 */`,
  },
  define: {
    __TARGET__: JSON.stringify(target),
    ...Object.fromEntries(
      Object.entries(flags).map(([k, v]) => [k, JSON.stringify(v)]),
    ),
  },
  // Resolve vscode-uri from local node_modules (not vendored CLI's)
  alias: {
    "vscode-uri": path.resolve("node_modules/vscode-uri"),
    "node-pty": path.resolve("stubs/node-pty.js"),
  },
};

/**
 * Build options for the standalone remote argv.json patch script. Bundled
 * to a single self-contained CJS file (jsonc-parser inlined) that the apex
 * pushes over ssh stdin to `node -` on the SSH remote. Minified + no legal
 * comments to keep the pushed payload small (~17KB).
 */
/** @type {esbuild.BuildOptions} */
const remotePatchOptions = {
  entryPoints: ["src/remote/argvPatchRemoteMain.ts"],
  bundle: true,
  outfile: "dist/argv-patch-remote.cjs",
  format: "cjs",
  platform: "node",
  target: "node18",
  minify: true,
  legalComments: "none",
  treeShaking: true,
  // Prefer jsonc-parser's ESM build; the UMD build uses dynamic relative
  // requires that esbuild can't statically bundle.
  mainFields: ["module", "main"],
  banner: {
    js: `/*
 * Copyright (c) 2026 Aergic Labs, LLC
 * SPDX-License-Identifier: AGPL-3.0-only
 */`,
  },
};

/**
 * Recursively copy a directory from src to dest.
 */
function copyDirSync(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDirSync(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

async function main() {
  if (isWatch) {
    const ctx = await esbuild.context(buildOptions);
    const remoteCtx = await esbuild.context(remotePatchOptions);
    await ctx.watch();
    await remoteCtx.watch();
    console.log("Watching for changes...");
  } else {
    const result = await esbuild.build(buildOptions);
    await esbuild.build(remotePatchOptions);

    // Report bundle size
    if (result.metafile) {
      const output = result.metafile.outputs["dist/extension.js"];
      if (output) {
        const sizeKB = (output.bytes / 1024).toFixed(1);
        console.log(`Bundle size: ${sizeKB} KB`);
        console.log(`Inputs: ${Object.keys(output.inputs).length} modules`);
      }

      // Write metafile for analysis (gitignored)
      fs.writeFileSync(
        "dist/meta.json",
        JSON.stringify(result.metafile, null, 2),
      );
    }

    console.log("Build complete.");
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
