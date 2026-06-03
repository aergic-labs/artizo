/*
 * Copyright (c) 2026 Aergic Labs, LLC
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs";
import type { IPlatformAdapter, PlatformConfig } from "./types";

const GUIDANCE_API =
  "https://api.trae.ai/cloudide/api/v3/trae/GetLoginGuidanceForBytedance";

/** Detect CDN base by calling Trae's public guidance API. */
async function detectCdnBase(): Promise<string> {
  try {
    const response = await fetch(GUIDANCE_API, {
      method: "POST",
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = (await response.json()) as { Result?: { Region?: string } };
    const region = data?.Result?.Region || "SG";

    // US users may need USTTP CDN (lf-static.traecdn.us) instead of US CDN.
    // Prefer USTTP for US region, then US, then SG.
    const cdn = readCdnConfig();
    const base =
      region === "US"
        ? cdn.USTTP || cdn.US || cdn.SG
        : (cdn as Record<string, string>)[region] || cdn.SG;
    return (base || "https://lf-cdn.trae.ai/obj/trae-ai-sg").replace(/\/$/, "");
  } catch {
    const cdn = readCdnConfig();
    return (cdn.SG || "https://lf-cdn.trae.ai/obj/trae-ai-sg").replace(
      /\/$/,
      "",
    );
  }
}

function readCdnConfig(): Record<string, string> {
  try {
    const vscode = require("vscode");
    const productPath = path.join(vscode.env.appRoot, "product.json");
    if (fs.existsSync(productPath)) {
      const product = JSON.parse(fs.readFileSync(productPath, "utf-8"));
      return product?.bootConfig?.cdn || {};
    }
  } catch {
    /* fall through */
  }
  return {};
}

let _cachedCdnBase: Promise<string> | undefined;
function getCachedCdnBase(): Promise<string> {
  if (!_cachedCdnBase) _cachedCdnBase = detectCdnBase();
  return _cachedCdnBase;
}

/** Format: "{buildId}_{revision}" (e.g., "1154394023426_1"). */
let _cachedVersion: string | undefined;
function getServerVersion(): string {
  if (_cachedVersion !== undefined) return _cachedVersion;
  try {
    const extPath = path.join(os.homedir(), ".trae", "extensions");
    if (fs.existsSync(extPath)) {
      for (const dir of fs.readdirSync(extPath)) {
        if (dir.startsWith("cloudide.icube-remote-ssh")) {
          const versionPath = path.join(
            extPath,
            dir,
            "out",
            "scripts",
            "version",
          );
          if (fs.existsSync(versionPath)) {
            _cachedVersion = fs.readFileSync(versionPath, "utf-8").trim();
            return _cachedVersion;
          }
        }
      }
    }
  } catch {
    /* fall through */
  }
  _cachedVersion = "";
  return _cachedVersion;
}

export class TraeAdapter implements IPlatformAdapter {
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

  async getServerDownloadUrl(
    commit: string,
    _quality: string,
    _targetPlatform: string,
    targetArch: string,
    buildId?: string,
  ): Promise<string> {
    const cdnBase = await getCachedCdnBase();
    const version = buildId ? `${buildId}_1` : getServerVersion() || "0_1";
    // Trae CDN directory uses 'linux-debian10' but the tarball filename uses 'linux'.
    const dirPlatform = "linux-debian10";
    const filePlatform = "linux";
    const packageName = `Trae-${filePlatform}-${targetArch}-${version}.tar.gz`;
    return `${cdnBase}/pkg/server/releases/stable/${commit}/${dirPlatform}/${packageName}`;
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

  isValidRuntime(): boolean {
    try {
      const vscode = require("vscode");
      const fs = require("node:fs");
      const path = require("node:path");
      const productPath = path.join(vscode.env.appRoot, "product.json");
      const product = JSON.parse(fs.readFileSync(productPath, "utf-8"));
      const appName: string = (product?.applicationName ?? "").toLowerCase();
      return appName.includes("trae") || appName.includes("byte");
    } catch {
      return true;
    }
  }
}