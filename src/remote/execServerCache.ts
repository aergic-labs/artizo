/*
 * Copyright (c) 2026 Aergic Labs, LLC
 * SPDX-License-Identifier: AGPL-3.0-only
 */

/**
 * Module-level cache for the active remote ExecServer.
 *
 * Set at activation in SSH-class windows (RemoteSSH, or the chained
 * devcontainer-over-SSH window's parent). Read by the docker exec helpers so
 * apex-side code drives Docker on the SSH host instead of the local machine.
 * Undefined in local windows.
 */

import type { ExecServer } from "./execServerBridge";

let _active: ExecServer | undefined;

export function setActiveExecServer(execServer: ExecServer | undefined): void {
  _active = execServer;
}

export function getActiveExecServer(): ExecServer | undefined {
  return _active;
}