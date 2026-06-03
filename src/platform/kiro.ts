/*
 * Copyright (c) 2026 Aergic Labs, LLC
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import * as os from "node:os";
import * as path from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { IPlatformAdapter, PlatformConfig } from "./types";

const DEFAULT_DOWNLOAD_BASE_URL = "https://update.code.visualstudio.com";

export class KiroAdapter implements IPlatformAdapter {
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
    _buildId?: string,
  ): string {
    return `${DEFAULT_DOWNLOAD_BASE_URL}/commit:${commit}/server-linux-${targetArch}/${quality}`;
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

  isValidRuntime(): boolean {
    try {
      const vscode = require("vscode");
      const fs = require("node:fs");
      const path = require("node:path");
      const productPath = path.join(vscode.env.appRoot, "product.json");
      const product = JSON.parse(fs.readFileSync(productPath, "utf-8"));
      const appName: string = (product?.applicationName ?? "").toLowerCase();
      return appName.includes("kiro");
    } catch {
      return true;
    }
  }

  readAuthToken(): string | undefined {
    const tokenPath = join(
      homedir(),
      ".aws",
      "sso",
      "cache",
      "kiro-auth-token.json",
    );
    if (!existsSync(tokenPath)) return undefined;
    try {
      return readFileSync(tokenPath, "utf-8");
    } catch {
      return undefined;
    }
  }

  getAuthTokenPath(): string {
    return ".aws/sso/cache/kiro-auth-token.json";
  }
}
