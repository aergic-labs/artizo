/*
 * Copyright (c) 2026 Aergic Labs, LLC
 * SPDX-License-Identifier: AGPL-3.0-only
 */

/** Utility functions for Docker via child_process. */

import {
  execFile,
  spawn,
  type ChildProcess,
  type SpawnOptions,
} from "node:child_process";
import type { Socket } from "node:net";

export interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
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
  const docker = options?.dockerPath ?? "docker";
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
  const docker = options?.dockerPath ?? "docker";
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
  const docker = options?.dockerPath ?? "docker";
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
      labels: raw.Config?.Labels ?? {},
      env: raw.Config?.Env ?? [],
      workingDir: raw.Config?.WorkingDir ?? "",
    },
    mounts: (raw.Mounts || []).map((m: any) => ({
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

// Pipe a local socket bidirectionally to a docker exec child process.
// Cleans up on both sides.
export function pipeDockerRelay(child: ChildProcess, socket: Socket): void {
  socket.pipe(child.stdin!);
  child.stdout!.pipe(socket);

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

export function dockerSpawn(
  dockerPath: string | undefined,
  args: string[],
  options?: SpawnOptions,
): ChildProcess {
  return spawn(dockerPath ?? "docker", args, options ?? {});
}

export async function dockerCp(
  dockerPath: string | undefined,
  hostPath: string,
  containerId: string,
  containerPath: string,
): Promise<ExecResult> {
  return execFilePromise(dockerPath ?? "docker", [
    "cp",
    hostPath,
    `${containerId}:${containerPath}`,
  ]);
}

export function execFilePromise(
  command: string,
  args: string[],
): Promise<ExecResult> {
  return new Promise((resolve) => {
    execFile(command, args, (error: any, stdout: string, stderr: string) => {
      if (error) {
        resolve({
          exitCode: error.status ?? error.code ?? 1,
          stdout: error.stdout ?? stdout ?? "",
          stderr: error.stderr ?? stderr ?? "",
        });
      } else {
        resolve({ exitCode: 0, stdout: stdout ?? "", stderr: stderr ?? "" });
      }
    });
  });
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
  return execFilePromise(options?.dockerPath ?? "docker", args);
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
  return execFilePromise(options.dockerPath ?? "docker", args);
}
