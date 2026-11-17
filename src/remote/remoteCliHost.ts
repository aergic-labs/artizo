/*
 * Copyright (c) 2026 Aergic Labs, LLC
 * SPDX-License-Identifier: AGPL-3.0-only
 */

/**
 * Implements the vendored devcontainers CLI's `CLIHost` against an SSH-host
 * ExecServer, so the CLI (and `readResolvedConfig`) run from the apex but act
 * on the SSH host.
 *
 * - exec: ExecServer.spawn, adapted to the CLI's `Exec` (Node streams).
 * - ptyExec: plainExecAsPtyExec (no pty), matching the esbuild node-pty no-op.
 * - file ops: ExecServer.fs.
 * - terminate: close stdin. The Go agent will add real reaping.
 */

import * as path from "node:path";
import { type Readable, type Writable } from "node:stream";
import { URI } from "vscode-uri";
import { toDockerProcess } from "../utils/dockerUtils";
import { getLogger } from "../utils/logger";
import { getOrCreateAgent, type AgentClient } from "./agentClient";
import type { ExecServer, RemoteFs, SpawnedCommand } from "./execServerBridge";

/** The subset of the vendored `CLIHost` this implements. */
export interface RemoteCliHost {
  type: "ssh";
  platform: NodeJS.Platform;
  arch: NodeJS.Architecture;
  exec: (params: ExecParams) => Promise<ExecHandle>;
  ptyExec: (params: unknown) => Promise<unknown>;
  cwd: string;
  env: NodeJS.ProcessEnv;
  path: typeof path.posix;
  homedir(): Promise<string>;
  tmpdir(): Promise<string>;
  isFile(p: string): Promise<boolean>;
  isFolder(p: string): Promise<boolean>;
  readFile(p: string): Promise<Buffer>;
  writeFile(p: string, content: Buffer): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  mkdirp(dir: string): Promise<void>;
  readDir(dir: string): Promise<string[]>;
  readDirWithTypes?(dir: string): Promise<Array<[string, number]>>;
  getUsername(): Promise<string>;
  getuid?: () => Promise<number>;
  getgid?: () => Promise<number>;
  toCommonURI(filePath: string): Promise<URI | undefined>;
  connect(socketPath: string): never;
  reconnect?(): Promise<void>;
  terminate?(): Promise<void>;
}

interface ExecParams {
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  cmd: string;
  args?: string[];
  stdio?: unknown;
  output?: unknown;
}

interface ExecHandle {
  stdin: Writable;
  stdout: Readable;
  stderr: Readable;
  exit: Promise<{ code: number | null; signal: string | null }>;
  terminate(): Promise<void>;
}

const cache = new WeakMap<ExecServer, Map<string, Promise<RemoteCliHost>>>();

let hostSeq = 0;
const execServerIds = new WeakMap<object, number>();
let execSeq = 0;
/** In-flight remote reads, to expose overlap between our reads and the CLI's. */
let readsInFlight = 0;

function execServerTag(es: object): number {
  let id = execServerIds.get(es);
  if (id === undefined) {
    id = ++execSeq;
    execServerIds.set(es, id);
  }
  return id;
}

/** Short caller trace so reads/execs can be attributed to a CLI site. */
function callerTrace(): string {
  const lines = (new Error().stack ?? "").split("\n").slice(1);
  const keep = lines
    .map((l) => l.trim())
    .filter(
      (l) =>
        !l.includes("remoteCliHost") &&
        !l.includes("at async " + "readAll") &&
        !l.includes("node:internal"),
    )
    .slice(0, 3);
  return keep.join(" <- ");
}

/** Build (or reuse) a RemoteCliHost for `cwd` on this ExecServer. */
export function getOrCreateRemoteCliHost(
  execServer: ExecServer,
  cwd: string,
): Promise<RemoteCliHost> {
  let byCwd = cache.get(execServer);
  if (!byCwd) {
    byCwd = new Map();
    cache.set(execServer, byCwd);
  }
  let pending = byCwd.get(cwd);
  if (!pending) {
    pending = createRemoteCliHost(execServer, cwd);
    byCwd.set(cwd, pending);
  }
  return pending;
}

