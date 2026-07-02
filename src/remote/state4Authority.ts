/*
 * Copyright (c) 2026 Aergic Labs, LLC
 * SPDX-License-Identifier: AGPL-3.0-only
 */

/**
 * Shared State 4 authority builder.
 *
 * Both `reopenInContainer` (artizo-container scheme) and `attachToContainer`
 * (attached-container scheme) need the same State 4 treatment when the
 * extension is running workspace-side on an SSH host: start a relay daemon
 * on the SSH host, encode a `ProxyAuthorityInfo` payload into the authority,
 * and let the apex-side resolver open an `ssh -L` tunnel back to the relay.
 *
 * This module extracts that logic so both workflows share one implementation.
 */

import { buildRemoteAuthority } from "../utils/uriUtils";
import { BRAND_PREFIX } from "../utils/constants";
import { getLogger } from "../utils/logger";
import { ExecutionTier } from "../host/state";
import {
  startRelayDaemon,
  decodeSshAuthority,
  type ProxyAuthorityInfo,
} from "./containerProxy";
import type { WorkflowUI } from "../workflows/types";

/**
 * Build the remote authority for a new container window.
 *
 * - **State 4** (`tier === RemoteSSH && owner === "workspace"`): start the
 *   relay daemon on the SSH host and encode a `ProxyAuthorityInfo` JSON
 *   payload into a bare `<scheme>+<hex>` authority. The apex-side resolver
 *   decodes the payload, opens an `ssh -L` tunnel to the relay, and returns
 *   `127.0.0.1:<localPort>` so the new window connects through the tunnel.
 * - **States 1-3**: emit a plain bare `<scheme>+<hex(id)>` authority; the
 *   apex-side resolver does Docker lookup locally.
 *
 * @param params.scheme      - `artizo-container` or `attached-container`
 * @param params.id          - States 1-3 id (workspace folder or container ID)
 * @param params.tier        - Detected execution tier
 * @param params.owner       - "workspace" | "ui" | "none"
 * @param params.remoteAuthority - The SSH authority (ssh-remote+<hex>)
 * @param params.containerId - Docker container ID
 * @param params.containerPort - Port server-main.js is listening on (container)
 * @param params.installPath - Server install path inside the container
 * @param params.connectionToken - Connection token from server-main.js
 * @param params.workspaceFolder - Host-side workspace folder (for "Reopen in Host")
 * @param params.workspacePath   - Container-side workspace path (e.g. /workspaces)
 * @param params.dockerPath   - Docker binary path on the SSH host
 * @param params.ui           - Workflow UI for build log messages
 */
export async function buildContainerAuthority(params: {
  scheme: "artizo-container" | "attached-container";
  id: string;
  tier: ExecutionTier;
  owner: "workspace" | "ui" | "none";
  remoteAuthority: string | undefined;
  containerId: string;
  containerPort: number;
  installPath: string;
  connectionToken: string | undefined;
  workspaceFolder: string;
  workspacePath: string;
  dockerPath: string;
  ui: WorkflowUI;
}): Promise<string> {
  const {
    scheme,
    id,
    tier,
    owner,
    remoteAuthority,
    containerId,
    containerPort,
    installPath,
    connectionToken,
    workspaceFolder,
    workspacePath,
    dockerPath,
    ui,
  } = params;

  const isState4 = tier === ExecutionTier.RemoteSSH && owner === "workspace";
  if (!isState4) {
    return buildRemoteAuthority(scheme, id);
  }

  const log = getLogger();

  const ssh = decodeSshAuthority(remoteAuthority);
  if (!ssh) {
    throw new Error(
      `State 4 relay: could not decode SSH authority "${remoteAuthority ?? "(none)"}". ` +
        "Open the folder via SSH first, then reopen in container.",
    );
  }
  if (!connectionToken) {
    throw new Error(
      "State 4 relay: container server-main.js did not provide a connection token.",
    );
  }

  // Node binary path inside the container. serverManager installs the server
  // (including a bundled node) at installPath; the relay's `docker exec` must
  // invoke it by full path because node isn't guaranteed to be on PATH in
  // the container (the spike showed exit 126 otherwise).
  const nodePath = `${installPath}/node`;

  ui.showBuildLog(
    `${BRAND_PREFIX} Starting SSH-host relay daemon for container ${containerId.slice(0, 12)}...`,
  );
  log.info(
    `[state4] starting relay: scheme=${scheme} container=${containerId} containerPort=${containerPort} nodePath=${nodePath} dockerPath=${dockerPath}`,
  );

  const relay = await startRelayDaemon({
    containerId,
    containerPort,
    nodePath,
    dockerPath,
  });
  log.info(
    `[state4] relay listening on 127.0.0.1:${relay.relayPort} (pid=${relay.pid})`,
  );
  ui.showBuildLog(
    `${BRAND_PREFIX} Relay daemon ready on port ${relay.relayPort}. Opening remote window...`,
  );

  const payload: ProxyAuthorityInfo = {
    proxy: true,
    sshHost: ssh.sshHost,
    sshUser: ssh.sshUser,
    relayPort: relay.relayPort,
    connectionToken,
    workspacePath,
    hostWorkspacePath: workspaceFolder,
    sshAuthority:
      remoteAuthority ??
      `ssh-remote+${Buffer.from(JSON.stringify({ hostName: ssh.sshHost, user: ssh.sshUser })).toString("hex")}`,
  };

  // Encode the JSON payload as the authority id. The apex-side resolver's
  // `tryParseProxyPayload` detects the `{` prefix and `proxy: true` field.
  return buildRemoteAuthority(scheme, JSON.stringify(payload));
}
