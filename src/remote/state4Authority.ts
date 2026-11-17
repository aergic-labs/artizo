/*
 * Copyright (c) 2026 Aergic Labs, LLC
 * SPDX-License-Identifier: AGPL-3.0-only
 */

/**
 * Shared container-authority builder.
 *
 * Both `reopenInContainer` (artizo-container scheme) and `attachToContainer`
 * (attached-container scheme) need the same treatment when the extension is
 * running UI-side on an SSH host: chain the parent SSH authority so the
 * resolver gets the parent's ExecServer.
 *
 * Two relay modes:
 * - `start` (default): start the relay here, then emit the authority. Used by
 *   workflows that already resolved the container in this window (attach, open
 *   folder, clone in volume).
 * - `defer`: emit the authority only. The resolver runs the launch and starts
 *   the relay once it knows the container. Used by reopen/rebuild.
 */

import { buildRemoteAuthority } from "../utils/uriUtils";
import { BRAND_PREFIX } from "../utils/constants";
import { getLogger } from "../utils/logger";
import { ExecutionTier } from "../host/state";
import {
  startRelayDaemon,
  decodeSshAuthority,
  type StableWorkspaceIdentity,
} from "./containerProxy";
import type { ExecServer } from "./execServerBridge";
import type { ProductInfo } from "./productInfo";
import type { WorkflowUI } from "../workflows/types";

/** Start the SSH-host relay daemon for a container the caller already has. */
export async function startRelayForContainer(params: {
  execServer: ExecServer;
  productInfo: ProductInfo;
  identity: StableWorkspaceIdentity;
  containerId: string;
  containerPort: number;
  installPath: string;
  dockerPath: string;
  ui: Pick<WorkflowUI, "showBuildLog">;
}): Promise<number> {
  const {
    execServer,
    productInfo,
    identity,
    containerId,
    containerPort,
    installPath,
    dockerPath,
    ui,
  } = params;
  const log = getLogger();

  const env = await execServer.env?.();
  const home = env?.env.HOME;
  if (!home) {
    throw new Error(
      "ExecServer did not report HOME; cannot locate the SSH host's node.",
    );
  }

  // The relay runs on the SSH host, so it needs the host's bundled node, not
  // the apex's. The host installs the server at
  // <home>/<serverDataFolderName>/bin/<commit>/node.
  const hostNodePath = `${home}/${productInfo.serverDataFolderName}/bin/${productInfo.commit}/node`;
  const logFile = `${home}/.artizo/logs/relay.log`;

  // Node binary path inside the container. serverManager installs the server
  // (including a bundled node) at installPath; the relay's `docker exec` must
  // invoke it by full path because node isn't guaranteed to be on PATH in
  // the container.
  const nodePath = `${installPath}/node`;

  ui.showBuildLog(
    `${BRAND_PREFIX} Starting SSH-host relay daemon for container ${containerId.slice(0, 12)}...`,
  );
  log.info(
    `[relay] starting: container=${containerId} hostNode=${hostNodePath} nodePath=${nodePath} dockerPath=${dockerPath} workspace=${identity.hostWorkspacePath}`,
  );

  const relay = await startRelayDaemon({
    execServer,
    hostNodePath,
    logFile,
    containerId,
    containerPort,
    nodePath,
    dockerPath,
    identity,
  });
  log.info(`[relay] listening on 127.0.0.1:${relay.port}`);
  ui.showBuildLog(`${BRAND_PREFIX} Relay daemon ready. Opening remote window...`);
  return relay.port;
}

/**
 * Build the remote authority for a new container window.
 *
 * - **Remote SSH** (`tier === RemoteSSH && owner === "ui"`): start the relay
 *   on the SSH host, then encode the stable identity fields into a chained
 *   `<scheme>+<hex>@ssh-remote+<hex>` authority.
 * - **Local**: emit a plain bare `<scheme>+<hex(id)>` authority; the resolver
 *   does Docker lookup locally.
 *
 * @param params.scheme      - `artizo-container` or `attached-container`
 * @param params.id          - Local id (workspace folder or container ID)
 * @param params.tier        - Detected execution tier
 * @param params.owner       - "workspace" | "ui" | "none"
 * @param params.remoteAuthority - The SSH authority (ssh-remote+<hex>)
 * @param params.containerId - Docker container ID
 * @param params.containerPort - Server port inside the container
 * @param params.installPath - Server install path inside the container
 * @param params.workspaceFolder - Host-side workspace folder (for "Reopen in Host")
 * @param params.workspacePath   - Container-side workspace path (e.g. /workspaces)
 * @param params.dockerPath   - Docker binary path on the SSH host
 * @param params.ui           - Workflow UI for build log messages
 * @param params.execServer   - ExecServer for the SSH host
 * @param params.productInfo  - Product info for the SSH host's node path
 */
export async function buildContainerAuthority(params: {
  scheme: "artizo-container" | "attached-container";
  id: string;
  tier: ExecutionTier;
  owner: "workspace" | "ui" | "none";
  remoteAuthority: string | undefined;
  containerId?: string;
  containerPort?: number;
  installPath?: string;
  connectionToken?: string;
  workspaceFolder: string;
  workspacePath: string;
  dockerPath: string;
  ui: WorkflowUI;
  execServer?: ExecServer;
  productInfo?: ProductInfo;
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
    workspaceFolder,
    workspacePath,
    dockerPath,
    ui,
    execServer,
    productInfo,
  } = params;

  const isRemoteSsh = tier === ExecutionTier.RemoteSSH && owner === "ui";
  if (!isRemoteSsh) {
    return buildRemoteAuthority(scheme, id);
  }

  const ssh = decodeSshAuthority(remoteAuthority);
  if (!ssh) {
    throw new Error(
      `Remote SSH container authority: could not decode SSH authority "${remoteAuthority ?? "(none)"}". ` +
        "Open the folder via SSH first, then reopen in container.",
    );
  }

  const identity: StableWorkspaceIdentity = {
    sshHost: ssh.sshHost,
    sshUser: ssh.sshUser,
    sshPort: ssh.sshPort,
    hostWorkspacePath: workspaceFolder,
    workspacePath,
  };

  if (!execServer || !productInfo) {
    throw new Error(
      "Remote SSH container authority requires an ExecServer and product info.",
    );
  }
  if (!containerId || containerPort === undefined || !installPath) {
    throw new Error(
      "Remote SSH container authority requires the container's id, port and install path.",
    );
  }
  await startRelayForContainer({
    execServer,
    productInfo,
    identity,
    containerId,
    containerPort,
    installPath,
    dockerPath,
    ui,
  });

  // Stable fields only. The relay discovers the container, port and token
  // per connection, so nothing volatile belongs in the authority.
  const payload = {
    proxy: true,
    sshHost: ssh.sshHost,
    sshUser: ssh.sshUser,
    sshPort: ssh.sshPort,
    hostWorkspacePath: workspaceFolder,
    workspacePath,
  };

  // Encode the JSON payload as the authority id and chain the parent SSH
  // authority. VS Code splits `child@parent` and passes the parent's
  // ExecServer into the child's `resolve`.
  return `${buildRemoteAuthority(scheme, JSON.stringify(payload))}@${remoteAuthority}`;
}