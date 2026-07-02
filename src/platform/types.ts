/*
 * Copyright (c) 2026 Aergic Labs, LLC
 * SPDX-License-Identifier: AGPL-3.0-only
 */

/**
 * Platform adapter interface.
 *
 * Each supported IDE (Kiro, Trae, Devin) provides an implementation.
 * Vendor-specific configuration is sourced from vendor/<target>/package.json
 * so each adapter file contains only its own platform's logic.
 */

/**
 * Platform configuration read from vendor package.json.
 */
export interface PlatformConfig {
  name: string;
  dataFolderName: string;
  serverApplicationName: string;
  needsArgvPatch: boolean;
  additionalDockerRunArgs: string[];
  serverInstallRoot?: string;
  needsHomeSymlink?: boolean;
  /** Host data folder for argv.json. Defaults to dataFolderName. */
  hostDataFolderName?: string;
  /**
   * Candidate data folder names where argv.json may live. Defaults to
   * [dataFolderName] when absent. VSCodium needs both .vscode-oss and
   * .vscodium because different builds use different folder names.
   */
  argvDataFolderNames?: string[];
}

/**
 * Adapter for IDE-specific behavior: server download URLs, argv paths, etc.
 */
export interface IPlatformAdapter {
  /** Human-readable IDE name */
  readonly name: string;
  /** Config data folder name */
  readonly dataFolderName: string;
  /** Remote server application name */
  readonly serverApplicationName: string;

  /**
   * Construct the server download URL for the given commit and target platform/arch.
   * May be async (Trae fetches version from CDN endpoint).
   */
  getServerDownloadUrl(
    commit: string,
    quality: string,
    targetPlatform: string,
    targetArch: string,
    buildId?: string,
  ): string | Promise<string>;

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
   * Candidate remote server extensions directories, relative to the
   * remote home (POSIX, no leading slash). Probed in order by the
   * side-load bootstrap. The first that exists wins.
   *
   * Returns just the current platform's own server dir - the
   * side-load runs from inside the target IDE, so cross-platform
   * fallbacks would only leak competitor names into the bundle (which
   * guard-bundle.mjs rejects). One entry per adapter.
   */
  getRemoteExtensionsDirCandidates(): string[];

  /**
   * Absolute path to the apex (client) extensions directory. Used by
   * the SSH side-load mirror to enumerate locally-installed extensions
   * on disk - vscode.extensions.all on the UI-side exthost doesn't
   * include workspace-kind extensions that aren't loaded into that
   * process, so we read the disk ledger directly.
   */
  getApexExtensionsDir(): string;

  /** Read auth token from host filesystem. */
  readAuthToken?(): string | undefined;

  /** Path for auth token inside container, relative to HOME. */
  getAuthTokenPath?(): string;

  /**
   * Validate that this extension is running on the expected IDE platform.
   * Returns false if the extension is installed on the wrong IDE
   * (e.g., an extension built for one IDE running in another).
   */
  isValidRuntime(): boolean;
}
