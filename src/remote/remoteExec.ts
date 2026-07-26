/*
 * Copyright (c) 2026 Aergic Labs, LLC
 * SPDX-License-Identifier: AGPL-3.0-only
 */

/** Remote exec abstraction over ssh or ExecServer. */

import { spawn } from "node:child_process";
import * as vscode from "vscode";
import { getLogger } from "../utils/logger";
import { resolveSshBinary } from "./sshTunnel";
import { decodeSshAuthority } from "./containerProxy";
import {
  batchModeArgs,
  sshEnvForAskpass,
  startAskpass,
  type AskpassHandle,
} from "../ssh/askpass";

export interface RemoteExecResult {
  stdout: string;
  stderr: string;
  code: number | null;
}

export interface RemoteExec {
  run(cmd: string, opts?: { stdin?: string; timeout?: number }): Promise<RemoteExecResult>;
  streamToStdin(cmd: string, input: NodeJS.ReadableStream): Promise<void>;
}

/**
 * Ssh-backed RemoteExec. Spawns `ssh user@host <cmd>` with askpass env
 * when available, BatchMode=yes otherwise.
 */
export class SshRemoteExec implements RemoteExec {
  private readonly sshBinary: string;
  private readonly target: string;
  private readonly sshPort: number;
  private readonly askpass?: AskpassHandle;

  constructor(authority: string, askpass?: AskpassHandle) {
    const ssh = decodeSshAuthority(authority);
    if (!ssh) {
      throw new Error(`Cannot decode SSH authority: ${authority}`);
    }
    this.sshBinary = resolveSshBinary();
    this.target = `${ssh.sshUser}@${ssh.sshHost}`;
    this.sshPort = ssh.sshPort;
    this.askpass = askpass;
  }

  /** Args for the ssh target: `-p port` only when not the default. */
  private targetArgs(): string[] {
    return this.sshPort !== 22 ? ["-p", String(this.sshPort)] : [];
  }

