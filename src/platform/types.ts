/*
 * Copyright (c) 2026 Aergic Labs, LLC
 * SPDX-License-Identifier: AGPL-3.0-only
 */

/*
 * Copyright (c) 2026 Aergic Labs, LLC
 * SPDX-License-Identifier: AGPL-3.0-only
 */

/**
 * Platform adapter interface.
 *
 * A single unified adapter (`VSCodiumAdapter`) implements this interface
 * and handles every supported fork (VSCodium, code-oss, VSCode-OSS, Trae,
 * Devin, Antigravity, Qoder, Kiro, Bob) via runtime `product.json`
 * `applicationName` detection. Per-fork behavior is selected inside the
 * adapter; the interface is the artizo-side surface.
 */

import type { DownloadAdapter, DownloadUrlResult } from "./downloadTypes";

/**
 * Adapter for IDE-specific behavior: server download URLs, argv paths, etc.
 */
export interface IPlatformAdapter extends DownloadAdapter {
  /** Config data folder name */
  readonly dataFolderName: string;
  /** Remote server application name */
  readonly serverApplicationName: string;

  /**
   * Construct the server download URL for the given commit and target platform/arch.
   * May be async (Trae fetches version from CDN endpoint).
   */
  // Extends DownloadAdapter.getServerDownloadUrl with an optional
  // buildId param for forks that need it (kiro, trae). Callers using the
  // DownloadAdapter interface (url.ts) call with 4 args; buildId is
  // simply not passed.
  getServerDownloadUrl(
    commit: string,
    quality: string,
    targetPlatform: string,
    targetArch: string,
    buildId?: string,
  ): DownloadUrlResult | Promise<DownloadUrlResult>;

  /** Path to the IDE's argv.json file for proposed API enablement. */
  getArgvPath(): string;

  /**
   * Candidate data folder names where argv.json may live. The caller
   * probes each joined with os.homedir() + name + "argv.json"; the first
   * existing file wins. If none exist, the first candidate is created.
   */
  getArgvDataFolderNames(): string[];

  /** Whether argv.json patching is needed for proposed APIs to work. */
  needsArgvPatch(): boolean;

  /**
   * Additional Docker run arguments to pass to containers for this platform.
   */
  getAdditionalDockerRunArgs(): string[];

  /** Server install root directory on the container. */
  getServerInstallRoot?(): string;

  /** Whether a home symlink is needed after server install. */
  needsHomeSymlink?(): boolean;

  /**
   * Read auth files from the host filesystem for forwarding to the
   * remote. Each entry is a path relative to the remote HOME and the
   * file content (text). Returns empty if no auth files exist.
   *
   * Implementations should be resilient: if a primary token file
   * exists but a refresh/registration sibling is missing or cannot
   * be parsed, return just the primary so the remote still works
   * until token expiry.
   */
  readAuthFiles?(): { path: string; content: string }[];

  /**
   * Checksum configuration for the detected fork. Returns undefined if
   * the fork provides no checksum source.
   *
   * - `checksumAlgo`: if set, sidecar URL is derived as
   *   `resolvedDownloadUrl + "." + algo`.
   * - `manifestTemplate`: full URL template for a JSON manifest.
   * - `manifestField`: field name in the manifest JSON.
   */
  getChecksumConfig?(): {
    checksumMethod?: "sidecar" | "manifest";
    checksumAlgo?: "sha256" | "md5";
    manifestTemplate?: string;
    manifestField?: string;
  };

  /**
   * Validate that this extension is running on the expected IDE platform.
   * Returns false if the extension is installed on the wrong IDE
   * (e.g., an extension built for one IDE running in another).
   */
  isValidRuntime(): boolean;
}
