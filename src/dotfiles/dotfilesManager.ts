/*
 * Copyright (c) 2026 Aergic Labs, LLC
 * SPDX-License-Identifier: AGPL-3.0-only
 */

/** Dotfiles manager for cloning and installing dotfiles in containers. */

import type { Host } from "../host/host";

export interface DotfilesConfig {
  /** Repository URL to clone. */
  repository: string;
  /** Command to run after cloning (e.g. "./install.sh"). */
  installCommand?: string;
  /** Target path inside the container. Default: ~/dotfiles */
  targetPath?: string;
}

export interface DotfilesResult {
  success: boolean;
  cloned: boolean;
  installed: boolean;
  error?: string;
}

export interface DotfilesManagerOptions {
  dockerPath?: string;
  host?: Host;
}

export interface IDotfilesManager {
  install(containerId: string, config: DotfilesConfig): Promise<DotfilesResult>;
}

export class DotfilesManager implements IDotfilesManager {
  private readonly host: Host;

  constructor(options?: DotfilesManagerOptions) {
    this.host = options?.host!;
  }

  /** Clone dotfiles and run install command. Failures are non-blocking. */
  async install(
    containerId: string,
    config: DotfilesConfig,
  ): Promise<DotfilesResult> {
    if (!config.repository) {
      return { success: true, cloned: false, installed: false };
    }

    const targetPath = config.targetPath ?? "~/dotfiles";

    const cloneResult = await this.cloneRepository(
      containerId,
      config.repository,
      targetPath,
    );

    if (!cloneResult.success) {
      return {
        success: false,
        cloned: false,
        installed: false,
        error: cloneResult.error,
      };
    }

    if (config.installCommand) {
      const installResult = await this.runInstallCommand(
        containerId,
        config.installCommand,
        targetPath,
      );

      return {
        success: installResult.success,
        cloned: true,
        installed: installResult.success,
        error: installResult.error,
      };
    }

    const defaultInstallResult = await this.tryDefaultInstallScripts(
      containerId,
      targetPath,
    );

    return {
      success: true,
      cloned: true,
      installed: defaultInstallResult,
    };
  }

  private async cloneRepository(
    containerId: string,
    repository: string,
    targetPath: string,
  ): Promise<{ success: boolean; error?: string }> {
    await this.host.dockerExec(containerId, ["rm", "-rf", targetPath]);
    // Ignore rm errors; directory may not exist.

    const cloneResult = await this.host.dockerExec(containerId, [
      "git",
      "clone",
      "--depth",
      "1",
      repository,
      targetPath,
    ]);

    if (cloneResult.exitCode !== 0) {
      return {
        success: false,
        error: `Failed to clone dotfiles repository: ${cloneResult.stderr}`,
      };
    }

    return { success: true };
  }

  private async runInstallCommand(
    containerId: string,
    installCommand: string,
    targetPath: string,
  ): Promise<{ success: boolean; error?: string }> {
    const cmd = ["sh", "-c", installCommand];
    const result = await this.host.dockerExec(containerId, cmd, {
      workdir: targetPath,
    });

    if (result.exitCode !== 0) {
      return {
        success: false,
        error: `Dotfiles install command failed: ${result.stderr}`,
      };
    }

    return { success: true };
  }

  /** Try install.sh, install, bootstrap.sh, bootstrap, setup.sh, setup */
  private async tryDefaultInstallScripts(
    containerId: string,
    targetPath: string,
  ): Promise<boolean> {
    const scripts = [
      "install.sh",
      "install",
      "bootstrap.sh",
      "bootstrap",
      "setup.sh",
      "setup",
    ];

    for (const script of scripts) {
      const testFile = await this.host.dockerExec(containerId, [
        "test",
        "-f",
        `${targetPath}/${script}`,
      ]);
      if (testFile.exitCode !== 0) continue;

      const testExec = await this.host.dockerExec(containerId, [
        "test",
        "-x",
        `${targetPath}/${script}`,
      ]);
      if (testExec.exitCode !== 0) continue;

      const runResult = await this.host.dockerExec(
        containerId,
        ["sh", "-c", `./${script}`],
        { workdir: targetPath },
      );
      return runResult.exitCode === 0;
    }

    return false;
  }
}
