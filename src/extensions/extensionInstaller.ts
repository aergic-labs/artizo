/*
 * Copyright (c) 2026 Aergic Labs, LLC
 * SPDX-License-Identifier: AGPL-3.0-only
 */

/**
 * Extension installer for dev containers.
 *
 * Installs extensions from devcontainer.json into the container.
 */

import * as path from "node:path";
import * as os from "node:os";
import * as fs from "node:fs";
import { dockerExec } from "../utils/dockerUtils";
import {
  MarketplaceClient,
  type MarketplaceClientOptions,
} from "./marketplaceClient";
import { extractExtensionIds } from "./extensionClassifier";

/**
 * The path inside the container where extensions are installed.
 */
export const EXTENSIONS_INSTALL_PATH = "~/.artizo-server/extensions";

/**
 * Result of installing a single extension.
 */
export interface ExtensionInstallResult {
  id: string;
  success: boolean;
  error?: string;
}

/**
 * Options for the extension installer.
 */
export interface ExtensionInstallerOptions {
  dockerPath?: string;
  marketplaceOptions?: MarketplaceClientOptions;
}

/**
 * Install extensions into a running container.
 */
export class ExtensionInstaller {
  private readonly dockerPath: string;
  private readonly marketplace: MarketplaceClient;

  constructor(options?: ExtensionInstallerOptions) {
    this.dockerPath = options?.dockerPath ?? "docker";
    this.marketplace = new MarketplaceClient(options?.marketplaceOptions);
  }

  /**
   * Install all extensions specified in a devcontainer.json config into the container.
   *
   * @param containerId - The Docker container ID
   * @param config - The parsed devcontainer.json object
   * @returns Array of results for each extension installation attempt
   */
  async installFromConfig(
    containerId: string,
    config: Record<string, unknown>,
  ): Promise<ExtensionInstallResult[]> {
    const extensionIds = extractExtensionIds(config);
    return this.installExtensions(containerId, extensionIds);
  }

  /**
   * Install a list of extensions by ID into the container.
   *
   * @param containerId - The Docker container ID
   * @param extensionIds - Array of extension IDs (e.g., ["publisher.extension-name"])
   * @returns Array of results for each extension installation attempt
   */
  async installExtensions(
    containerId: string,
    extensionIds: string[],
  ): Promise<ExtensionInstallResult[]> {
    if (extensionIds.length === 0) {
      return [];
    }

    // Ensure the extensions directory exists in the container
    await this.ensureExtensionsDir(containerId);

    const results: ExtensionInstallResult[] = [];

    for (const id of extensionIds) {
      const result = await this.installSingleExtension(containerId, id);
      results.push(result);
    }

    return results;
  }

  /**
   * Install a single extension into the container.
   */
  private async installSingleExtension(
    containerId: string,
    id: string,
  ): Promise<ExtensionInstallResult> {
    const tmpDir = os.tmpdir();

    try {
      const vsixPath = await this.marketplace.downloadVsix(id, tmpDir);

      try {
        await this.copyToContainer(containerId, vsixPath, "/tmp/");

        const vsixFileName = path.basename(vsixPath);
        const containerVsixPath = `/tmp/${vsixFileName}`;

        const extensionDir = `${EXTENSIONS_INSTALL_PATH}/${id}`;
        await this.extractVsix(containerId, containerVsixPath, extensionDir);

        await dockerExec(containerId, ["rm", "-f", containerVsixPath], {
          dockerPath: this.dockerPath,
        });

        return { id, success: true };
      } finally {
        // Clean up local temp file
        try {
          fs.unlinkSync(vsixPath);
        } catch {
          // Ignore cleanup errors
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { id, success: false, error: message };
    }
  }

  private async ensureExtensionsDir(containerId: string): Promise<void> {
    const result = await dockerExec(
      containerId,
      ["mkdir", "-p", EXTENSIONS_INSTALL_PATH],
      { dockerPath: this.dockerPath },
    );

    if (result.exitCode !== 0) {
      throw new Error(
        `Failed to create extensions directory (exit ${result.exitCode}): ${result.stderr}`,
      );
    }
  }

  private async copyToContainer(
    containerId: string,
    hostPath: string,
    containerPath: string,
  ): Promise<void> {
    const { dockerCp } = await import("../utils/dockerUtils.js");
    const result = await dockerCp(
      this.dockerPath,
      hostPath,
      containerId,
      containerPath,
    );
    if (result.exitCode !== 0) {
      throw new Error(`Failed to copy file to container: ${result.stderr}`);
    }
  }

  private async extractVsix(
    containerId: string,
    vsixPath: string,
    targetDir: string,
  ): Promise<void> {
    const cmd = [
      "sh",
      "-c",
      `mkdir -p "${targetDir}" && unzip -o -q "${vsixPath}" -d "${targetDir}"`,
    ];

    const result = await dockerExec(containerId, cmd, {
      dockerPath: this.dockerPath,
    });

    if (result.exitCode !== 0) {
      throw new Error(
        `Failed to extract VSIX (exit ${result.exitCode}): ${result.stderr}`,
      );
    }
  }
}