export async function createRemoteCliHost(
  execServer: ExecServer,
  cwd: string,
): Promise<RemoteCliHost> {
  const remoteFs = execServer.fs;
  // ExecServer methods are class methods on the other side; calling a
  // destructured reference loses `this`.
  const spawn = execServer.spawn?.bind(execServer);
  if (!remoteFs || !spawn) {
    throw new Error("ExecServer is missing fs/spawn; cannot build RemoteCliHost");
  }

  const envInfo = await execServer.env?.();
  const env = (envInfo?.env ?? {}) as NodeJS.ProcessEnv;
  const platform = (envInfo?.osPlatform ?? "linux") as NodeJS.Platform;
  const hostId = ++hostSeq;
  const esTag = execServerTag(execServer);
  const arch = normalizeArch(await runCapture(execServer, "uname", ["-m"]));
  const uid = parseId(await runCapture(execServer, "id", ["-u"]));
  const gid = parseId(await runCapture(execServer, "id", ["-g"]));

  // Preferred: the Go agent, which holds the process handles so terminate()
  // is real. Fallback: ExecServer.spawn, where terminate() closes stdin.
  const agent = await getOrCreateAgent(execServer);

  getLogger().info(
    `[cliHost] RemoteCliHost#${hostId} execServer#${esTag} cwd=${cwd} platform=${platform} arch=${arch} home=${env.HOME ?? "(none)"} agent=${agent ? "yes" : "no"}`,
  );

  const exec = async (params: ExecParams): Promise<ExecHandle> => {
      const merged = params.env ? { ...env, ...params.env } : env;
      getLogger().info(
        `[cliHost] #${hostId} exec ${params.cmd} ${(params.args ?? []).join(" ")} (cwd=${params.cwd ?? cwd})`,
      );
      if (agent) {
        return agentExec(agent, params.cmd, params.args ?? [], params.cwd ?? cwd, merged);
      }
      const spawned = await spawn(params.cmd, params.args ?? [], {
        cwd: params.cwd ?? cwd,
        env: merged,
      });
      return wrapExec(spawned);
    };
  // Built lazily: only the docker-build path uses ptyExec, and requiring the
  // vendored commonUtils is deferred so callers that never build (and tests)
  // don't load the vendor.
  const ptyExec = (params: unknown) =>
    loadPlainExecAsPtyExec()(exec as never, false)(params as never);

  return {
    type: "ssh",
    platform,
    arch,
    exec,
    ptyExec,
    cwd,
    env,
    path: path.posix,
    homedir: async () => env.HOME ?? "/root",
    tmpdir: async () => "/tmp",
    isFile: async (p) => {
      const res = (await remoteFs.stat(p)).type === 1;
      getLogger().info(`[cliHost] #${hostId} isFile ${p} -> ${res}`);
      return res;
    },
    isFolder: async (p) => (await remoteFs.stat(p)).type === 2,
    readFile: async (p) => {
      const started = Date.now();
      try {
        const buf = await readAll(remoteFs, p, `#${hostId}/es#${esTag}`);
        getLogger().info(
          `[cliHost] #${hostId} readFile ${p} -> ${buf.length} bytes in ${Date.now() - started}ms :: ${callerTrace()}`,
        );
        return buf;
      } catch (err: unknown) {
        getLogger().warn(
          `[cliHost] #${hostId} readFile ${p} failed after ${Date.now() - started}ms: ${err instanceof Error ? err.message : String(err)} :: ${callerTrace()}`,
        );
        throw err;
      }
    },
    writeFile: (p, content) => writeAll(remoteFs, p, content),
    rename: (from, to) => remoteFs.rename(from, to),
    mkdirp: (dir) => remoteFs.mkdirp(dir),
    readDir: async (dir) => (await remoteFs.readdir(dir)).map((e) => e.name),
    readDirWithTypes: async (dir) =>
      (await remoteFs.readdir(dir)).map((e) => [e.name, e.type] as [string, number]),
    getUsername: async () => env.USER ?? env.LOGNAME ?? "root",
    getuid: uid !== undefined ? async () => uid : undefined,
    getgid: gid !== undefined ? async () => gid : undefined,
    toCommonURI: async (p) => URI.file(p),
    connect: () => {
      throw new Error("RemoteCliHost.connect is not used");
    },
  };
}

