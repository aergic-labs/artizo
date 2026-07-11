/*
 * Copyright (c) 2026 Aergic Labs, LLC
 * SPDX-License-Identifier: AGPL-3.0-only
 */

/**
 * Git credential forwarding into dev containers.
 *
 * Writes a credential helper inside the container that delegates requests
 * back to the host's git credential system via docker exec.
 *
 * Flow:
 * 1. Write helper script at `/tmp/.kiro-server/artizo-credential-helper.sh`
 * 2. Configure git credential.helper to use the script
 * 3. Git inside the container calls back to the host for credentials
 */

import type { Host } from "../host/host";
import { escapeShellArg } from "../utils/shellUtils";

export interface ICredentialForwarder {
  setupGitCredentialHelper(containerId: string): Promise<void>;
}

export interface CredentialForwarderOptions {
  dockerPath?: string;
  /** The host machine's docker path (used inside the helper script for callback) */
  hostDockerPath?: string;
  /**
   * Container reference for the host-side Docker daemon, used by the helper
   * script to run docker exec back to the host. Set as ARTIZO_HOST_ID
   * in the container environment. Required for credential forwarding.
   */
  hostContainerRef?: string;
  host: Host;
}

/**
 * Credential helper script installed inside the container.
 * Uses docker exec on the host (via mounted docker socket) to run git
 * credential on the host. Falls back to no-op without the socket.
 */
const CREDENTIAL_HELPER_SCRIPT = `#!/bin/sh

ACTION="$1"

if [ -z "$ARTIZO_HOST_ID" ]; then
  exit 0
fi

if command -v docker >/dev/null 2>&1; then
  docker exec -i "$ARTIZO_HOST_ID" git credential "$ACTION"
else
  exit 0
fi
`;

const HELPER_SCRIPT_PATH = "/tmp/.kiro-server/artizo-credential-helper.sh";

export class CredentialForwarder implements ICredentialForwarder {
  private readonly host: Host;
  private readonly hostContainerRef: string | undefined;

  constructor(options: CredentialForwarderOptions) {
    this.host = options.host;
    this.hostContainerRef = options?.hostContainerRef;
  }

  async setupGitCredentialHelper(containerId: string): Promise<void> {
    await this.host.dockerExec(containerId, [
      "sh",
      "-c",
      `cat > ${HELPER_SCRIPT_PATH} << 'ARTIZOEOF'\n${CREDENTIAL_HELPER_SCRIPT}ARTIZOEOF`,
    ]);

    await this.host.dockerExec(containerId, [
      "chmod",
      "+x",
      HELPER_SCRIPT_PATH,
    ]);

    if (this.hostContainerRef) {
      // Write to git global config as env var override so the helper
      // inherits it regardless of shell profile state.
      await this.host.dockerExec(containerId, [
        "git",
        "config",
        "--global",
        "credential.helper",
        `!ARTIZO_HOST_ID=${escapeShellArg(this.hostContainerRef)} ${HELPER_SCRIPT_PATH}`,
      ]);
    } else {
      // Configure git credential helper without host ref (will no-op).
      await this.host.dockerExec(containerId, [
        "git",
        "config",
        "--global",
        "credential.helper",
        `!${HELPER_SCRIPT_PATH}`,
      ]);
    }
  }
}
