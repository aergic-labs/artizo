/*
 * Copyright (c) 2026 Aergic Labs, LLC
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import * as os from "node:os";
import * as path from "node:path";
import type { IPlatformAdapter, PlatformConfig } from "./types";

const VSCodium_REH_BASE =
  "https://github.com/VSCodium/vscodium/releases/download";

export class VSCodiumAdapter implements IPlatformAdapter {
  readonly name: string;
  readonly dataFolderName: string;
  readonly serverApplicationName: string;
  private readonly config: PlatformConfig;

  constructor(config: PlatformConfig) {
    this.config = config;
    this.name = config.name;
    this.dataFolderName = config.dataFolderName;
    this.serverApplicationName = config.serverApplicationName;
  }

  getServerDownloadUrl(
    _commit: string,
    _quality: string,
    _targetPlatform: string,
    targetArch: string,
    _buildId?: string,
  ): string {
    const version = this.readVSCodiumVersion() || "0.0.0";
    return `${VSCodium_REH_BASE}/${version}/vscodium-reh-linux-${targetArch}-${version}.tar.gz`;
  }

  private readVSCodiumVersion(): string | undefined {
    try {
      const vscode = require("vscode");
      const fs = require("node:fs");
      const path = require("node:path");
      const productPath = path.join(vscode.env.appRoot, "product.json");
      const product = JSON.parse(fs.readFileSync(productPath, "utf-8"));
      return typeof product.version === "string" ? product.version : undefined;
    } catch {
      return undefined;
    }
  }

  getArgvPath(): string {
    return path.join(
      os.homedir(),
      this.config.hostDataFolderName ?? this.dataFolderName,
      "argv.json",
    );
  }

  needsArgvPatch(): boolean {
    return this.config.needsArgvPatch;
  }

  getAdditionalDockerRunArgs(): string[] {
    return this.config.additionalDockerRunArgs;
  }

  getServerInstallRoot(): string {
    return this.config.serverInstallRoot ?? "/tmp";
  }

  needsHomeSymlink(): boolean {
    return this.config.needsHomeSymlink ?? false;
  }

  isValidRuntime(): boolean {
    try {
      const vscode = require("vscode");
      const fs = require("node:fs");
      const path = require("node:path");
      const productPath = path.join(vscode.env.appRoot, "product.json");
      const product = JSON.parse(fs.readFileSync(productPath, "utf-8"));
      const appName: string = (product?.applicationName ?? "").toLowerCase();
      return (
        appName.includes("vscodium") ||
        appName.includes("codium") ||
        appName.includes("code-oss")
      );
    } catch {
      return true;
    }
  }
}