function agentExec(
  agent: AgentClient,
  cmd: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
): ExecHandle {
  return agent.exec({
    cmd,
    args,
    cwd,
    env: env as Record<string, string>,
  });
}

function wrapExec(spawned: SpawnedCommand): ExecHandle {
  const proc = toDockerProcess(spawned);
  const exit = new Promise<{
    code: number | null;
    signal: string | null;
  }>((resolve) => {
    proc.on("exit", (code) => resolve({ code, signal: null }));
    proc.on("error", () => resolve({ code: 1, signal: null }));
  });
  return {
    stdin: proc.stdin as Writable,
    stdout: proc.stdout as Readable,
    stderr: proc.stderr as Readable,
    exit,
    terminate: async () => {
      try {
        proc.kill();
      } catch {
        /* best effort */
      }
    },
  };
}

async function readAll(
  remoteFs: RemoteFs,
  p: string,
  tag = "",
): Promise<Buffer> {
  readsInFlight++;
  const started = Date.now();
  // What the host thinks the file is right now: size/mtime prove whether the
  // content is there at read time and whether it changed between reads.
  let statInfo = "stat? ";
  try {
    const st = await remoteFs.stat(p);
    statInfo = `type=${st.type} size=${st.size} mtime=${st.mtime}`;
  } catch (err: unknown) {
    statInfo = `stat failed: ${err instanceof Error ? err.message : String(err)}`;
  }
  getLogger().info(
    `[cliHost] readAll${tag} ${p}: start (${statInfo}, inFlight=${readsInFlight})`,
  );

  try {
    const stream = await remoteFs.read(p);
    const chunks: Uint8Array[] = [];
    stream.onDidReceiveMessage((d) => chunks.push(d));
    getLogger().info(
      `[cliHost] readAll${tag} ${p}: stream open at +${Date.now() - started}ms, ${chunks.length} chunks so far`,
    );
    await stream.onEnd;
    const total = chunks.reduce((n, c) => n + c.byteLength, 0);
    getLogger().info(
      `[cliHost] readAll${tag} ${p}: ended at +${Date.now() - started}ms with ${chunks.length} chunks, ${total} bytes`,
    );
    return Buffer.concat(chunks);
  } finally {
    readsInFlight--;
  }
}

async function writeAll(
  remoteFs: RemoteFs,
  p: string,
  content: Buffer,
): Promise<void> {
  const { stream, done } = await remoteFs.write(p);
  stream.write(new Uint8Array(content));
  stream.end();
  await done;
}

async function runCapture(
  execServer: ExecServer,
  cmd: string,
  args: string[],
): Promise<string | undefined> {
  const spawn = execServer.spawn?.bind(execServer);
  if (!spawn) return undefined;
  try {
    const spawned = await spawn(cmd, args);
    const chunks: Uint8Array[] = [];
    spawned.stdout.onDidReceiveMessage((d) => chunks.push(d));
    spawned.stderr.onDidReceiveMessage(() => {});
    const exit = await spawned.onExit;
    if (exit.status !== 0) return undefined;
    return Buffer.concat(chunks).toString("utf-8").trim();
  } catch {
    return undefined;
  }
}

function normalizeArch(uname: string | undefined): NodeJS.Architecture {
  switch ((uname ?? "").trim()) {
    case "x86_64":
    case "amd64":
      return "x64";
    case "aarch64":
    case "arm64":
      return "arm64";
    case "armv7l":
    case "armv6l":
      return "arm";
    case "i386":
    case "i686":
      return "ia32";
    default:
      return ((uname ?? "").trim() || "x64") as NodeJS.Architecture;
  }
}

function parseId(raw: string | undefined): number | undefined {
  if (raw === undefined || !/^\d+$/.test(raw)) return undefined;
  return Number(raw);
}

function loadPlainExecAsPtyExec(): (
  exec: (params: unknown) => Promise<unknown>,
  allowInheritTTY: boolean,
) => (params: unknown) => Promise<unknown> {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const mod = require("../../vendor/devcontainers-cli/src/spec-common/commonUtils");
  return mod.plainExecAsPtyExec;
}