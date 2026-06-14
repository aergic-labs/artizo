import * as esbuild from "esbuild";
import * as fs from "node:fs";
import * as path from "node:path";

const isWatch = process.argv.includes("--watch");
const target = process.env.TARGET || "kiro";

// Per-vendor feature flags; vendor names never ship in VSIX
const flags = {
  HAS_SECCOMP_UNCONFINED: target === "trae",
  HAS_HOME_SYMLINK: target === "devin",
  HAS_ARGV_PATCH: target !== "trae",
  HAS_KIRO_ADAPTER: target === "kiro",
  HAS_TRAE_ADAPTER: target === "trae",
  HAS_DEVIN_ADAPTER: target === "devin",
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

/**
 * Copy @devcontainers/cli distribution files to the output directory.
 *
 * The CLI is built from the vendored source with:
 *   cd vendor/devcontainers-cli && npm install && npm run compile-prod
 *
 * Only the files needed by templates.ts (which spawns the CLI as a
 * child process) are copied. The main API path (api.ts) imports vendored
 * source directly; esbuild handles that bundling.
 */
function copyDevcontainersCli() {
  const cliSource = path.resolve("vendor", "devcontainers-cli");
  const cliEntry = path.join(
    cliSource,
    "dist",
    "spec-node",
    "devContainersSpecCLI.js",
  );

  if (!fs.existsSync(cliEntry)) {
    console.error(
      "Vendored CLI not built. Run: cd vendor/devcontainers-cli && npm install && npm run compile-prod",
    );
    process.exit(1);
  }

  const cliDest = path.resolve("dist", "node_modules", "@devcontainers", "cli");
  // Clean previous build to avoid stale files
  fs.rmSync(cliDest, { recursive: true, force: true });
  fs.mkdirSync(path.join(cliDest, "dist", "spec-node"), { recursive: true });

  // CLI entry point
  fs.copyFileSync(
    path.join(cliSource, "devcontainer.js"),
    path.join(cliDest, "devcontainer.js"),
  );
  // Package metadata (for dependency resolution if spawned)
  fs.copyFileSync(
    path.join(cliSource, "package.json"),
    path.join(cliDest, "package.json"),
  );
  // Compiled CLI (spawned by templates.ts)
  fs.copyFileSync(
    path.join(cliSource, "dist", "spec-node", "devContainersSpecCLI.js"),
    path.join(cliDest, "dist", "spec-node", "devContainersSpecCLI.js"),
  );
  // Dockerfile used by the CLI for UID updates
  const scriptsSource = path.join(cliSource, "scripts");
  const scriptsDest = path.join(cliDest, "scripts");
  fs.mkdirSync(scriptsDest, { recursive: true });
  fs.copyFileSync(
    path.join(scriptsSource, "updateUID.Dockerfile"),
    path.join(scriptsDest, "updateUID.Dockerfile"),
  );
}

async function main() {
  if (isWatch) {
    const ctx = await esbuild.context(buildOptions);
    await ctx.watch();
    copyDevcontainersCli();
    console.log("Watching for changes...");
  } else {
    const result = await esbuild.build(buildOptions);
    copyDevcontainersCli();

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
