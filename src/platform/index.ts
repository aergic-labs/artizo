/*
 * Copyright (c) 2026 Aergic Labs, LLC
 * SPDX-License-Identifier: AGPL-3.0-only
 */

/**
 * Platform adapter factory.
 *
 * Selects the correct IPlatformAdapter at build time via dynamic imports
 * gated by HAS_*_ADAPTER flags. esbuild eliminates unused branches; only
 * one adapter module ships per vendor VSIX. No competitor names or code
 * survive in non-target builds.
 */

import type { IPlatformAdapter, PlatformConfig } from "./types";

let _adapter: IPlatformAdapter | undefined;

declare const HAS_KIRO_ADAPTER: boolean;
declare const HAS_TRAE_ADAPTER: boolean;
declare const HAS_DEVIN_ADAPTER: boolean;

/**
 * Returns the platform adapter for the current build target.
 * Cached after first call.
 */
export async function getPlatformAdapter(): Promise<IPlatformAdapter> {
  if (!_adapter) {
    if (HAS_TRAE_ADAPTER) {
      const { TraeAdapter } = await import("./trae.js");
      _adapter = new TraeAdapter({
        name: "Trae",
        dataFolderName: ".trae",
        serverApplicationName: "trae-server",
        needsArgvPatch: false,
        additionalDockerRunArgs: ["--security-opt", "seccomp=unconfined"],
      });
    } else if (HAS_DEVIN_ADAPTER) {
      const { DevinAdapter } = await import("./devin.js");
      _adapter = new DevinAdapter({
        name: "Devin",
        dataFolderName: ".devin-server",
        serverApplicationName: "devin-server",
        needsArgvPatch: true,
        additionalDockerRunArgs: [],
        serverInstallRoot: "/tmp",
        needsHomeSymlink: true,
        hostDataFolderName: ".devin",
      });
    } else {
      const { KiroAdapter } = await import("./kiro.js");
      _adapter = new KiroAdapter({
        name: "Kiro",
        dataFolderName: ".kiro",
        serverApplicationName: "kiro-server",
        needsArgvPatch: true,
        additionalDockerRunArgs: [],
      });
    }
  }
  return _adapter!;
}

export type { IPlatformAdapter, PlatformConfig };
