/*
 * Copyright (c) 2026 Aergic Labs, LLC
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import * as os from "node:os";
import * as path from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { IPlatformAdapter } from "./types";
import type { DownloadUrlResult } from "./downloadTypes";
import { readProductJson } from "./index";
import { resolveNearestVsCodiumVersion } from "../remote/vscodiumFeed";
import { getNewestBundledVersion } from "./vscodiumBundledVersion";

const VSCODIUM_GITHUB_BASE =
  "https://github.com/VSCodium/vscodium/releases/download";
const KIRO_CDN_BASE = "https://prod.download.desktop.kiro.dev";
const DEVIN_CDN_BASE = "https://windsurf-stable.codeiumdata.com";
const ANTIGRAVITY_CDN_BASE =
  "https://dl.google.com/edgedl/release2/j0qc3/antigravity";
const QODER_CDN_BASE = "https://download.qoder.com";
const TRAE_CDN_FALLBACK = "https://lf-cdn.trae.ai/obj/trae-ai-sg";
const TRAE_GUIDANCE_API =
  "https://api.trae.ai/cloudide/api/v3/trae/GetLoginGuidanceForBytedance";

/** Fork config detected at runtime from product.json applicationName. */
interface ForkConfig {
  name: string;
  dataFolderName: string;
  serverDataFolderName: string;
  serverApplicationName: string;
  argvDataFolderNames: string[];
  remoteExtensionsDirs: string[];
  needsArgvPatch: boolean;
  /** Per-fork docker run args (Trae: seccomp=unconfined). */
  additionalDockerRunArgs: string[];
  /** Server install root on the container. */
  serverInstallRoot: string;
  /** Whether a home symlink is needed after install (Devin). */
  needsHomeSymlink: boolean;
  /** Host data folder for argv.json / apex extensions (Devin: .devin). */
  hostDataFolderName?: string;
  /** Whether this fork forwards auth files (Kiro: AWS SSO token). */
  hasAuthFiles: boolean;
}

const VSCODIUM_CONFIG: ForkConfig = {
  name: "VSCodium",
  dataFolderName: ".vscode-oss",
  serverDataFolderName: ".vscodium-server",
  serverApplicationName: "codium-server",
  argvDataFolderNames: [".vscode-oss", ".vscodium", ".code-oss", ".vscode"],
  remoteExtensionsDirs: [
    ".vscodium-server/extensions",
    ".vscode-oss-server/extensions",
  ],
  needsArgvPatch: true,
  additionalDockerRunArgs: [],
  serverInstallRoot: "/tmp",
  needsHomeSymlink: false,
  hasAuthFiles: false,
};

const VSCODE_OSS_CONFIG: ForkConfig = {
  name: "VSCode-OSS",
  dataFolderName: ".vscode-oss",
  serverDataFolderName: ".vscode-server-oss",
  serverApplicationName: "code-server-oss",
  argvDataFolderNames: [".vscode-oss", ".code-oss", ".vscode"],
  remoteExtensionsDirs: [".vscode-server-oss/extensions"],
  needsArgvPatch: true,
  additionalDockerRunArgs: [],
  serverInstallRoot: "/tmp",
  needsHomeSymlink: false,
  hasAuthFiles: false,
};

const TRAE_CONFIG: ForkConfig = {
  name: "Trae",
  dataFolderName: ".trae",
  serverDataFolderName: ".trae-server",
  serverApplicationName: "trae-server",
  argvDataFolderNames: [".trae"],
  remoteExtensionsDirs: [".trae-server/extensions"],
  needsArgvPatch: false,
  additionalDockerRunArgs: ["--security-opt", "seccomp=unconfined"],
  serverInstallRoot: "/tmp",
  needsHomeSymlink: false,
  hasAuthFiles: false,
};

const DEVIN_CONFIG: ForkConfig = {
  name: "Devin",
  dataFolderName: ".devin-server",
  serverDataFolderName: ".devin-server",
  serverApplicationName: "devin-server",
  argvDataFolderNames: [".devin-server", ".devin"],
  remoteExtensionsDirs: [".devin-server/extensions"],
  needsArgvPatch: true,
  additionalDockerRunArgs: [],
  serverInstallRoot: "/tmp",
  needsHomeSymlink: true,
  hostDataFolderName: ".devin",
  hasAuthFiles: false,
};

const ANTIGRAVITY_CONFIG: ForkConfig = {
  name: "Antigravity",
  dataFolderName: ".antigravity-ide",
  serverDataFolderName: ".antigravity-ide-server",
  serverApplicationName: "antigravity-ide-server",
  argvDataFolderNames: [".antigravity-ide"],
  remoteExtensionsDirs: [".antigravity-ide-server/extensions"],
  needsArgvPatch: true,
  additionalDockerRunArgs: [],
  serverInstallRoot: "/tmp",
  needsHomeSymlink: false,
  hasAuthFiles: false,
};

