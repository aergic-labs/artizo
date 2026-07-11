/*
 * Copyright (c) 2026 Aergic Labs, LLC
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import * as vscode from "vscode";
import * as os from "node:os";
import * as path from "node:path";
import { readFileSync } from "node:fs";
import type { IPlatformAdapter, PlatformConfig } from "./types";

const DEVIN_CDN_BASE = "https://windsurf-stable.codeiumdata.com";

export class DevinAdapter implements IPlatformAdapter {
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
    // Devin uses the same codeiumdata.com CDN as Windsurf.
    const version = buildId || this.readWindsurfVersion() || "0.0.0";
    return `${DEVIN_CDN_BASE}/linux-reh-${targetArch}/${quality}/${commit}/devin-reh-linux-${targetArch}-${version}.tar.gz`;
  }

  private readWindsurfVersion(): string | undefined {
    try {
      const productPath = path.join(vscode.env.appRoot, "product.json");
      const product = JSON.parse(readFileSync(productPath, "utf-8"));
      return typeof product.windsurfVersion === "string"
        ? product.windsurfVersion
        : undefined;
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

  getArgvDataFolderNames(): string[] {
    return [
      this.config.hostDataFolderName ?? this.dataFolderName,
      ...(this.config.argvDataFolderNames ?? []),
    ];
  }

  needsArgvPatch(): boolean {
    return this.config.needsArgvPatch;
  }

  getAdditionalDockerRunArgs(): string[] {
    return this.config.additionalDockerRunArgs;
  }

  getRemoteExtensionsDirCandidates(): string[] {
    // Devin's remote server dir is ~/.devin-server/extensions.
    // dataFolderName is already ".devin-server" for Devin, so the
    // server extensions dir is just <dataFolderName>/extensions.
    return [`${this.dataFolderName}/extensions`];
  }

  getApexExtensionsDir(): string {
    // Client extensions dir: ~/.devin/extensions (hostDataFolderName).
    return path.join(
      os.homedir(),
      this.config.hostDataFolderName ?? this.dataFolderName,
      "extensions",
    );
  }

  getServerInstallRoot(): string {
    return this.config.serverInstallRoot ?? "/tmp";
  }

  needsHomeSymlink(): boolean {
    return this.config.needsHomeSymlink ?? false;
  }

  isValidRuntime(): boolean {
    try {
      const productPath = path.join(vscode.env.appRoot, "product.json");
      const product = JSON.parse(readFileSync(productPath, "utf-8"));
      const appName: string = (product?.applicationName ?? "").toLowerCase();
      return appName.includes("devin") || appName.includes("windsurf");
    } catch {
      return true;
    }
  }
}
