/*
 * Copyright (c) 2026 Aergic Labs, LLC
 * SPDX-License-Identifier: AGPL-3.0-only
 */

/**
 * Port forwarding between container and host using net.Server + docker exec Node.js relay.
 *
 * For each forwarded port:
 * 1. Creates a local net.Server listening on localPort
 * 2. On each incoming connection, spawns a Node.js relay inside the container
 *    via docker exec that connects to the target port and pipes stdin/stdout
 * 3. Pipes the local socket ↔ docker exec stdio bidirectionally
 */

import type { ChildProcess } from 'node:child_process';
import { dockerSpawn, tcpRelayScript, pipeDockerRelay } from '../utils/dockerUtils.js';
import { createServer, type Server, type Socket } from 'node:net';
import { EventEmitter } from 'node:events';

export interface ForwardedPort {
  containerPort: number;
  localPort: number;
  label?: string;
  protocol: 'tcp';
  source: 'config' | 'auto-detected' | 'user';
}

export interface IPortForwarder {
  forwardPort(containerPort: number, localPort?: number, label?: string): Promise<ForwardedPort>;
  unforwardPort(containerPort: number): Promise<void>;
  getForwardedPorts(): ForwardedPort[];
  dispose(): void;
}

interface ActiveForward {
  port: ForwardedPort;
  server: Server;
  connections: Set<{ socket: Socket; process: ChildProcess }>;
}

export interface PortForwarderOptions {
  containerId: string;
  dockerPath?: string;
  installPath?: string;
}

export class PortForwarder implements IPortForwarder {
  private readonly containerId: string;
  private readonly dockerPath: string;
  private readonly installPath?: string;
  private readonly forwards = new Map<number, ActiveForward>();
  private readonly emitter = new EventEmitter();
  private disposed = false;

  constructor(options: PortForwarderOptions) {
    this.containerId = options.containerId;
    this.dockerPath = options.dockerPath ?? 'docker';
    this.installPath = options.installPath;
  }

  /**
   * Forward a container port to a local port.
   * If localPort is not specified, uses the same port number as containerPort.
   */
  async forwardPort(
    containerPort: number,
    localPort?: number,
    label?: string
  ): Promise<ForwardedPort> {
    if (this.disposed) {
      throw new Error('PortForwarder has been disposed');
    }

    if (this.forwards.has(containerPort)) {
      throw new Error(`Port ${containerPort} is already forwarded`);
    }

    const resolvedLocalPort = localPort ?? containerPort;

    const server = createServer((socket: Socket) => {
      this.handleConnection(containerPort, socket);
    });

    await this.listenOnPort(server, resolvedLocalPort);

    const forwardedPort: ForwardedPort = {
      containerPort,
      localPort: resolvedLocalPort,
      label,
      protocol: 'tcp',
      source: 'user',
    };

    const activeForward: ActiveForward = {
      port: forwardedPort,
      server,
      connections: new Set(),
    };

    this.forwards.set(containerPort, activeForward);
    this.emitter.emit('didForwardPort', forwardedPort);

    return forwardedPort;
  }

  /**
   * Stop forwarding a container port.
   */
  async unforwardPort(containerPort: number): Promise<void> {
    const forward = this.forwards.get(containerPort);
    if (!forward) {
      return;
    }

    this.forwards.delete(containerPort);

    // Kill all active relay processes and close sockets
    for (const conn of forward.connections) {
      conn.process.kill('SIGTERM');
      conn.socket.destroy();
    }
    forward.connections.clear();

    // Close the local server
    await this.closeServer(forward.server);

    this.emitter.emit('didUnforwardPort', containerPort);
  }

  /**
   * Get all currently forwarded ports.
   */
  getForwardedPorts(): ForwardedPort[] {
    return Array.from(this.forwards.values()).map((f) => f.port);
  }

  /**
   * Register a listener for port forward events.
   */
  onDidForwardPort(listener: (port: ForwardedPort) => void): void {
    this.emitter.on('didForwardPort', listener);
  }

  /**
   * Register a listener for port unforward events.
   */
  onDidUnforwardPort(listener: (containerPort: number) => void): void {
    this.emitter.on('didUnforwardPort', listener);
  }

  /**
   * Dispose all forwarded ports and clean up resources.
   */
  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;

    for (const [containerPort] of this.forwards) {
      // Fire-and-forget cleanup
      this.unforwardPort(containerPort);
    }

    this.emitter.removeAllListeners();
  }

  /**
   * Handle an incoming connection on a forwarded port.
   * Spawns a Node.js relay inside the container via docker exec that connects
   * to the target port and pipes stdin/stdout bidirectionally.
   */
  private handleConnection(containerPort: number, socket: Socket): void {
    const forward = this.forwards.get(containerPort);
    if (!forward) {
      socket.destroy();
      return;
    }

    // Use bundled node + relay.js if install path is known, fall back to inline script
    const relayArgs = this.installPath
      ? [`${this.installPath}/node`, `${this.installPath}/bin/relay.js`, String(containerPort)]
      : ['node', '-e', tcpRelayScript(containerPort)];

    const child = dockerSpawn(this.dockerPath, [
      'exec',
      '-i',
      this.containerId,
      ...relayArgs,
    ], { stdio: ['pipe', 'pipe', 'pipe'] });

    const connEntry = { socket, process: child };
    forward.connections.add(connEntry);

    pipeDockerRelay(child, socket);

    // Clean up on socket close
    socket.on('close', () => {
      forward.connections.delete(connEntry);
    });

    socket.on('error', () => {
      child.kill('SIGTERM');
      forward.connections.delete(connEntry);
    });

    // Clean up on process exit
    child.on('exit', () => {
      socket.destroy();
      forward.connections.delete(connEntry);
    });

    child.on('error', () => {
      socket.destroy();
      forward.connections.delete(connEntry);
    });
  }

  /**
   * Start listening on a port, returning a promise that resolves when the server is ready.
   */
  private listenOnPort(server: Server, port: number): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      server.on('error', reject);
      server.listen(port, '127.0.0.1', () => {
        server.removeListener('error', reject);
        resolve();
      });
    });
  }

  /**
   * Close a server, returning a promise that resolves when closed.
   */
  private closeServer(server: Server): Promise<void> {
    return new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  }
}