const QODER_CONFIG: ForkConfig = {
  name: "Qoder",
  dataFolderName: ".qoder",
  serverDataFolderName: ".qoder-server",
  serverApplicationName: "qoder-server",
  argvDataFolderNames: [".qoder"],
  remoteExtensionsDirs: [".qoder-server/extensions"],
  needsArgvPatch: true,
  additionalDockerRunArgs: [],
  serverInstallRoot: "/tmp",
  needsHomeSymlink: false,
  hasAuthFiles: false,
};

const KIRO_CONFIG: ForkConfig = {
  name: "Kiro",
  dataFolderName: ".kiro",
  serverDataFolderName: ".kiro-server",
  serverApplicationName: "kiro-server",
  argvDataFolderNames: [".kiro"],
  remoteExtensionsDirs: [".kiro-server/extensions"],
  needsArgvPatch: true,
  additionalDockerRunArgs: [],
  serverInstallRoot: "/tmp",
  needsHomeSymlink: false,
  hasAuthFiles: true,
};

const BOB_CONFIG: ForkConfig = {
  name: "Bob",
  dataFolderName: ".bobide",
  serverDataFolderName: ".bobide-server",
  serverApplicationName: "bobide-server",
  argvDataFolderNames: [".bobide"],
  remoteExtensionsDirs: [".bobide-server/extensions"],
  needsArgvPatch: true,
  additionalDockerRunArgs: [],
  serverInstallRoot: "/tmp",
  needsHomeSymlink: false,
  hasAuthFiles: false,
};

function detectFork(): ForkConfig {
  try {
    const product = readProductJson();
    const name = String(product.applicationName ?? "").toLowerCase();
    // Exact match only - "code-oss" is the OSS build's applicationName.
    // Real VSCodium uses "codium" and must hit the VSCODIUM_CONFIG branch.
    if (name === "code-oss") return VSCODE_OSS_CONFIG;
    if (name.includes("trae") || name.includes("byte")) return TRAE_CONFIG;
    if (name.includes("devin") || name.includes("windsurf"))
      return DEVIN_CONFIG;
    if (name.includes("antigravity")) return ANTIGRAVITY_CONFIG;
    if (name.includes("qoder")) return QODER_CONFIG;
    if (name.includes("kiro")) return KIRO_CONFIG;
    if (name.includes("bob")) return BOB_CONFIG;
  } catch {
    // fall through to vscodium default
  }
  return VSCODIUM_CONFIG;
}

// --- Trae CDN region detection ---

/** Read the Trae CDN base map from product.json bootConfig.cdn. */
function readTraeCdnConfig(): Record<string, string> {
  try {
    const product = readProductJson() as Record<string, unknown>;
    const bootConfig = product?.bootConfig as
      | { cdn?: Record<string, string> }
      | undefined;
    return bootConfig?.cdn ?? {};
  } catch {
    return {};
  }
}

/** Detect the user's Trae CDN region via the public guidance API. */
async function detectTraeRegion(): Promise<string> {
  try {
    const res = await fetch(TRAE_GUIDANCE_API, {
      method: "POST",
      signal: AbortSignal.timeout(5000),
    });
    if (res.ok) {
      const data = (await res.json()) as { Result?: { Region?: string } };
      const region = data?.Result?.Region;
      if (region) return region.toUpperCase();
    }
  } catch {
    // fall through to US default
  }
  return "US";
}

/** Resolve the Trae CDN base for the auto-detected region. */
async function traeCdnBase(): Promise<string> {
  const region = await detectTraeRegion();
  const cdn = readTraeCdnConfig();
  let base: string | undefined;
  if (region === "US") {
    // US users may need the USTTP CDN over the US one.
    base = cdn.USTTP || cdn.US || cdn.SG;
  } else if (region === "CN") {
    base = cdn.CN || cdn.SG;
  } else {
    base = cdn[region] || cdn.SG;
  }
  return (base || TRAE_CDN_FALLBACK).replace(/\/$/, "");
}

let _cachedTraeCdnBase: Promise<string> | undefined;
function getCachedTraeCdnBase(): Promise<string> {
  if (!_cachedTraeCdnBase) _cachedTraeCdnBase = traeCdnBase();
  return _cachedTraeCdnBase;
}

/** Fetch the Trae server version from the CDN version file. Falls back to
 * the commit on failure. */
async function fetchTraeVersion(
  versionUrl: string,
  commit: string,
): Promise<string> {
  try {
    const response = await fetch(versionUrl, {
      signal: AbortSignal.timeout(15000),
    });
    if (response.ok) {
      const version = (await response.text()).trim();
      if (version) return version;
    }
  } catch {
    // fall through to commit fallback
  }
  return commit;
}

