/*
 * Copyright (c) 2026 Aergic Labs, LLC
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import * as vscode from "vscode";
import * as os from "node:os";
import * as path from "node:path";
import { readFileSync } from "node:fs";
import type { IPlatformAdapter, PlatformConfig } from "./types";
import { resolveNearestVsCodiumVersion } from "../remote/vscodiumFeed";

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
  ): string | Promise<string> {
    // code-oss ships no reh tarballs. Use VSCodium's reh at the highest
    // release <= the local version. Commit patching after extraction
    // aligns the tarball's product.json with the IDE's commit.
    if (this.isCodeOss()) {
      return this.vscodeOssDownloadUrl(targetArch);
    }
    return this.vscodiumDownloadUrl(targetArch);
  }

  private vscodiumDownloadUrl(arch: string): string {
    const version = this.readVersion() || "0.0.0";
    return `${VSCodium_REH_BASE}/${version}/vscodium-reh-linux-${arch}-${version}.tar.gz`;
  }

  private async vscodeOssDownloadUrl(arch: string): Promise<string> {
    const localVersion = this.readVersion() || "0.0.0";
    const nearest = await resolveNearestVsCodiumVersion(localVersion);
    const v = nearest || "0.0.0";
    return `${VSCodium_REH_BASE}/${v}/vscodium-reh-linux-${arch}-${v}.tar.gz`;
  }

  private isCodeOss(): boolean {
    try {
      const productPath = path.join(vscode.env.appRoot, "product.json");
      const product = JSON.parse(readFileSync(productPath, "utf-8"));
      return String(product.applicationName ?? "").toLowerCase() === "code-oss";
    } catch {
      return false;
    }
  }

  private readVersion(): string | undefined {
    try {
      const productPath = path.join(vscode.env.appRoot, "product.json");
      const product = JSON.parse(readFileSync(productPath, "utf-8"));
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

  getArgvDataFolderNames(): string[] {
    // VSCodium builds use different data folder names depending on the
    // build variant. Probe in order of likelihood.
    return [
      this.config.hostDataFolderName ?? this.dataFolderName,
      ...(this.config.argvDataFolderNames ?? [
        ".vscodium",
        ".code-oss",
        ".vscode",
      ]),
    ];
  }

  needsArgvPatch(): boolean {
    return this.config.needsArgvPatch;
  }

  getAdditionalDockerRunArgs(): string[] {
    return this.config.additionalDockerRunArgs;
  }

  getRemoteExtensionsDirCandidates(): string[] {
    // VSCodium's remote server dir is ~/.vscodium-server/extensions.
    // dataFolderName (.vscode-oss) is the *client* data folder; the
    // server folder uses the "vscodium-server" name, not derivable
    // from dataFolderName. Also probe .vscode-oss-server as a
    // secondary candidate for code-oss users.
    return [".vscodium-server/extensions", ".vscode-oss-server/extensions"];
  }

  getApexExtensionsDir(): string {
    // Client extensions dir: ~/.vscode-oss/extensions.
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
      return (
        appName.includes("vscodium") ||
        appName.includes("codium") ||
        appName.includes("code-oss")
      );
    } catch {
      return true;
    }
  }

  // VSCodium and code-oss both use VSCodium's sha256 sidecar checksums.
  getChecksumConfig(): {
    checksumMethod: "sidecar";
    checksumAlgo: "sha256";
  } {
    return { checksumMethod: "sidecar", checksumAlgo: "sha256" };
  }
}
