/*
 * Copyright (c) 2026 Aergic Labs, LLC
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import * as vscode from "vscode";
import * as os from "node:os";
import * as path from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { IPlatformAdapter, PlatformConfig } from "./types";

const DEFAULT_DOWNLOAD_BASE_URL = "https://prod.download.desktop.kiro.dev";

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
    _quality: string,
    _targetPlatform: string,
    targetArch: string,
    _buildId?: string,
  ): string {
    // Point at the Kiro CDN (matches src/platform/forkTemplates.ts). The
    // prior fallback pointed at Microsoft's update.code.visualstudio.com,
    // which 404s for Kiro commits. This path is reached only when neither
    // the user setting nor product.json provides a template.
    return `${DEFAULT_DOWNLOAD_BASE_URL}/releases/remotes/${commit}/kiro-reh-linux-${targetArch}.tar.gz`;
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
    // Kiro's remote server dir is ~/.kiro-server/extensions.
    // dataFolderName (.kiro) is the *client* data folder; the server
    // folder follows the <name>-server convention.
    return [".kiro-server/extensions"];
  }

  getApexExtensionsDir(): string {
    // Client extensions dir: ~/.kiro/extensions.
    return path.join(
      os.homedir(),
      this.config.hostDataFolderName ?? this.dataFolderName,
      "extensions",
    );
  }

  isValidRuntime(): boolean {
    try {
      const productPath = path.join(vscode.env.appRoot, "product.json");
      const product = JSON.parse(readFileSync(productPath, "utf-8"));
      const appName: string = (product?.applicationName ?? "").toLowerCase();
      return appName.includes("kiro");
    } catch {
      return true;
    }
  }

  readAuthFiles(): { path: string; content: string }[] {
    // Always forward the token file when present. It works until
    // expiry even without the registration sibling.
    const cacheDir = join(homedir(), ".aws", "sso", "cache");
    const tokenRelPath = ".aws/sso/cache/kiro-auth-token.json";
    const tokenAbsPath = join(cacheDir, "kiro-auth-token.json");
    if (!existsSync(tokenAbsPath)) return [];

    let tokenContent: string;
    try {
      tokenContent = readFileSync(tokenAbsPath, "utf-8");
    } catch {
      return [];
    }
    const files: { path: string; content: string }[] = [
      { path: tokenRelPath, content: tokenContent },
    ];

    // The registration file named by `clientIdHash` in the token JSON
    // holds the clientId/clientSecret the remote needs to refresh.
    // If we can't parse the hash or the sibling file is missing, we
    // still return the token alone — many Kiro auth methods don't
    // use SSO refresh and may not produce this file.
    try {
      const token = JSON.parse(tokenContent);
      const hash =
        typeof token?.clientIdHash === "string" ? token.clientIdHash : "";
      if (hash && /^[a-f0-9]+$/i.test(hash)) {
        const regAbsPath = join(cacheDir, `${hash}.json`);
        if (existsSync(regAbsPath)) {
          files.push({
            path: `.aws/sso/cache/${hash}.json`,
            content: readFileSync(regAbsPath, "utf-8"),
          });
        }
      }
    } catch {
      // Token isn't valid JSON or doesn't expose clientIdHash.
      // Token alone still works until expiry.
    }
    return files;
  }
}