// --- Adapter ---

/**
 * Unified VSCodium adapter with runtime fork detection.
 *
 * One VSIX, multiple forks. Detects the running IDE from product.json's
 * `applicationName` at construction time and selects the appropriate fork
 * config (data folders, argv patching, server names, download URL logic,
 * docker args, auth files). Replaces artizo's prior per-fork adapter
 * classes (KiroAdapter / TraeAdapter / DevinAdapter / VSCodiumAdapter).
 *
 * Supported: VSCodium, code-oss, VSCode-OSS, Trae, Devin, Antigravity,
 * Qoder, Kiro, Bob. VSCodium is the catch-all fallback. The
 * `artizo.serverDownload` object setting overrides automatic detection
 * when mode="custom" (handled in getProductInfo).
 *
 * Bob ships `serverDownloadUrlTemplate` in product.json, so
 * `getServerDownloadUrl()` is never called for Bob - the template
 * substitution path in url.ts handles it.
 */
export class VSCodiumAdapter implements IPlatformAdapter {
  private readonly fork: ForkConfig = detectFork();
  readonly name = this.fork.name;
  readonly dataFolderName = this.fork.dataFolderName;
  readonly serverDataFolderName = this.fork.serverDataFolderName;
  readonly serverApplicationName = this.fork.serverApplicationName;

  async getServerDownloadUrl(
    commit: string,
    quality: string,
    _targetPlatform: string,
    targetArch: string,
    buildId?: string,
  ): Promise<DownloadUrlResult> {
    switch (this.fork) {
      case TRAE_CONFIG:
        return { url: await this.traeDownloadUrl(commit, targetArch), type: "auto" };
      case DEVIN_CONFIG:
        return { url: this.devinDownloadUrl(commit, quality, targetArch, buildId), type: "auto" };
      case ANTIGRAVITY_CONFIG:
        return { url: this.antigravityDownloadUrl(commit, quality, targetArch), type: "auto" };
      case QODER_CONFIG:
        return { url: this.qoderDownloadUrl(commit, targetArch), type: "auto" };
      case KIRO_CONFIG:
        return { url: this.kiroDownloadUrl(commit, targetArch), type: "auto" };
      case VSCODE_OSS_CONFIG:
        return { url: await this.vscodeOssDownloadUrl(targetArch), type: "auto" };
      default:
        return { url: this.vscodiumDownloadUrl(targetArch), type: "fallback" };
    }
  }

  private vscodiumDownloadUrl(arch: string): string {
    const version =
      this.readVersion() || getNewestBundledVersion() || "0.0.0";
    return `${VSCODIUM_GITHUB_BASE}/${version}/vscodium-reh-linux-${arch}-${version}.tar.gz`;
  }

  // vscode-oss: map the local major.minor.patch to the highest VSCodium
  // release <= local, then use VSCodium's reh tarball. Returns "0.0.0" on
  // any failure to match the VSCodium fallback convention.
  private async vscodeOssDownloadUrl(arch: string): Promise<string> {
    const localVersion =
      this.readVersion() || getNewestBundledVersion() || "0.0.0";
    const nearest = await resolveNearestVsCodiumVersion(localVersion);
    const v = nearest || getNewestBundledVersion() || "0.0.0";
    return `${VSCODIUM_GITHUB_BASE}/${v}/vscodium-reh-linux-${arch}-${v}.tar.gz`;
  }

  private async traeDownloadUrl(
    commit: string,
    arch: string,
  ): Promise<string> {
    const cdnBase = await getCachedTraeCdnBase();
    // CDN dir uses linux-debian10, tarball filename uses linux.
    const versionUrl = `${cdnBase}/pkg/server/releases/stable/${commit}/linux-debian10/version`;
    const version = await fetchTraeVersion(versionUrl, commit);
    return `${cdnBase}/pkg/server/releases/stable/${commit}/linux-debian10/Trae-linux-${arch}-${version}.tar.gz`;
  }

  private devinDownloadUrl(
    commit: string,
    quality: string,
    arch: string,
    buildId?: string,
  ): string {
    // Devin uses buildId (passed from product.json buildId) when available,
    // else windsurfVersion from product.json, else "0.0.0".
    const version = buildId || this.readWindsurfVersion() || "0.0.0";
    return `${DEVIN_CDN_BASE}/linux-reh-${arch}/${quality}/${commit}/devin-reh-linux-${arch}-${version}.tar.gz`;
  }

  private antigravityDownloadUrl(
    commit: string,
    quality: string,
    arch: string,
  ): string {
    const version = this.readIdeVersion() || "0.0.0";
    return `${ANTIGRAVITY_CDN_BASE}/${quality}/${version}-${commit}/linux-${arch}/Antigravity%20IDE-reh.tar.gz`;
  }

