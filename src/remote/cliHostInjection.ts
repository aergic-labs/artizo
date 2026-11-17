/*
 * Copyright (c) 2026 Aergic Labs, LLC
 * SPDX-License-Identifier: AGPL-3.0-only
 */

/**
 * Runs the vendored CLI against a RemoteCliHost for the duration of a call,
 * via the vendored `runWithCLIHost` seam (AsyncLocalStorage). No-op when no
 * ExecServer is active, so local windows keep the built-in local host.
 *
 * AsyncLocalStorage, rather than a process-global setter, is what makes
 * concurrent local/remote workflows safe: each async call chain sees its own
 * host.
 */

import { getLogger } from "../utils/logger";
import { getActiveExecServer } from "./execServerCache";
import { getOrCreateRemoteCliHost, type RemoteCliHost } from "./remoteCliHost";

function vendorRunWithCLIHost(): (<T>(host: unknown, fn: () => T) => T) | undefined {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require("../../vendor/devcontainers-cli/src/spec-common/cliHost");
    // Route the CLI's own host diagnostics into the Artizo log.
    if (typeof mod.setCLIHostLog === "function") {
      mod.setCLIHostLog((msg: string) => getLogger().info(`[cliHost] ${msg}`));
    }
    return typeof mod.runWithCLIHost === "function"
      ? mod.runWithCLIHost
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Run `fn` with the vendored CLI's CLIHost set to a remote host when an
 * ExecServer is active. The binding is scoped to the call chain, so concurrent
 * callers don't interfere.
 */
export async function withRemoteCliHost<T>(
  cwd: string,
  fn: () => Promise<T>,
): Promise<T> {
  const execServer = getActiveExecServer();
  if (!execServer) {
    getLogger().info(`[cliHost] no active ExecServer; local host (cwd=${cwd})`);
    return fn();
  }

  const runWith = vendorRunWithCLIHost();
  if (!runWith) {
    getLogger().warn(
      "[cliHost] vendored runWithCLIHost missing; CLI will use a local host",
    );
    return fn();
  }

  let host: RemoteCliHost;
  try {
    host = await getOrCreateRemoteCliHost(execServer, cwd);
  } catch (err: unknown) {
    getLogger().warn(
      `[cliHost] cannot build RemoteCliHost: ${err instanceof Error ? err.message : String(err)}`,
    );
    return fn();
  }

  getLogger().info(
    `[cliHost] running CLI with RemoteCliHost cwd=${cwd} platform=${host.platform}`,
  );
  return runWith(host, fn);
}