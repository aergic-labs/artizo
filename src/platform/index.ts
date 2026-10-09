/*
 * Copyright (c) 2026 Aergic Labs, LLC
 * SPDX-License-Identifier: AGPL-3.0-only
 */

/**
 * Platform adapter factory.
 *
 * Selects the correct IPlatformAdapter at runtime by reading `product.json`
 * `applicationName`. All four adapter modules are bundled in every VSIX;
 * the factory picks one at first call and caches it. Detection order is
 * most-specific first, with VSCodium as the catch-all fallback so the
 * extension always works on unrecognized IDEs (best-effort defaults).
 */

import * as vscode from "vscode";
import * as path from "node:path";
import { readFileSync } from "node:fs";
import type { IPlatformAdapter } from "./types";

let _adapter: IPlatformAdapter | undefined;

/** @internal Test-only reset of the cached adapter. */
export function _resetForTest(): void {
  _adapter = undefined;
}

/** IDE names returned by detectPlatformName(). */
export type PlatformName = "Devin" | "Trae" | "Kiro" | "VSCodium";

/**
 * Read `product.json` `applicationName` from the running IDE and match
 * it against known fork identifiers. Returns VSCodium for unrecognized
 * IDEs (the catch-all fallback per the runtime detection plan).
 */
export function detectPlatformName(): PlatformName {
  try {
    const productPath = path.join(vscode.env.appRoot, "product.json");
    const product = JSON.parse(readFileSync(productPath, "utf-8"));
    const appName: string = (product?.applicationName ?? "").toLowerCase();
    if (appName.includes("devin") || appName.includes("windsurf")) {
      return "Devin";
    }
    if (appName.includes("trae") || appName.includes("byte")) {
      return "Trae";
    }
    if (appName.includes("kiro")) {
      return "Kiro";
    }
  } catch {
    // product.json unreadable — fall through to VSCodium.
  }
  return "VSCodium";
}

/**
 * Returns the platform adapter for the running IDE. Detected at runtime
 * via `product.json`; cached after first call.
 */
export async function getPlatformAdapter(): Promise<IPlatformAdapter> {
  if (!_adapter) {
    const platform = detectPlatformName();
    if (platform === "Trae") {
      const { TraeAdapter } = await import("./trae.js");
      _adapter = new TraeAdapter({
        name: "Trae",
        dataFolderName: ".trae",
        serverApplicationName: "trae-server",
        needsArgvPatch: false,
        additionalDockerRunArgs: ["--security-opt", "seccomp=unconfined"],
      });
    } else if (platform === "Devin") {
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
    } else if (platform === "Kiro") {
      const { KiroAdapter } = await import("./kiro.js");
      _adapter = new KiroAdapter({
        name: "Kiro",
        dataFolderName: ".kiro",
        serverApplicationName: "kiro-server",
        needsArgvPatch: true,
        additionalDockerRunArgs: [],
      });
    } else {
      const { VSCodiumAdapter } = await import("./vscodium.js");
      _adapter = new VSCodiumAdapter({
        name: "VSCodium",
        dataFolderName: ".vscode-oss",
        serverApplicationName: "codium-server",
        needsArgvPatch: true,
        additionalDockerRunArgs: [],
        serverInstallRoot: "/tmp",
        needsHomeSymlink: false,
      });
    }
  }
  return _adapter!;
}

export type { IPlatformAdapter } from "./types";
