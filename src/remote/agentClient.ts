/*
 * Copyright (c) 2026 Aergic Labs, LLC
 * SPDX-License-Identifier: AGPL-3.0-only
 */

/**
 * Client for the remote CLI agent (go/artifact-agent).
 *
 * The agent holds child-process handles on the SSH host so the vendored CLI's
 * CLIHost can implement exec + real terminate over the ExecServer (whose
 * spawn has no pid). The binary ships in the VSIX and is written to
 * `$HOME/.artizo/agent/`; this module installs it, spawns it, and speaks the
 * frame protocol.
 */

import * as path from "node:path";
import { PassThrough, Writable, type Readable } from "node:stream";
import { getLogger } from "../utils/logger";
import type { ExecServer, SpawnedCommand } from "./execServerBridge";

const FRAME_EXEC = 1;
const FRAME_STDIN = 2;
const FRAME_STDIN_END = 3;
const FRAME_TERMINATE = 4;
const FRAME_SHUTDOWN = 6;
const FRAME_STDOUT = 101;
const FRAME_STDERR = 102;
const FRAME_EXIT = 103;
const FRAME_ERROR = 104;

export interface AgentExecParams {
  cmd: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
}

export interface AgentExecHandle {
  stdin: Writable;
  stdout: Readable;
  stderr: Readable;
  exit: Promise<{ code: number | null; signal: string | null }>;
  terminate(): Promise<void>;
}

interface Frame {
  type: number;
  id: number;
  payload: Buffer;
}

interface Pending {
  stdout: PassThrough;
  stderr: PassThrough;
  resolveExit: (v: { code: number | null; signal: string | null }) => void;
  rejectExit: (e: Error) => void;
  settled: boolean;
}

class FrameReader {
  private buf = Buffer.alloc(0);

  constructor(private readonly onFrame: (f: Frame) => void) {}

  push(chunk: Uint8Array): void {
    this.buf = Buffer.concat([this.buf, Buffer.from(chunk)]);
    while (this.buf.length >= 9) {
      const type = this.buf[0];
      const id = this.buf.readUInt32BE(1);
      const len = this.buf.readUInt32BE(5);
      if (this.buf.length < 9 + len) return;
      const payload = this.buf.subarray(9, 9 + len);
      this.buf = this.buf.subarray(9 + len);
      this.onFrame({ type, id, payload });
    }
  }
}

/** RPC client over a spawned agent process. */
export class AgentClient {
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly reader: FrameReader;
  private closed = false;

  constructor(
    private readonly proc: SpawnedCommand,
    private readonly log: (msg: string) => void = () => {},
  ) {
    this.reader = new FrameReader((f) => this.onFrame(f));
    this.proc.stdout.onDidReceiveMessage((d) => this.reader.push(d));
    this.proc.stderr.onDidReceiveMessage((d) =>
      this.log(`[agent] ${Buffer.from(d).toString("utf-8").trim()}`),
    );
    void this.proc.onExit.then((e) =>
      this.closeAll(new Error(`agent exited (${e.status})`)),
    );
  }

  exec(params: AgentExecParams): AgentExecHandle {
    if (this.closed) {
      throw new Error("agent is closed");
    }
    const id = this.nextId++;
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    let resolveExit!: (v: {
      code: number | null;
      signal: string | null;
    }) => void;
    let rejectExit!: (e: Error) => void;
    const exit = new Promise<{
      code: number | null;
      signal: string | null;
    }>((res, rej) => {
      resolveExit = res;
      rejectExit = rej;
    });
    this.pending.set(id, { stdout, stderr, resolveExit, rejectExit, settled: false });

    this.writeFrame(
      FRAME_EXEC,
      id,
      Buffer.from(
        JSON.stringify({
          cmd: params.cmd,
          args: params.args ?? [],
          cwd: params.cwd,
          env: params.env,
        }),
      ),
    );

    const stdin = new Writable({
      write: (chunk, _enc, cb) => {
        try {
          this.writeFrame(FRAME_STDIN, id, Buffer.from(chunk));
          cb();
        } catch (err) {
          cb(err as Error);
        }
      },
      final: (cb) => {
        try {
          this.writeFrame(FRAME_STDIN_END, id, Buffer.alloc(0));
          cb();
        } catch (err) {
          cb(err as Error);
        }
      },
    });

    return {
      stdin,
      stdout,
      stderr,
      exit,
      terminate: async () => {
        try {
          this.writeFrame(FRAME_TERMINATE, id, Buffer.alloc(0));
        } catch {
          /* closed */
        }
      },
    };
  }

  shutdown(): void {
    try {
      this.writeFrame(FRAME_SHUTDOWN, 0, Buffer.alloc(0));
    } catch {
      /* ignore */
    }
    try {
      this.proc.stdin.end();
    } catch {
      /* ignore */
    }
  }

  private writeFrame(type: number, id: number, payload: Buffer): void {
    const hdr = Buffer.alloc(9);
    hdr[0] = type;
    hdr.writeUInt32BE(id, 1);
    hdr.writeUInt32BE(payload.length, 5);
    this.proc.stdin.write(new Uint8Array(hdr));
    if (payload.length) this.proc.stdin.write(new Uint8Array(payload));
  }

