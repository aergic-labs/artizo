/*
 * Copyright (c) 2026 Aergic Labs, LLC
 * SPDX-License-Identifier: AGPL-3.0-only
 */

/** Utility functions for Docker via child_process. */

import {
  execFile,
  spawn,
  type SpawnOptions,
  type ExecFileException,
} from "node:child_process";
import type { Socket } from "node:net";
import { EventEmitter } from "node:events";
import { PassThrough, Writable, type Readable } from "node:stream";
import { getDockerPath } from "../docker/execPolicy.js";
import { getActiveExecServer } from "../remote/execServerCache";
import type {
  ExecServer,
  SpawnedCommand,
} from "../remote/execServerBridge";

export interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/**
 * Minimal child-process shape used by the docker spawn/pipe helpers. Backed by
 * a real `ChildProcess` locally, or by an ExecServer `SpawnedCommand` remotely.
 */
export interface DockerProcess {
  stdin: Writable | null;
  stdout: Readable | null;
  stderr: Readable | null;
  on(
    event: "exit" | "close",
    listener: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): DockerProcess;
  on(event: "error", listener: (err: Error) => void): DockerProcess;
  kill(signal?: NodeJS.Signals | number): boolean;
}

/** Wrap an ExecServer SpawnedCommand in the DockerProcess shape. */
class ExecServerProcess implements DockerProcess {
  private readonly emitter = new EventEmitter();
  readonly stdin: Writable;
  readonly stdout: PassThrough;
  readonly stderr: PassThrough;

  constructor(private readonly spawned: SpawnedCommand) {
    this.stdin = new Writable({
      write: (chunk, _enc, cb) => {
        try {
          spawned.stdin.write(new Uint8Array(chunk));
          cb();
        } catch (err) {
          cb(err as Error);
        }
      },
      final: (cb) => {
        try {
          spawned.stdin.end();
          cb();
        } catch (err) {
          cb(err as Error);
        }
      },
    });
    this.stdout = new PassThrough();
    this.stderr = new PassThrough();
    spawned.stdout.onDidReceiveMessage((d) => this.stdout.write(Buffer.from(d)));
    spawned.stderr.onDidReceiveMessage((d) => this.stderr.write(Buffer.from(d)));
    void spawned.stdout.onEnd.then(() => this.stdout.end());
    void spawned.stderr.onEnd.then(() => this.stderr.end());
    void spawned.onExit
      .then((e) => {
        this.stdout.end();
        this.stderr.end();
        this.emitter.emit("exit", e.status, null);
        this.emitter.emit("close", e.status, null);
      })
      .catch((err: unknown) => {
        this.emitter.emit(
          "error",
          err instanceof Error ? err : new Error(String(err)),
        );
      });
  }

  on(
    event: "exit" | "close",
    listener: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): DockerProcess;
  on(event: "error", listener: (err: Error) => void): DockerProcess;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  on(event: string, listener: (...args: any[]) => void): DockerProcess {
    this.emitter.on(event, listener);
    return this;
  }

  kill(): boolean {
    try {
      this.spawned.stdin.end();
    } catch {
      /* best effort */
    }
    return true;
  }
}

/** Wrap an ExecServer SpawnedCommand in the DockerProcess shape. */
export function toDockerProcess(spawned: SpawnedCommand): DockerProcess {
  return new ExecServerProcess(spawned);
}

export interface DockerExecOptions {
  dockerPath?: string;
  user?: string;
  workdir?: string;
  interactive?: boolean;
}

export interface ContainerInfo {
  id: string;
  name: string;
  state: {
    status: string;
    running: boolean;
    pid: number;
  };
  config: {
    image: string;
    labels: Record<string, string>;
    env: string[];
    workingDir: string;
    user: string;
  };
  mounts: Array<{
    type: string;
    source: string;
    destination: string;
    mode: string;
  }>;
  networkSettings: {
    ports: Record<string, Array<{ hostIp: string; hostPort: string }> | null>;
  };
}

/** Raw mount entry from `docker inspect` JSON. */
interface DockerMountRaw {
  Type: string;
  Source: string;
  Destination: string;
  Mode: string;
}

/** Image-level architecture fields from `docker inspect <image>`. */
export interface ImagePlatformInfo {
  architecture: string;
  os: string;
  variant?: string;
}

/**
 * Inspect an image by ID or name. Returns architecture fields that
 * container inspect does not provide. These are the resolved platform
 * of the built image - accounts for Dockerfile FROM, --platform, and
 * daemon defaults.
 */
