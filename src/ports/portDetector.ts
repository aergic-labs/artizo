/*
 * Copyright (c) 2026 Aergic Labs, LLC
 * SPDX-License-Identifier: AGPL-3.0-only
 */

/**
 * Auto-detection of listening ports inside a container.
 *
 * Periodically runs docker exec `<container> cat /proc/net/tcp` and parses
 * the hex-encoded local addresses to extract listening ports.
 *
 * /proc/net/tcp format:
 *   sl  local_address rem_address   st tx_queue rx_queue ...
 *   0: 00000000:1F90 00000000:0000 0A ...
 *
 * State 0A = LISTEN
 * local_address 00000000 = all interfaces, 0100007F = localhost (127.0.0.1)
 */

import { EventEmitter } from "node:events";
import {
  type ExecResult,
  dockerExec,
  type DockerExecOptions,
} from "../utils/dockerUtils";

export interface IPortDetector {
  start(): void;
  stop(): void;
  onDidDetectPort(listener: (port: number) => void): void;
  dispose(): void;
}

export interface PortDetectorOptions {
  containerId: string;
  dockerPath?: string;
  pollIntervalMs?: number;
  knownPorts?: Set<number>;
}

const IGNORED_PORTS = new Set([0]);

/**
 * Parse /proc/net/tcp content to extract listening ports.
 *
 * Each line (after the header) has format:
 *   sl  local_address rem_address   st ...
 * where local_address is hex_ip:hex_port and st is the connection state.
 */
export function parseProcNetTcp(content: string): number[] {
  const lines = content.split("\n");
  const ports: number[] = [];

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) {
      continue;
    }

    // Split by whitespace: [sl, local_address, rem_address, st, ...]
    const parts = line.split(/\s+/);
    if (parts.length < 4) {
      continue;
    }

    const localAddress = parts[1];
    const state = parts[3];

    // Only interested in LISTEN state (0A)
    if (state !== "0A") {
      continue;
    }

    // Parse local_address (format: HEXIP:HEXPORT)
    const [hexIp, hexPort] = localAddress.split(":");
    if (!hexIp || !hexPort) {
      continue;
    }

    // Only include ports listening on all interfaces or localhost
    if (hexIp !== "00000000" && hexIp !== "0100007F") {
      continue;
    }

    const port = parseInt(hexPort, 16);
    if (!isNaN(port) && port > 0 && !IGNORED_PORTS.has(port)) {
      ports.push(port);
    }
  }

  return ports;
}

export class PortDetector implements IPortDetector {
  private readonly containerId: string;
  private readonly dockerPath: string;
  private readonly pollIntervalMs: number;
  private readonly emitter = new EventEmitter();
  private readonly knownPorts: Set<number>;
  private intervalId: ReturnType<typeof setInterval> | null = null;
  private disposed = false;
  private polling = false;

  constructor(options: PortDetectorOptions) {
    this.containerId = options.containerId;
    this.dockerPath = options.dockerPath ?? "docker";
    this.pollIntervalMs = options.pollIntervalMs ?? 3000;
    this.knownPorts = new Set(options.knownPorts ?? []);
  }

  start(): void {
    if (this.disposed || this.intervalId !== null) {
      return;
    }

    this.intervalId = setInterval(() => {
      this.poll();
    }, this.pollIntervalMs);

    // Do an initial poll immediately
    this.poll();
  }

  stop(): void {
    if (this.intervalId !== null) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }

  onDidDetectPort(listener: (port: number) => void): void {
    this.emitter.on("didDetectPort", listener);
  }

  addKnownPort(port: number): void {
    this.knownPorts.add(port);
  }

  removeKnownPort(port: number): void {
    this.knownPorts.delete(port);
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.stop();
    this.emitter.removeAllListeners();
  }

  async triggerPoll(): Promise<void> {
    return this.poll();
  }

  private async poll(): Promise<void> {
    if (this.polling || this.disposed) {
      return;
    }

    this.polling = true;
    try {
      const result = await this.readProcNetTcp();
      if (result.exitCode !== 0) {
        return;
      }

      const listeningPorts = parseProcNetTcp(result.stdout);

      for (const port of listeningPorts) {
        if (!this.knownPorts.has(port)) {
          this.knownPorts.add(port);
          this.emitter.emit("didDetectPort", port);
        }
      }
    } catch {
      // Silently ignore poll errors (container may have stopped)
    } finally {
      this.polling = false;
    }
  }

  private readProcNetTcp(): Promise<ExecResult> {
    const options: DockerExecOptions = {
      dockerPath: this.dockerPath,
    };
    return dockerExec(this.containerId, ["cat", "/proc/net/tcp"], options);
  }
}