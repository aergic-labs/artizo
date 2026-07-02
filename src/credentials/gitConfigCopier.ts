/*
 * Copyright (c) 2026 Aergic Labs, LLC
 * SPDX-License-Identifier: AGPL-3.0-only
 */

/**
 * Copies the host .gitconfig into the dev container.
 * Reads the host ~/.gitconfig and writes it to the remote user home directory.
 */

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Host } from "../host/host";
import { escapeShellArg } from "../utils/shellUtils";

export interface IGitConfigCopier {
  copyGitConfig(
    containerId: string,
    perContainerDisable?: boolean,
  ): Promise<void>;
}

export interface GitConfigCopierOptions {
  dockerPath?: string;
  /** When false, copyGitConfig is a no-op. Corresponds to artizo.copyGitConfig. */
  enabled?: boolean;
  /** Override for testing. Defaults to ~/.gitconfig. */
  hostGitConfigPath?: string;
  host?: Host;
}

export class GitConfigCopier implements IGitConfigCopier {
  private readonly host: Host;
  private readonly enabled: boolean;
  private readonly hostGitConfigPath: string;

  constructor(options?: GitConfigCopierOptions) {
    this.host = options?.host!;
    this.enabled = options?.enabled ?? true;
    this.hostGitConfigPath =
      options?.hostGitConfigPath ?? join(homedir(), ".gitconfig");
  }

  async copyGitConfig(
    containerId: string,
    perContainerDisable?: boolean,
  ): Promise<void> {
    if (!this.enabled) {
      return;
    }
    if (perContainerDisable) {
      return;
    }

    let gitConfigContent: string;
    try {
      gitConfigContent = await readFile(this.hostGitConfigPath, "utf-8");
    } catch {
      return;
    }

    if (!gitConfigContent.trim()) {
      return;
    }

    const homeResult = await this.host.dockerExec(containerId, [
      "printenv",
      "HOME",
    ]);

    const remoteHome = homeResult.stdout.trim() || "/root";

    // Use base64 to avoid shell escaping issues
    const base64Content = Buffer.from(gitConfigContent, "utf-8").toString(
      "base64",
    );
    await this.host.dockerExec(containerId, [
      "sh",
      "-c",
      `echo '${escapeShellArg(base64Content)}' | base64 -d > ${escapeShellArg(remoteHome)}/.gitconfig`,
    ]);
  }
}
