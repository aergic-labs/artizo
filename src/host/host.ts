/*
 * Copyright (c) 2026 Aergic Labs, LLC
 * SPDX-License-Identifier: AGPL-3.0-only
 */

/**
 * Host abstraction - unifies environment detection and Docker execution.
 *
 * Under extensionKind ["workspace","ui"], the side that activates is the
 * side that has Docker. The activation guard in extension.ts ensures the
 * workspace-side extension does not activate inside a devcontainer (where
 * it would have no Docker). So the activating side always has Docker
 * locally, and Host.exec() is a plain local execFile.
 *
 * The "managed" kind is a defensive guard: if the workspace-side somehow
 * activates inside a container despite the guard, exec() throws rather
 * than silently doing the wrong thing.
 *
 * The prior "foreign" kind and its TCP-RPC-over-tunnel machinery has been
 * removed. It existed to let a UI-only extension drive Docker on a remote
 * host; with ["workspace","ui"] the side that has Docker runs the extension
 * directly.
 */

import * as vscode from "vscode";
import * as path from "node:path";
import { execFilePromise } from "../utils/dockerUtils";
import { decodeAuthority } from "../utils/uriUtils";
import { isInDevContainer } from "./state";

export type HostKind = "local" | "managed";

export interface ExecParams {
  cmd: string;
  args?: string[];
  cwd?: string;
}

export interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export class Host {
  readonly kind: HostKind;
  readonly platform: NodeJS.Platform;
  readonly path: typeof path.posix | typeof path.win32;
  readonly workspace: string | undefined;
  readonly dockerPath: string;

  private constructor(
    kind: HostKind,
    platform: NodeJS.Platform,
    workspace: string | undefined,
    dockerPath: string,
  ) {
    this.kind = kind;
    this.platform = platform;
    this.path = platform === "win32" ? path.win32 : path.posix;
    this.workspace = workspace;
    this.dockerPath = dockerPath;
  }

  get isManaged(): boolean {
    return this.kind === "managed";
  }

  async homedir(): Promise<string> {
    const os = await import("node:os");
    return os.homedir();
  }

  /**
   * Execute a command on the host's Docker runtime.
   *
   * Always local: the activating side has Docker. Throws if somehow
   * running managed (inside a container without Docker).
   */
  async exec(params: ExecParams): Promise<ExecResult> {
    if (this.kind === "managed") {
      throw new Error("Docker execution from managed container not supported.");
    }
    return execFilePromise(params.cmd, params.args ?? []);
  }

  /** Execute a Docker command inside a running container. */
  async dockerExec(
    containerId: string,
    command: string[],
    options?: { user?: string; workdir?: string },
  ): Promise<ExecResult> {
    const args = ["exec"];
    if (options?.user) {
      args.push("-u", options.user);
    }
    if (options?.workdir) {
      args.push("-w", options.workdir);
    }
    args.push(containerId, ...command);

    return this.exec({ cmd: this.dockerPath, args });
  }

  async readFile(
    filePath: string,
    encoding: "utf-8" | "base64" = "utf-8",
  ): Promise<string> {
    const fs = await import("node:fs/promises");
    return fs.readFile(filePath, encoding);
  }

  async writeFile(filePath: string, content: string): Promise<void> {
    const fs = await import("node:fs/promises");
    await fs.writeFile(filePath, content, "utf-8");
  }

  async stat(filePath: string): Promise<{
    size: number;
    mode: number;
    mtime: number;
    isDirectory: boolean;
    isFile: boolean;
  }> {
    const fs = await import("node:fs/promises");
    const stats = await fs.stat(filePath);
    return {
      size: stats.size,
      mode: stats.mode,
      mtime: stats.mtimeMs,
      isDirectory: stats.isDirectory(),
      isFile: stats.isFile(),
    };
  }

  async readdir(dirPath: string): Promise<string[]> {
    const fs = await import("node:fs/promises");
    const result = await fs.readdir(dirPath, { withFileTypes: true });
    return result.map((entry) => entry.name);
  }

  // Factory
  static create(params: { dockerPath: string }): Host {
    // Managed container - workspace-side trapped inside a devcontainer.
    // Defensive only: the activation guard should prevent this, but if it
    // happens, exec() will throw rather than silently fail.
    //
    // UI-side with a devcontainer remoteName is NOT managed - it runs on
    // the parent host where Docker lives, so it's "local" from Docker's
    // perspective.
    if (isInDevContainer()) {
      const folder = vscode.workspace.workspaceFolders?.[0]?.uri;
      let workspace: string | undefined;
      if (folder) {
        workspace = decodeAuthority(folder.authority).id;
      }
      return new Host("managed", "linux", workspace, params.dockerPath);
    }

    // Local - the activating side has Docker. Covers:
    //   - LocalHost (no remote, workspace-side)
    //   - RemoteSSH (workspace-side on the SSH host)
    //   - LocalDevContainer / RemoteSSHDevContainer (UI-side on the parent host)
    const folder = vscode.workspace.workspaceFolders?.[0];
    const workspace = folder ? folder.uri.fsPath : undefined;
    return new Host("local", process.platform, workspace, params.dockerPath);
  }
}
