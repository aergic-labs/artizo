/*
 * Copyright (c) 2026 Aergic Labs, LLC
 * SPDX-License-Identifier: AGPL-3.0-only
 */

/**
 * SSH agent forwarding into dev containers.
 *
 * If SSH_AUTH_SOCK is set on the host, starts a Node.js relay to forward
 * the SSH agent socket into the container. Skips gracefully if not set.
 */

import type { ChildProcess } from "node:child_process";
import { createConnection } from "node:net";
import type { Host } from "../host/host";
import { dockerSpawn } from "../utils/dockerUtils";

export interface ISshAgentForwarder {
  setupSshAgentForwarding(
    containerId: string,
    installPath: string,
  ): Promise<void>;
  dispose(): void;
}

export interface SshAgentForwarderOptions {
  dockerPath?: string;
  /**
   * Override the host SSH_AUTH_SOCK path for testing.
   * If not provided, reads from process.env.SSH_AUTH_SOCK.
   */
  hostSshAuthSock?: string;
  host?: Host;
}

/** Path inside the container where the forwarded SSH agent socket will be placed */
const CONTAINER_SSH_AUTH_SOCK = "/tmp/artizo-ssh-agent.sock";

/**
 * Node.js script that runs inside the container to create a Unix socket server
 * and relay connections bidirectionally through stdin/stdout.
 */
const CONTAINER_RELAY_SCRIPT = `
const net = require('net');
const fs = require('fs');
const sock = '${CONTAINER_SSH_AUTH_SOCK}';
try { fs.unlinkSync(sock); } catch(e) {}
const server = net.createServer((c) => {
  c.pipe(process.stdout);
  process.stdin.pipe(c);
  c.on('close', () => { if (!server.listening) process.exit(0); });
  c.on('error', () => { if (!server.listening) process.exit(0); });
});
server.listen(sock, () => process.stdout.write('READY\\n'));
process.stdin.resume();
`;

export class SshAgentForwarder implements ISshAgentForwarder {
  private readonly dockerPath: string;
  private readonly host: Host;
  private readonly hostSshAuthSock: string | undefined;
  private relayProcess: ChildProcess | null = null;

  constructor(options?: SshAgentForwarderOptions) {
    this.dockerPath = options?.dockerPath ?? "docker";
    this.host = options?.host!;
    this.hostSshAuthSock =
      options?.hostSshAuthSock ?? process.env.SSH_AUTH_SOCK;
  }

  async setupSshAgentForwarding(
    containerId: string,
    installPath: string,
  ): Promise<void> {
    if (!this.hostSshAuthSock) {
      return;
    }

    await this.host.dockerExec(containerId, [
      "sh",
      "-c",
      `echo 'export SSH_AUTH_SOCK="${CONTAINER_SSH_AUTH_SOCK}"' > /etc/profile.d/artizo-ssh.sh`,
    ]);

    await this.host.dockerExec(containerId, [
      "git",
      "config",
      "--global",
      "core.sshCommand",
      `SSH_AUTH_SOCK=${CONTAINER_SSH_AUTH_SOCK} ssh`,
    ]);

    // Start the socket relay connecting container Unix socket to host SSH agent.
    // Use the server's bundled node by full path: a system `node` is almost
    // never present in a container image (the relay daemon learned this the
    // hard way), so bare `node` is not an option.
    await this.startRelay(containerId, `${installPath}/node`);
  }

  private startRelay(containerId: string, nodePath: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const child = dockerSpawn(
        this.dockerPath,
        ["exec", "-i", containerId, nodePath, "-e", CONTAINER_RELAY_SCRIPT],
        { stdio: ["pipe", "pipe", "pipe"] },
      );

      this.relayProcess = child;

      let settled = false;

      child.on("error", (err) => {
        if (!settled) {
          settled = true;
          reject(err);
        }
      });

      // Wait for READY signal on stdout before connecting host side
      const onData = (chunk: Buffer) => {
        const text = chunk.toString();
        if (text.includes("READY")) {
          child.stdout!.removeListener("data", onData);
          if (settled) return;
          settled = true;

          const hostConn = createConnection(this.hostSshAuthSock!);
          hostConn.on("error", () => {
            child.kill();
          });

          child.stdout!.pipe(hostConn);
          hostConn.pipe(child.stdin!);
          resolve();
        }
      };

      child.stdout!.on("data", onData);

      child.on("exit", () => {
        if (!settled) {
          settled = true;
          reject(new Error("Relay process exited before ready"));
        }
      });
    });
  }

  dispose(): void {
    if (this.relayProcess) {
      this.relayProcess.kill();
      this.relayProcess = null;
    }
  }
}
