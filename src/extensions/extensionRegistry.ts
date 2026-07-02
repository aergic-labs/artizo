/*
 * Copyright (c) 2026 Aergic Labs, LLC
 * SPDX-License-Identifier: AGPL-3.0-only
 */

/**
 * Shared utilities for building extensions.json entries.
 *
 * Used by both the SSH side-load bootstrap (sideload.ts) and the
 * devcontainer extension installer (extensionInstaller.ts). Both
 * produce the same entry shape so the server's scanner recognizes
 * the extension.
 *
 * Fields only the MS marketplace provides (real extension/publisher
 * UUIDs) are derived via `stableExtensionUuid` so they stay stable
 * across re-installs.
 */

/**
 * Target platform for an extension VSIX. `undefined` or the literal
 * string `'undefined'` means no platform suffix on the folder name.
 * Everything else, including `'universal'` and `'unknown'`, gets one.
 */
export type TargetPlatform =
  | "universal"
  | "linux-x64"
  | "linux-arm64"
  | "linux-armhf"
  | "alpine-x64"
  | "alpine-arm64"
  | "darwin-x64"
  | "darwin-arm64"
  | "win32-x64"
  | "win32-arm64"
  | "web"
  | string
  | undefined;

/**
 * Shape of an entry in extensions.json: identifier, version, location
 * (absolute file URI), relativeLocation (folder name), and metadata.
 */
export interface ExtensionEntry {
  identifier: { id: string; uuid?: string };
  version: string;
  location: { $mid: 1; path: string; scheme: "file" };
  relativeLocation: string;
  metadata: {
    installedTimestamp: number;
    pinned: boolean;
    source: "vsix" | "gallery";
    id: string;
    publisherId: string;
    publisherDisplayName: string;
    targetPlatform?: string;
    updated: boolean;
    private: boolean;
    isPreReleaseVersion: boolean;
    hasPreReleaseVersion: boolean;
  };
}

/**
 * Stable UUID for an extension with no marketplace UUID. Deterministic
 * per-id; not cryptographic.
 */
export function stableExtensionUuid(extId: string): string {
  const seed = extId + "-artizo";
  let hex = "";
  for (let i = 0; i < 32; i++) {
    hex += seed
      .charCodeAt(i % seed.length)
      .toString(16)
      .slice(-1);
  }
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

/**
 * Folder name for an extension install: `<id>-<version>[-<platform>].
 * No suffix when targetPlatform is `undefined` or `'undefined'`. Id is
 * lowercased per gallery convention.
 */
export function extensionFolderName(
  extId: string,
  version: string,
  targetPlatform: TargetPlatform = undefined,
): string {
  const id = extId.toLowerCase();
  const base = `${id}-${version}`;
  if (!targetPlatform || targetPlatform === "undefined") {
    return base;
  }
  return `${base}-${targetPlatform}`;
}

/**
 * Options for `buildExtensionEntry`. Fields not available from Open VSX
 * (real marketplace UUIDs) are derived from the extension id.
 */
export interface BuildExtensionEntryOptions {
  /** Extension ID (e.g. "ms-vscode.hexeditor"). */
  extId: string;
  /** Extension version string. */
  version: string;
  /** Absolute path to the extension folder on the target filesystem. */
  folderPath: string;
  /** Publisher display name (e.g. "ms-vscode"). */
  publisherDisplayName: string;
  /** Target platform for the VSIX (e.g. "universal", "linux-x64"). */
  targetPlatform?: TargetPlatform;
  /**
   * Real extension UUID from the marketplace, if known. Falls back to a
   * stable derived UUID.
   */
  extensionUuid?: string;
  /**
   * Real publisher UUID from the marketplace, if known. Falls back to a
   * stable derived UUID based on the publisher (namespace) portion of
   * the extension id.
   */
  publisherUuid?: string;
}

/**
 * Build an extensions.json entry for a VSIX-installed extension.
 * `source` is always `"vsix"`. UUIDs default to stable derived values
 * when the marketplace doesn't provide them.
 */
export function buildExtensionEntry(
  options: BuildExtensionEntryOptions,
): ExtensionEntry {
  const {
    extId,
    version,
    folderPath,
    publisherDisplayName,
    targetPlatform,
    extensionUuid,
    publisherUuid,
  } = options;

  // Lowercase per gallery convention. Scanner compares
  // case-insensitively, so this is cosmetic.
  const id = extId.toLowerCase();
  const uuid = extensionUuid ?? stableExtensionUuid(id);
  const dot = id.indexOf(".");
  const namespace = dot > 0 ? id.substring(0, dot) : id;
  const pubId = publisherUuid ?? stableExtensionUuid(namespace);
  const folder = extensionFolderName(id, version, targetPlatform);

  return {
    identifier: { id, uuid },
    version,
    location: { $mid: 1, path: folderPath, scheme: "file" },
    relativeLocation: folder,
    metadata: {
      installedTimestamp: Date.now(),
      pinned: false,
      source: "vsix",
      id: uuid,
      publisherId: pubId,
      publisherDisplayName,
      targetPlatform,
      updated: false,
      private: false,
      isPreReleaseVersion: false,
      hasPreReleaseVersion: false,
    },
  };
}

/**
 * Check if an extension is already in an entries array by
 * `identifier.id` (case-insensitive) or `relativeLocation`.
 */
export function isExtensionInEntries(
  entries: unknown[],
  extId: string,
  folderName: string,
): boolean {
  const idLower = extId.toLowerCase();
  return entries.some(
    (e) =>
      typeof e === "object" &&
      e !== null &&
      ((e as { identifier?: { id?: string } }).identifier?.id?.toLowerCase() ===
        idLower ||
        (e as { relativeLocation?: string }).relativeLocation === folderName),
  );
}
