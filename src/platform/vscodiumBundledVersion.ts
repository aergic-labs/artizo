/*
 * Copyright (c) 2026 Aergic Labs, LLC
 * SPDX-License-Identifier: AGPL-3.0-only
 */

/**
 * Artizo-local helper: read the newest version from the bundled
 * tools/vscodium/versions.json (sorted descending, so [0] is the
 * highest). Used as the fallback for the REH download URL when
 * product.json has no version (e.g., unrecognized IDE on the vscodium
 * VSIX) so the URL points at a tarball that exists instead of 404ing
 * on "0.0.0".
 *
 * Lives here, not in the shared `src/remote/vscodiumFeed.ts`, because
 * zygos never consumes it. Keeping it in the shared file made it dead
 * code from zygos's perspective, so any knip-driven cleanup in zygos
 * would delete it and `make sync-shared` would then strip it from
 * artizo, breaking the platform adapter.
 */

import * as fs from "node:fs";

let bundledPath: string | undefined;

/** Initialize with the bundled versions.json path. Called once from activate(). */
export function initVscodiumBundledVersion(opts: {
  bundledPath: string;
}): void {
  bundledPath = opts.bundledPath;
}

/** Return the highest version in the bundled list, or undefined. */
export function getNewestBundledVersion(): string | undefined {
  if (!bundledPath) return undefined;
  try {
    const arr = JSON.parse(fs.readFileSync(bundledPath, "utf-8"));
    if (Array.isArray(arr) && typeof arr[0] === "string") {
      return arr[0];
    }
  } catch {
    // Bundled file missing or corrupt.
  }
  return undefined;
}
