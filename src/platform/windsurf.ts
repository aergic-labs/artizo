/*
 * Copyright (c) 2026 Aergic Labs, LLC
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import * as os from "node:os";
import * as path from "node:path";
import type { IPlatformAdapter, PlatformConfig } from "./types";

const WINDSURF_CDN_BASE = "https://windsurf-stable.codeiumdata.com";

export class WindsurfAdapter implements IPlatformAdapter {
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
    commit: string,
    quality: string,
    _targetPlatform: string,
    targetArch: string,
    buildId?: string,
  ): string {
    // Windsurf uses codeiumdata.com CDN, not the standard VS Code update API.
    const version = buildId || this.readWindsurfVersion() || "0.0.0";
    return `${WINDSURF_CDN_BASE}/linux-reh-${targetArch}/${quality}/${commit}/windsurf-reh-linux-${targetArch}-${version}.tar.gz`;
  }

  private readWindsurfVersion(): string | undefined {
    try {
      const vscode = require("vscode");
      const fs = require("node:fs");
      const path = require("node:path");
      const productPath = path.join(vscode.env.appRoot, "product.json");
      const product = JSON.parse(fs.readFileSync(productPath, "utf-8"));
      return typeof product.windsurfVersion === "string"
        ? product.windsurfVersion
        : undefined;
    } catch {
      return undefined;
    }
  }

  getArgvPath(): string {
    return path.join(os.homedir(), this.dataFolderName, "argv.json");
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
      return appName.includes("windsurf");
    } catch {
      return true;
    }
  }
}