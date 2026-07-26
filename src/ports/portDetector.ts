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
import type { Host, ExecResult } from "../host/host";

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
  host?: Host;
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

    // Skip header lines from a second /proc/net file concatenated in. A
    // header's local_address is the literal string "local_address".
    if (localAddress === "local_address") {
      continue;
    }

    // Only interested in LISTEN state (0A)
    if (state !== "0A") {
      continue;
    }

    // Parse local_address (format: HEXIP:HEXPORT)
    const colonIdx = localAddress.lastIndexOf(":");
    if (colonIdx === -1) {
      continue;
    }
    const hexIp = localAddress.slice(0, colonIdx);
    const hexPort = localAddress.slice(colonIdx + 1);
    if (!hexIp || !hexPort) {
      continue;
    }

    // IPv4: all interfaces (00000000) or localhost (0100007F).
    // IPv6: all interfaces (00000000000000000000000000000000) or localhost
    // (00000000000000000000000000000001). Accept the v6 wildcard/loopback so
    // dual-stack listeners are detected.
    const isV4Wildcard = hexIp === "00000000";
    const isV4Loopback = hexIp === "0100007F";
    const isV6Wildcard = hexIp === "00000000000000000000000000000000";
    const isV6Loopback = hexIp === "00000000000000000000000000000001";
    if (!isV4Wildcard && !isV4Loopback && !isV6Wildcard && !isV6Loopback) {
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
  private readonly host: Host;
  private readonly pollIntervalMs: number;
  private readonly emitter = new EventEmitter();
  private readonly knownPorts: Set<number>;
  private intervalId: ReturnType<typeof setInterval> | null = null;
  private disposed = false;
  private polling = false;

  constructor(options: PortDetectorOptions) {
    this.containerId = options.containerId;
    this.host = options.host!;
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
      const results = await this.readProcNetTcp();
      const stdout = results.map((r) => r.stdout).join("\n");

      const listeningPorts = parseProcNetTcp(stdout);

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

  // Read /proc/net/tcp (IPv4) and /proc/net/tcp6 (IPv6) separately.
  // tcp6 may not exist on kernels with IPv6 disabled (ipv6.disable=1,
  // blacklisted module, or compiled out). A combined `cat tcp tcp6` would
  // exit non-zero when tcp6 is missing and discard the valid tcp output.
  private async readProcNetTcp(): Promise<ExecResult[]> {
    return Promise.all([
      this.host.dockerExec(this.containerId, [
        "sh",
        "-c",
        "[ -f /proc/net/tcp ] && cat /proc/net/tcp",
      ]),
      this.host.dockerExec(this.containerId, [
        "sh",
        "-c",
        "[ -f /proc/net/tcp6 ] && cat /proc/net/tcp6",
      ]),
    ]);
  }
}