export async function dockerInspectImage(
  imageRef: string,
  options?: { dockerPath?: string },
): Promise<ImagePlatformInfo> {
  const docker = options?.dockerPath ?? getDockerPath();
  const result = await execFilePromise(docker, ["inspect", imageRef]);

  if (result.exitCode !== 0) {
    throw new Error(
      `docker inspect (image) failed (exit ${result.exitCode}): ${result.stderr}`,
    );
  }

  const parsed = JSON.parse(result.stdout);
  const raw = Array.isArray(parsed) ? parsed[0] : parsed;

  return {
    architecture: raw.Architecture ?? "",
    os: raw.Os ?? "",
    variant: raw.Variant || undefined,
  };
}

export async function dockerExec(
  containerId: string,
  command: string[],
  options?: DockerExecOptions,
): Promise<ExecResult> {
  const docker = options?.dockerPath ?? getDockerPath();
  const args: string[] = ["exec"];

  if (options?.user) {
    args.push("-u", options.user);
  }

  if (options?.workdir) {
    args.push("-w", options.workdir);
  }

  if (options?.interactive) {
    args.push("-i");
  }

  args.push(containerId, ...command);

  return execFilePromise(docker, args);
}

export async function dockerInspect(
  containerId: string,
  options?: { dockerPath?: string },
): Promise<ContainerInfo> {
  const docker = options?.dockerPath ?? getDockerPath();
  const result = await execFilePromise(docker, ["inspect", containerId]);

  if (result.exitCode !== 0) {
    throw new Error(
      `docker inspect failed (exit ${result.exitCode}): ${result.stderr}`,
    );
  }

  const parsed = JSON.parse(result.stdout);
  const raw = Array.isArray(parsed) ? parsed[0] : parsed;

  return {
    id: raw.Id,
    name: (raw.Name || "").replace(/^\//, ""),
    state: {
      status: raw.State?.Status ?? "",
      running: raw.State?.Running ?? false,
      pid: raw.State?.Pid ?? 0,
    },
    config: {
      image: raw.Config?.Image ?? "",
      // Always an object from both docker and podman-compat (verified live
      // against podman 5.4.2, 2026-07-29). Do not add string handling.
      labels: raw.Config?.Labels ?? {},
      env: raw.Config?.Env ?? [],
      workingDir: raw.Config?.WorkingDir ?? "",
      user: raw.Config?.User ?? "root",
    },
    mounts: (raw.Mounts || []).map((m: DockerMountRaw) => ({
      type: m.Type,
      source: m.Source,
      destination: m.Destination,
      mode: m.Mode,
    })),
    networkSettings: {
      ports: raw.NetworkSettings?.Ports ?? {},
    },
  };
}

export async function isContainerRunning(
  containerId: string,
  options?: { dockerPath?: string },
): Promise<boolean> {
  try {
    const info = await dockerInspect(containerId, options);
    return info.state.running;
  } catch {
    return false;
  }
}

/**
 * Return a spawned child's stdio pipes, asserting they exist. `spawn` with
 * `stdio: ['pipe','pipe','pipe']` always creates them, but the types are
 * nullable (they'd be null for 'ignore'/'inherit'), so this turns a would-be
 * bare NPE into a descriptive error if stdio is ever misconfigured or the
 * process fails to expose its pipes.
 */
export function childPipes(child: DockerProcess): {
  stdin: NonNullable<DockerProcess["stdin"]>;
  stdout: NonNullable<DockerProcess["stdout"]>;
  stderr: NonNullable<DockerProcess["stderr"]>;
} {
  if (!child.stdin || !child.stdout || !child.stderr) {
    throw new Error(
      "Child process stdio pipes are unavailable (spawn failed or stdio was not 'pipe')",
    );
  }
  return { stdin: child.stdin, stdout: child.stdout, stderr: child.stderr };
}

// Pipe a local socket bidirectionally to a docker exec child process.
// Cleans up on both sides.
export function pipeDockerRelay(child: DockerProcess, socket: Socket): void {
  // With stdio 'pipe' these are always present; guard defensively so a
  // misconfigured/failed spawn tears the relay down cleanly rather than
  // throwing a bare NPE inside the connection handler.
  if (!child.stdin || !child.stdout) {
    try {
      child.kill("SIGTERM");
    } catch {
      /* already dead */
    }
    socket.destroy();
    return;
  }
  socket.pipe(child.stdin);
  child.stdout.pipe(socket);

  socket.on("close", () => {
    try {
      child.kill("SIGTERM");
    } catch {
      /* already dead */
    }
  });

  child.on("error", () => {
    try {
      socket.destroy();
    } catch {
      /* already closed */
    }
  });

  child.on("exit", () => {
    try {
      socket.destroy();
    } catch {
      /* already closed */
    }
  });
}

// TCP relay: connects to container port, relays stdin/stdout.
export function tcpRelayScript(port: number): string {
  return `const n=require("net"),c=n.createConnection(${port},"127.0.0.1",()=>{process.stdin.pipe(c);c.pipe(process.stdout);process.stdin.resume()});c.on("error",()=>process.exit(1));c.on("close",()=>process.exit(0));process.stdin.on("close",()=>process.exit(0))`;
}

export async function dockerSpawn(
  dockerPath: string | undefined,
  args: string[],
  options?: SpawnOptions,
): Promise<DockerProcess> {
  const execServer = getActiveExecServer();
  if (execServer?.spawn) {
    const spawned = await execServer.spawn(
      dockerPath ?? getDockerPath(),
      args,
      options?.cwd ? { cwd: options.cwd } : undefined,
    );
    return new ExecServerProcess(spawned);
  }
  return spawn(dockerPath ?? getDockerPath(), args, options ?? {});
}

export function execFilePromise(
  command: string,
  args: string[],
  options?: { cwd?: string },
): Promise<ExecResult> {
  // Remote tier: run on the SSH host through the ExecServer. Local tier falls
  // through to execFile.
  const execServer = getActiveExecServer();
  if (execServer?.spawn) {
    return execViaExecServer(execServer, command, args, options?.cwd);
  }
  return new Promise((resolve) => {
    execFile(
      command,
      args,
      options ?? {},
      (error: ExecFileException | null, stdout: string, stderr: string) => {
        if (error) {
          // `error.code` is the numeric exit code (or a string like "ENOENT"
          // for spawn failures). Use 1 as the failure sentinel for non-numeric,
          // and surface the real message in stderr so callers don't see an
          // empty cause (e.g. "Failed to start container <id>" with no hint).
          const numericCode = typeof error.code === "number" ? error.code : 1;
          const errorStderr =
            typeof error.code === "number"
              ? error.stderr ?? stderr ?? ""
              : `${error.message}${error.stderr ? "\n" + error.stderr : ""}`;
          resolve({
            exitCode: numericCode,
            stdout: error.stdout ?? stdout ?? "",
            stderr: errorStderr,
          });
        } else {
          resolve({ exitCode: 0, stdout: stdout ?? "", stderr: stderr ?? "" });
        }
      },
    );
  });
}

/** Run a command on the remote through the ExecServer, buffering output. */
async function execViaExecServer(
  execServer: ExecServer,
  command: string,
  args: string[],
  cwd?: string,
): Promise<ExecResult> {
  try {
    const spawned = await execServer.spawn!(command, args, cwd ? { cwd } : undefined);
    const outChunks: Uint8Array[] = [];
    const errChunks: Uint8Array[] = [];
    spawned.stdout.onDidReceiveMessage((d) => outChunks.push(d));
    spawned.stderr.onDidReceiveMessage((d) => errChunks.push(d));
    const exit = await spawned.onExit;
    return {
      exitCode: exit.status,
      stdout: Buffer.concat(outChunks).toString("utf-8"),
      stderr: Buffer.concat(errChunks).toString("utf-8"),
    };
  } catch (err: unknown) {
    // Spawn/transport failure: surface a non-zero exit with the message in
    // stderr, matching execFile's error shape.
    return {
      exitCode: 1,
      stdout: "",
      stderr: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function dockerVolumeCreate(
  name: string,
  options?: { dockerPath?: string; labels?: Record<string, string> },
): Promise<ExecResult> {
  const args: string[] = ["volume", "create", name];
  if (options?.labels) {
    for (const [k, v] of Object.entries(options.labels)) {
      args.push("--label", `${k}=${v}`);
    }
  }
  return execFilePromise(options?.dockerPath ?? getDockerPath(), args);
}

// Run a command in a temporary docker run --rm container.
export async function dockerRun(options: {
  image: string;
  command: string[];
  volumes?: Array<{ source: string; target: string }>;
  dockerPath?: string;
}): Promise<ExecResult> {
  const args: string[] = ["run", "--rm"];
  if (options.volumes) {
    for (const v of options.volumes) {
      args.push("-v", `${v.source}:${v.target}`);
    }
  }
  args.push(options.image, ...options.command);
  return execFilePromise(options.dockerPath ?? getDockerPath(), args);
}