  private onFrame(f: Frame): void {
    const p = this.pending.get(f.id);
    if (f.type === FRAME_STDOUT) {
      p?.stdout.write(f.payload);
      return;
    }
    if (f.type === FRAME_STDERR) {
      p?.stderr.write(f.payload);
      return;
    }
    if (f.type === FRAME_EXIT) {
      this.settle(f.id, (entry) => {
        entry.stdout.end();
        entry.stderr.end();
        let code: number | null = 0;
        let signal: string | null = null;
        try {
          const j = JSON.parse(f.payload.toString("utf-8")) as {
            code?: unknown;
            signal?: unknown;
          };
          // The agent reports code null + signal for a signalled exit,
          // matching Node's child_process convention.
          code = typeof j.code === "number" ? j.code : null;
          signal = typeof j.signal === "string" ? j.signal : null;
        } catch {
          /* default exit */
        }
        entry.resolveExit({ code, signal });
      });
      return;
    }
    if (f.type === FRAME_ERROR) {
      this.settle(f.id, (entry) => {
        entry.stdout.end();
        entry.stderr.end();
        const raw = f.payload.toString("utf-8");
        let msg = raw;
        try {
          const j = JSON.parse(raw) as { message?: unknown };
          if (typeof j.message === "string") msg = j.message;
        } catch {
          /* plain text */
        }
        entry.rejectExit(new Error(msg || "agent exec failed"));
      });
    }
  }

  private settle(id: number, fn: (p: Pending) => void): void {
    const p = this.pending.get(id);
    if (!p || p.settled) return;
    p.settled = true;
    this.pending.delete(id);
    fn(p);
  }

  private closeAll(err: Error): void {
    if (this.closed) return;
    this.closed = true;
    for (const [id, p] of this.pending) {
      p.settled = true;
      p.stdout.end();
      p.stderr.end();
      p.rejectExit(err);
      this.pending.delete(id);
    }
  }
}

let _extensionPath: string | undefined;

/** Set at activation so the agent binary can be located in the extension. */
export function setAgentExtensionPath(p: string | undefined): void {
  _extensionPath = p;
}

const agents = new WeakMap<ExecServer, Promise<AgentClient | undefined>>();

/**
 * Start (or reuse) the agent for this ExecServer. Returns undefined when the
 * agent is unavailable, so callers fall back to `ExecServer.spawn`.
 */
export function getOrCreateAgent(
  execServer: ExecServer,
): Promise<AgentClient | undefined> {
  const cached = agents.get(execServer);
  if (cached) return cached;
  const pending = startAgent(execServer).catch(() => undefined);
  agents.set(execServer, pending);
  return pending;
}

/**
 * Install and start the agent on the SSH host. Returns undefined when the
 * ExecServer lacks spawn/fs, the binary is missing, or install fails; callers
 * fall back to ExecServer.spawn.
 */
export async function startAgent(
  execServer: ExecServer,
  extensionPath: string = _extensionPath ?? "",
): Promise<AgentClient | undefined> {
  const spawn = execServer.spawn?.bind(execServer);
  const remoteFs = execServer.fs;
  if (!spawn || !remoteFs || !extensionPath) return undefined;
  const log = (msg: string) => getLogger().info(msg);

  const envInfo = await execServer.env?.();
  const home = envInfo?.env.HOME;
  if (!home) return undefined;

  const os = envInfo?.osPlatform === "darwin" ? "darwin" : "linux";
  const arch = await detectArch(execServer);
  if (!arch) return undefined;

  const localPath = path.join(
    extensionPath,
    "tools",
    "artifact-agent",
    `agent-${os}-${arch}`,
  );
  let bin: Buffer;
  try {
    const fs = await import("node:fs/promises");
    bin = await fs.readFile(localPath);
  } catch (err: unknown) {
    log(
      `[agent] binary not found at ${localPath}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return undefined;
  }

  const remoteDir = `${home}/.artizo/agent`;
  const remotePath = `${remoteDir}/agent-${os}-${arch}`;
  try {
    await remoteFs.mkdirp(remoteDir);
    const { stream, done } = await remoteFs.write(remotePath);
    stream.write(new Uint8Array(bin));
    stream.end();
    await done;
    const chmod = await spawn("chmod", ["+x", remotePath]);
    await chmod.onExit;
  } catch (err: unknown) {
    log(
      `[agent] install failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    return undefined;
  }

  try {
    const child = await spawn(remotePath, []);
    log(`[agent] started ${remotePath}`);
    return new AgentClient(child, log);
  } catch (err: unknown) {
    log(
      `[agent] spawn failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    return undefined;
  }
}

async function detectArch(
  execServer: ExecServer,
): Promise<"x64" | "arm64" | undefined> {
  const spawn = execServer.spawn?.bind(execServer);
  if (!spawn) return undefined;
  try {
    const p = await spawn("uname", ["-m"]);
    const chunks: Uint8Array[] = [];
    p.stdout.onDidReceiveMessage((d) => chunks.push(d));
    p.stderr.onDidReceiveMessage(() => {});
    const exit = await p.onExit;
    if (exit.status !== 0) return undefined;
    const uname = Buffer.concat(chunks).toString("utf-8").trim();
    if (uname === "x86_64" || uname === "amd64") return "x64";
    if (uname === "aarch64" || uname === "arm64") return "arm64";
    return undefined;
  } catch {
    return undefined;
  }
}