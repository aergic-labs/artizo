/*
 * Copyright (c) 2026 Aergic Labs, LLC
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import type { TargetPlatform } from "./extensionRegistry";
import type { ExtensionMetadata } from "./marketplaceClient";

/**
 * Map Docker image inspect fields to a VS Code TargetPlatform.
 * Docker reports `Architecture` (amd64, arm64, arm, 386, ...), `Os`
 * (linux, windows), and `Variant` (v7, v8 for ARM only).
 *
 * Throws on unknown combinations so the caller surfaces a real error
 * instead of silently installing the wrong binary.
 */
export function dockerArchToTargetPlatform(
  arch: string,
  os: string,
  variant?: string,
): TargetPlatform {
  const a = arch.trim().toLowerCase();
  const o = os.trim().toLowerCase();
  const v = variant?.trim().toLowerCase();

  if (o === "linux") {
    switch (a) {
      case "amd64":
      case "x86_64":
        return "linux-x64";
      case "arm64":
      case "aarch64":
        return "linux-arm64";
      case "arm":
        if (v === "v8") return "linux-arm64";
        return "linux-armhf";
      default:
        throw new Error(`Unsupported docker arch for linux: "${arch}"`);
    }
  }
  if (o === "darwin") {
    switch (a) {
      case "amd64":
      case "x86_64":
        return "darwin-x64";
      case "arm64":
      case "aarch64":
        return "darwin-arm64";
      default:
        throw new Error(`Unsupported docker arch for darwin: "${arch}"`);
    }
  }
  if (o === "windows") {
    switch (a) {
      case "amd64":
      case "x86_64":
        return "win32-x64";
      case "arm64":
      case "aarch64":
        return "win32-arm64";
      default:
        throw new Error(`Unsupported docker arch for windows: "${arch}"`);
    }
  }
  throw new Error(`Unsupported docker os: "${os}"`);
}

/**
 * Parse `uname -ms` output into a TargetPlatform.
 * Output looks like "Linux x86_64\n" or "Darwin arm64\n".
 * Case-insensitive on the OS token, lowercase on arch.
 */
export function unameToTargetPlatform(output: string): TargetPlatform {
  const parts = output.trim().toLowerCase().split(/\s+/);
  if (parts.length < 2) {
    throw new Error(`uname output not parseable: "${output}"`);
  }
  const os = parts[0];
  const arch = parts[1];

  if (os === "linux") {
    switch (arch) {
      case "x86_64":
        return "linux-x64";
      case "aarch64":
      case "arm64":
        return "linux-arm64";
      case "armv7l":
      case "armv6l":
        return "linux-armhf";
      default:
        throw new Error(`Unsupported uname arch for linux: "${arch}"`);
    }
  }
  if (os === "darwin") {
    switch (arch) {
      case "x86_64":
        return "darwin-x64";
      case "arm64":
      case "aarch64":
        return "darwin-arm64";
      default:
        throw new Error(`Unsupported uname arch for darwin: "${arch}"`);
    }
  }
  throw new Error(`Unsupported uname os: "${os}"`);
}

/**
 * Apex (host) platform from Node's process info. Used to decide
 * whether apex-local extensions are valid for the target (copy vs
 * download). Returns undefined when the combination is unrecognized.
 */
export function apexTargetPlatform(): TargetPlatform | undefined {
  const arch = process.arch;
  const plat = process.platform;
  if (plat === "linux") {
    if (arch === "x64") return "linux-x64";
    if (arch === "arm64") return "linux-arm64";
    if (arch === "arm") return "linux-armhf";
    return undefined;
  }
  if (plat === "darwin") {
    if (arch === "x64") return "darwin-x64";
    if (arch === "arm64") return "darwin-arm64";
    return undefined;
  }
  if (plat === "win32") {
    if (arch === "x64") return "win32-x64";
    if (arch === "arm64") return "win32-arm64";
    return undefined;
  }
  return undefined;
}

/**
 * Whether a `targetPlatform` string (from extensions.json or a VSIX
 * manifest) represents a platform-specific install: not absent, not the
 * literal "undefined" used when no platform was recorded, and not the
 * string "universal".
 *
 * Used by both the devcontainer installer (which reads the marketplace
 * metadata's `downloads` map via `hasPlatformVariants`) and the SSH
 * mirror (which reads the apex extensions.json entry's `targetPlatform`
 * field). Both feed the same copy-vs-download decision in
 * `canCopyFromApex`.
 */
export function isPlatformSpecificTarget(
  targetPlatform: string | undefined,
): boolean {
  return (
    !!targetPlatform &&
    targetPlatform !== "undefined" &&
    targetPlatform !== "universal"
  );
}

/**
 * Decide whether an apex-local extension install can be copied to a
 * target without re-download. True when:
 *   - extension is universal (`perPlatform === false`), OR
 *   - apex platform exactly matches the target platform.
 *
 * Shared by extensionInstaller.ts (devcontainer path) and sideload.ts
 * (SSH mirror path) so a fix to the copy-vs-download judgment lands in
 * one place and applies to both.
 */
export function canCopyFromApex(
  perPlatform: boolean,
  targetPlatform: TargetPlatform | undefined,
): boolean {
  if (!perPlatform) return true;
  const apex = apexTargetPlatform();
  return apex !== undefined && apex === targetPlatform;
}

/**
 * Whether an extension has per-platform VSIX builds (not just universal).
 * Checks the downloads map for any key other than "universal".
 */
export function hasPlatformVariants(meta: ExtensionMetadata): boolean {
  if (!meta.downloads) return false;
  const keys = Object.keys(meta.downloads);
  if (keys.length === 0) return false;
  if (keys.length === 1 && keys[0] === "universal") return false;
  return true;
}

/**
 * Pick the right download URL for a target platform from an extension's
 * downloads map. Falls back to the default downloadUrl (files.download)
 * when the platform-specific URL is missing, with a warning log.
 */
export function selectDownloadUrl(
  meta: ExtensionMetadata,
  targetPlatform: TargetPlatform,
): string {
  if (meta.downloads && targetPlatform && meta.downloads[targetPlatform]) {
    return meta.downloads[targetPlatform];
  }
  // Fall back to universal/default. This is fine for universal-only
  // extensions, and a best-effort for per-platform extensions where the
  // specific platform build is missing from the registry.
  return meta.downloadUrl;
}