  run(
    cmd: string,
    opts?: { stdin?: string; timeout?: number },
  ): Promise<RemoteExecResult> {
    const { stdinInput, timeoutMs } = {
      stdinInput: opts?.stdin,
      // When askpass is active, the user may need time to respond to a
      // password prompt. Enforce a 120s minimum so ssh isn't killed
      // before they finish typing.
      timeoutMs: Math.max(opts?.timeout ?? 15_000, this.askpass ? 120_000 : 0),
    };

    return new Promise((resolve, reject) => {
      const proc = spawn(
        this.sshBinary,
        [...batchModeArgs(!!this.askpass), ...this.targetArgs(), this.target, cmd],
        {
          stdio: [stdinInput !== undefined ? "pipe" : "ignore", "pipe", "pipe"],
          env: sshEnvForAskpass(this.askpass),
        },
      );
      const timer = setTimeout(() => {
        proc.kill("SIGKILL");
        reject(new Error(`ssh command timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      let stdout = "";
      let stderr = "";
      proc.stdout?.on("data", (d: Buffer) => (stdout += d.toString()));
      proc.stderr?.on("data", (d: Buffer) => (stderr += d.toString()));
      proc.on("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
      proc.on("exit", (code) => {
        clearTimeout(timer);
        resolve({ stdout, stderr, code });
      });
      if (stdinInput !== undefined && proc.stdin) {
        proc.stdin.on("error", () => {
          // ignore; exit/error handlers will reject
        });
        proc.stdin.write(stdinInput);
        proc.stdin.end();
      }
    });
  }

  async streamToStdin(cmd: string, input: NodeJS.ReadableStream): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const proc = spawn(
        this.sshBinary,
        [...batchModeArgs(!!this.askpass), ...this.targetArgs(), this.target, cmd],
        {
          stdio: ["pipe", "pipe", "pipe"],
          env: sshEnvForAskpass(this.askpass),
        },
      );
      let stderrBuf = "";
      proc.stderr?.on("data", (d: Buffer) => {
        stderrBuf += d.toString();
      });

      input.on("error", (err) => {
        proc.kill();
        reject(new Error(`input stream error: ${err.message}`));
      });
      input.pipe(proc.stdin);

      proc.on("exit", (code) => {
        if (code === 0) {
          resolve();
        } else {
          reject(
            new Error(`stream failed (ssh exit=${code}) stderr: ${stderrBuf}`),
          );
        }
      });
      proc.on("error", (err) => {
        reject(new Error(`ssh spawn error: ${err.message}`));
      });
    });
  }
}

/**
 * ExecServer-backed RemoteExec. Uses vscode.workspace.getRemoteExecServer()
 * to spawn commands on the remote through the resolver's already-authenticated
 * connection. No ssh binary, no askpass, no password prompt.
 */
/** Minimal interface for the proposed ExecServer API. */
interface ExecServer {
  spawn(cmd: string, args: string[], opts?: Record<string, unknown>): Promise<ExecServerProc>;
  env(): Promise<{ env: Record<string, string> }>;
  kill(pid: number): Promise<void>;
}

/** Process handle from ExecServer.spawn(). */
interface ExecServerProc {
  stdin: { write(data: Uint8Array): void; end(): void };
  stdout: { onDidReceiveMessage(cb: (data: Uint8Array) => void): void };
  stderr: { onDidReceiveMessage(cb: (data: Uint8Array) => void): void };
  onExit: Promise<{ status: number | null; signal: string | null }>;
  kill(signal: string): void;
}

class ExecServerRemoteExec implements RemoteExec {
  /** The ExecServer object from getRemoteExecServer(). */
  private readonly execServer: ExecServer;

  constructor(execServer: unknown) {
    this.execServer = execServer as ExecServer;
  }

  async run(
    cmd: string,
    opts?: { stdin?: string; timeout?: number },
  ): Promise<RemoteExecResult> {
    const timeoutMs = opts?.timeout ?? 15_000;

    const proc = await this.execServer.spawn("sh", ["-c", cmd]);
    let stdout = "";
    let stderr = "";
    proc.stdout.onDidReceiveMessage((data: Uint8Array) => {
      stdout += Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString();
    });
    proc.stderr.onDidReceiveMessage((data: Uint8Array) => {
      stderr += Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString();
    });
    if (opts?.stdin !== undefined) {
      proc.stdin.write(new TextEncoder().encode(opts.stdin));
      proc.stdin.end();
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const exit = await Promise.race([
        proc.onExit,
        new Promise<{ status: number | null; signal: string | null }>((_resolve, reject) => {
          timer = setTimeout(() => {
            try { proc.kill("SIGKILL"); } catch { /* best effort */ }
            reject(new Error(`ExecServer command timed out after ${timeoutMs}ms`));
          }, timeoutMs);
        }),
      ]);
      return { stdout, stderr, code: exit.status };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async streamToStdin(cmd: string, input: NodeJS.ReadableStream): Promise<void> {
    const proc = await this.execServer.spawn("sh", ["-c", cmd]);
    let stderrBuf = "";
    proc.stderr.onDidReceiveMessage((data: Uint8Array) => {
      stderrBuf += Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString();
    });
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const settle = (err: Error) => {
        if (settled) return;
        settled = true;
        try { proc.kill("SIGKILL"); } catch { /* best effort */ }
        reject(err);
      };
      input.on("data", (chunk: Buffer) => {
        proc.stdin.write(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength));
      });
      input.on("end", () => proc.stdin.end());
      input.on("error", (err) => {
        settle(new Error(`input stream error: ${err.message}`));
      });
      proc.onExit.then((exit) => {
        if (settled) return;
        if (exit.status !== 0) {
          settle(new Error(`stream failed (exit=${exit.status}) stderr: ${stderrBuf}`));
        } else {
          resolve();
        }
      }).catch((err) => {
        settle(err instanceof Error ? err : new Error(String(err)));
      });
    });
  }
}

/** Result from getRemoteExec: the exec impl plus an optional askpass handle
 * that the caller must stop in a finally block. */
export interface RemoteExecHandle {
  exec: RemoteExec;
  /** Askpass handle, or undefined when using ExecServer (no askpass needed). */
  askpass?: AskpassHandle;
}

/**
 * Factory: detect ExecServer via the proposed API. If available, return an
 * ExecServer-backed exec (no ssh, no askpass). Otherwise fall back to
 * SshRemoteExec with askpass.
 *
 * The authority is the raw ssh-remote authority string.
 */
export async function getRemoteExec(
  authority: string,
  extensionPath: string,
  opts?: { title?: string; modalPrompt?: boolean },
): Promise<RemoteExecHandle> {
  const log = getLogger();

  // Try the proposed ExecServer API.
  log.info(`sideload: checking getRemoteExecServer for authority: ${authority}`);
  try {
    const getExecServer = (vscode.workspace as unknown as {
      getRemoteExecServer?: (authority: string) => Promise<ExecServer | undefined>;
    }).getRemoteExecServer;
    if (typeof getExecServer !== "function") {
      log.info("sideload: getRemoteExecServer API not available (not a function)");
    } else {
      const execServer = await getExecServer.call(vscode.workspace, authority);
      if (execServer) {
        const hasSpawn = typeof execServer.spawn === "function";
        log.info(
          `sideload: ExecServer available (spawn=${hasSpawn}), using it for remote exec`,
        );
        return { exec: new ExecServerRemoteExec(execServer) };
      }
      log.info("sideload: getRemoteExecServer returned undefined, falling back to ssh");
    }
  } catch (err) {
    log.info(
      `sideload: getRemoteExecServer threw (${err instanceof Error ? err.message : String(err)}), falling back to ssh`,
    );
  }

  // Fallback: ssh + askpass.
  const sshInfo = decodeSshAuthority(authority);
  const askpassTitle = sshInfo
    ? `Artizo: SSH password for ${sshInfo.sshHost}`
    : "Artizo: SSH password";
  const askpass = await startAskpass(extensionPath, {
    title: opts?.title ?? askpassTitle,
    modalPrompt: opts?.modalPrompt ?? true,
  });
  return { exec: new SshRemoteExec(authority, askpass), askpass };
}
