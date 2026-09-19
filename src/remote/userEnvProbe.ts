/*
 * Copyright (c) 2026 Aergic Labs, LLC
 * SPDX-License-Identifier: AGPL-3.0-only
 */

/**
 * User environment probe for the remote extension host (REH) inside
 * dev containers.
 *
 * `docker exec` gives the server whatever env the image baked in -
 * frequently a bare PATH, no locale, none of the user's dotfile
 * additions. The integrated terminal, tasks, and debug adapters inherit
 * the server's env, so a stripped server env means a stripped terminal.
 *
 * The probe runs the user's login shell once, captures the resulting env
 * (via `cat /proc/self/environ` with a nonce-marker protocol), and
 * returns it for injection into the server via `docker exec --env`.
 * The server is also started with `--force-disable-user-env` so it
 * doesn't do its own (worse) probe and clobber the injected env.
 *
 * Mirrors the vendored devcontainer CLI's `runUserEnvProbe`
 * (`injectHeadless.ts` L838-932) and MS Remote-Containers' `IW`
 * (`extension-beautified.js` L30526-30596), re-implemented here using
 * `Host.dockerExec` rather than the CLI's `ShellServer`/`ExecFunction`
 * abstractions (same approach as the probe-parsing nonce fix).
 */

import { randomUUID } from "node:crypto";
import type { Host } from "../host/host";
import { getLogger } from "../utils/logger";

export type UserEnvProbe =
  | "none"
  | "loginInteractiveShell"
  | "interactiveShell"
  | "loginShell";

export interface ProbeParams {
  host: Host;
  containerId: string;
  /** Resolved remoteUser/containerUser (runs the probe as this user). */
  user?: string;
  /** Login shell path (from `parseShellFromGetent` or `/bin/sh`). */
  shell: string;
  /** Probe mode from devcontainer.json or the default. */
  probe: UserEnvProbe;
  /** Container's current PATH (for `mergePaths`); from `probeContainer`. */
  containerPath?: string;
  /** Timeout in ms; default 10000. */
  timeoutMs?: number;
}

/**
 * Shell flag for a given probe mode. Matches the vendored CLI's
 * `runUserEnvProbe` (L859-864) and MS's `IW` (L30539-30540).
 */
export function shellFlag(probe: UserEnvProbe): string {
  switch (probe) {
    case "loginInteractiveShell":
      return "-lic";
    case "loginShell":
      return "-lc";
    case "interactiveShell":
      return "-ic";
    default:
      return "-c";
  }
}

/**
 * Parse the env output captured between nonce markers.
 *
 * `raw` is the full stdout from `<shell> <flag> 'echo -n <nonce>; <cmd>;
 * echo -n <nonce>'`. Everything between the two nonce occurrences is the
 * env dump (NUL-separated for `/proc/self/environ`, newline-separated
 * for `printenv`). Each entry is `KEY=VALUE`.
 *
 * `PWD` is deleted (matches the vendored CLI L913 and MS L30580).
 */
export function parseProbeOutput(
  raw: string,
  nonce: string,
  sep: string,
): Record<string, string> {
  const start = raw.indexOf(nonce);
  if (start === -1) return {};
  const afterStart = start + nonce.length;
  const end = raw.indexOf(nonce, afterStart);
  if (end === -1) return {};
  const body = raw.slice(afterStart, end);
  if (!body || body.trim() === `-n`) return {};
  const env: Record<string, string> = {};
  for (const entry of body.split(sep)) {
    const i = entry.indexOf("=");
    if (i !== -1) {
      env[entry.slice(0, i)] = entry.slice(i + 1);
    }
  }
  delete env.PWD;
  return env;
}

/**
 * Merge the probe's PATH with the container's PATH.
 *
 * Container PATH entries (from `ENV PATH=...` in the Dockerfile) are
 * prepended to the probe PATH so image-specific dirs like
 * `/usr/local/bin` come first. `sbin` entries are skipped for non-root
 * users (matches the vendored CLI's `mergePaths` L943-957 and MS's
 * `Yoe` L30604-30611).
 */
export function mergePaths(
  shellPath: string,
  containerPath: string,
  rootUser: boolean,
): string {
  const result = shellPath.split(":");
  let insertAt = 0;
  for (const entry of containerPath.split(":")) {
    const i = result.indexOf(entry);
    if (i === -1) {
      if (rootUser || !/\/sbin(\/|$)/.test(entry)) {
        result.splice(insertAt++, 0, entry);
      }
    } else {
      insertAt = i + 1;
    }
  }
  return result.join(":");
}

/**
 * Parse the login shell from a `getent passwd <user>` line.
 *
 * `getent passwd` returns `name:passwd:uid:gid:gecos:home:shell`.
 * Field 7 (index 6) is the login shell. Returns `undefined` if the
 * line is empty, too short, or has no shell field.
 */
export function parseShellFromGetent(getentLine: string): string | undefined {
  const fields = getentLine.trim().split(":");
  if (fields.length < 7) return undefined;
  const shell = fields[6].trim();
  return shell || undefined;
}

/**
 * Probe the user's login-shell environment inside the container.
 *
 * Runs `<shell> <flag> 'echo -n <nonce>; cat /proc/self/environ; echo -n
 * <nonce>'` as the resolved user, parses the env, merges PATHs, and
 * returns the env for injection. Falls back to `printenv` if
 * `/proc/self/environ` yields nothing. Never throws - on timeout or
 * error, logs and returns `{}` so the server still starts.
 */
export async function probeUserEnv(
  params: ProbeParams,
): Promise<Record<string, string>> {
  const {
    host,
    containerId,
    user,
    shell,
    probe,
    containerPath,
    timeoutMs = 10_000,
  } = params;

  if (probe === "none") return {};

  const nonce = randomUUID();
  const flag = shellFlag(probe);
  const log = getLogger();

  // cat /proc/self/environ is NUL-separated; printenv is newline-separated.
  const runWith = async (
    cmd: string,
    sep: string,
  ): Promise<Record<string, string> | undefined> => {
    const command = `echo -n ${nonce}; ${cmd}; echo -n ${nonce}`;
    try {
      const result = await host.dockerExec(
        containerId,
        [shell, flag, command],
        user ? { user } : undefined,
      );
      if (result.exitCode !== 0) return undefined;
      const env = parseProbeOutput(result.stdout, nonce, sep);
      return Object.keys(env).length > 0 ? env : undefined;
    } catch {
      return undefined;
    }
  };

  const timed = <T>(p: Promise<T>): Promise<T | undefined> =>
    Promise.race([
      p,
      new Promise<undefined>((resolve) =>
        setTimeout(() => resolve(undefined), timeoutMs),
      ),
    ]);

  try {
    let env = await timed(runWith("cat /proc/self/environ", "\0"));
    if (!env) {
      log.info("[userEnvProbe] /proc/self/environ empty; falling back to printenv");
      env = await timed(runWith("printenv", "\n"));
    }
    if (!env) {
      log.warn(
        `[userEnvProbe] produced no env within ${timeoutMs}ms; continuing with empty injection`,
      );
      return {};
    }

    // Merge PATH: container entries (e.g. /usr/local/bin from ENV) prepended
    // to the probe PATH, skipping sbin for non-root users.
    const shellPath = env.PATH;
    if (shellPath && containerPath) {
      env.PATH = mergePaths(shellPath, containerPath, user === "root" || user === "0");
    }
    return env;
  } catch (err) {
    log.warn(
      `[userEnvProbe] error: ${err instanceof Error ? err.message : String(err)}; continuing with empty injection`,
    );
    return {};
  }
}