  private qoderDownloadUrl(commit: string, arch: string): string {
    const version = this.readProductVersion() || "0.0.0";
    return `${QODER_CDN_BASE}/server/${version}/${commit}/qoder-reh-linux-${arch}-${version}.tar.gz`;
  }

  private kiroDownloadUrl(commit: string, arch: string): string {
    // Reached only when neither user setting nor product.json provides a
    // template. Kiro's product.json ships no serverDownloadUrlTemplate, so
    // this path is the norm for Kiro. Points at the Kiro CDN (matches
    // src/platform/forkTemplates.ts); the prior fallback pointed at
    // Microsoft's update.code.visualstudio.com, which 404s for Kiro commits.
    return `${KIRO_CDN_BASE}/releases/remotes/${commit}/kiro-reh-linux-${arch}.tar.gz`;
  }

  private readVersion(): string | undefined {
    return this.readProductField("version");
  }

  private readWindsurfVersion(): string | undefined {
    return this.readProductField("windsurfVersion");
  }

  private readIdeVersion(): string | undefined {
    return this.readProductField("ideVersion");
  }

  private readProductVersion(): string | undefined {
    return this.readProductField("productVersion");
  }

  private readProductField(field: string): string | undefined {
    try {
      const product = readProductJson();
      const value = (product as Record<string, unknown>)[field];
      return typeof value === "string" ? value : undefined;
    } catch {
      return undefined;
    }
  }

  getArgvPath(): string {
    return path.join(
      os.homedir(),
      this.fork.hostDataFolderName ?? this.fork.dataFolderName,
      "argv.json",
    );
  }

  getArgvDataFolderNames(): string[] {
    // Prefer product.json dataFolderName when shipped (Bob does this);
    // otherwise use the fork's configured data folder, then fall back to
    // the fork's argv candidates.
    const fromProduct = this.readProductField("dataFolderName");
    const primary = fromProduct ?? this.fork.dataFolderName;
    const rest = this.fork.argvDataFolderNames.filter((f) => f !== primary);
    return [primary, ...rest];
  }

  needsArgvPatch(): boolean {
    return this.fork.needsArgvPatch;
  }

  getAdditionalDockerRunArgs(): string[] {
    return this.fork.additionalDockerRunArgs;
  }

  getRemoteExtensionsDirCandidates(): string[] {
    // Derive from product.json serverDataFolderName if available (Bob
    // ships it); otherwise use the fork's configured server dir.
    const serverFolder = this.readProductField("serverDataFolderName");
    if (serverFolder) {
      return [`${serverFolder}/extensions`];
    }
    return this.fork.remoteExtensionsDirs;
  }

  getApexExtensionsDir(): string {
    return path.join(
      os.homedir(),
      this.fork.hostDataFolderName ?? this.fork.dataFolderName,
      "extensions",
    );
  }

  getServerInstallRoot(): string {
    return this.fork.serverInstallRoot;
  }

  needsHomeSymlink(): boolean {
    return this.fork.needsHomeSymlink;
  }

  isValidRuntime(): boolean {
    // VSCodium build allows any runtime. Detection happens for download
    // URL selection, not activation gating.
    return true;
  }

  readAuthFiles(): { path: string; content: string }[] {
    if (!this.fork.hasAuthFiles) return [];
    // Kiro only. Always forward the token file when present - it works
    // until expiry even without the registration sibling.
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
    // holds the clientId/clientSecret the remote needs to refresh. If we
    // can't parse the hash or the sibling file is missing, we still return
    // the token alone - many Kiro auth methods don't use SSO refresh and
    // may not produce this file.
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

  getChecksumConfig(): {
    checksumMethod?: "sidecar" | "manifest";
    checksumAlgo?: "sha256" | "md5";
    manifestTemplate?: string;
    manifestField?: string;
  } {
    switch (this.fork) {
      case VSCODIUM_CONFIG:
      case VSCODE_OSS_CONFIG:
        return { checksumMethod: "sidecar", checksumAlgo: "sha256" };
      case TRAE_CONFIG:
        return { checksumMethod: "sidecar", checksumAlgo: "md5" };
      case QODER_CONFIG:
        return { checksumMethod: "sidecar", checksumAlgo: "md5" };
      case DEVIN_CONFIG:
        return {
          checksumMethod: "manifest",
          manifestTemplate:
            "https://windsurf-stable.codeiumdata.com/${os}-reh-${arch}/${quality}/manifest-${commit}.json",
          manifestField: "sha256hash",
          checksumAlgo: "sha256",
        };
      default:
        // Antigravity, Kiro, Bob - no checksum source.
        return {};
    }
  }
}

/** @internal Test-only reset of the cached Trae CDN base. */
export function _resetTraeCdnBaseForTest(): void {
  _cachedTraeCdnBase = undefined;
}
