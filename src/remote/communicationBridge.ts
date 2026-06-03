/*
 * Copyright (c) 2026 Aergic Labs, LLC
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import type { ChildProcess } from "node:child_process";
import { dockerSpawn } from "../utils/dockerUtils.js";
import { EventEmitter } from "node:events";

/**
 * Reason for disconnection from the remote server.
 */
export type DisconnectReason =
  | { type: "container-stopped" }
  | { type: "network-error"; error: Error }
  | { type: "server-crashed"; exitCode: number }
  | { type: "user-initiated" };

/**
 * A bidirectional connection for sending/receiving data.
 */
export interface IConnection {
  send(data: Buffer): void;
  onData(listener: (data: Buffer) => void): void;
  onClose(listener: () => void): void;
}

/**
 * Bridge interface for managing the docker exec communication channel.
 */
export interface ICommunicationBridge {
  connect(
    containerId: string,
    port: number,
    installPath: string,
  ): Promise<IConnection>;
  disconnect(): Promise<void>;
  isConnected(): boolean;
  onDidDisconnect(listener: (reason: DisconnectReason) => void): void;
}

/**
 * Options for the communication bridge.
 */
export interface CommunicationBridgeOptions {
  dockerPath?: string;
}

/**
 * Implementation of the communication bridge using docker exec + Node.js relay.
 */
export class CommunicationBridge implements ICommunicationBridge {
  private readonly dockerPath: string;
  private childProcess: ChildProcess | null = null;
  private connected = false;
  private userInitiatedDisconnect = false;
  private readonly emitter = new EventEmitter();

  constructor(options?: CommunicationBridgeOptions) {
    this.dockerPath = options?.dockerPath ?? "docker";
  }

  async connect(
    containerId: string,
    port: number,
    installPath: string,
  ): Promise<IConnection> {
    if (this.connected) {
      throw new Error("Bridge is already connected. Call disconnect() first.");
    }

    this.userInitiatedDisconnect = false;

    const nodePath = `${installPath}/node`;
    const relayPath = "/tmp/.artizo/bin/relay.js";

    const child = dockerSpawn(
      this.dockerPath,
      ["exec", "-i", containerId, nodePath, relayPath, String(port)],
      { stdio: ["pipe", "pipe", "pipe"] },
    );

    this.childProcess = child;

    // Wait for the process to either start successfully or fail immediately
    await this.waitForProcessStart(child);

    this.connected = true;

    const connectionEmitter = new EventEmitter();

    child.stdout!.on("data", (chunk: Buffer) => {
      connectionEmitter.emit("data", chunk);
    });

    child.on("exit", (code, signal) => {
      if (!this.connected) {
        return;
      }

      this.connected = false;
      this.childProcess = null;
      connectionEmitter.emit("close");

      const reason = this.determineDisconnectReason(code, signal);
      this.emitter.emit("didDisconnect", reason);
    });

    child.on("error", (err: Error) => {
      if (!this.connected) {
        return;
      }

      this.connected = false;
      this.childProcess = null;
      connectionEmitter.emit("close");

      const reason: DisconnectReason = { type: "network-error", error: err };
      this.emitter.emit("didDisconnect", reason);
    });

    const connection: IConnection = {
      send: (data: Buffer) => {
        if (child.stdin && !child.stdin.destroyed) {
          child.stdin.write(data);
        }
      },
      onData: (listener: (data: Buffer) => void) => {
        connectionEmitter.on("data", listener);
      },
      onClose: (listener: () => void) => {
        connectionEmitter.on("close", listener);
      },
    };

    return connection;
  }

  async disconnect(): Promise<void> {
    if (!this.connected || !this.childProcess) {
      return;
    }

    this.userInitiatedDisconnect = true;
    this.connected = false;

    const child = this.childProcess;
    this.childProcess = null;

    child.kill("SIGTERM");

    await this.waitForProcessExit(child);
  }

  isConnected(): boolean {
    return this.connected;
  }

  onDidDisconnect(listener: (reason: DisconnectReason) => void): void {
    this.emitter.on("didDisconnect", listener);
  }

  private waitForProcessStart(child: ChildProcess): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      let settled = false;

      const onError = (err: Error) => {
        if (!settled) {
          settled = true;
          cleanup();
          reject(err);
        }
      };

      const onSpawn = () => {
        if (!settled) {
          settled = true;
          cleanup();
          resolve();
        }
      };

      const cleanup = () => {
        child.removeListener("error", onError);
        child.removeListener("spawn", onSpawn);
      };

      child.on("error", onError);
      child.on("spawn", onSpawn);
    });
  }

  private waitForProcessExit(child: ChildProcess): Promise<void> {
    return new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        child.kill("SIGKILL");
        resolve();
      }, 5000);

      child.on("exit", () => {
        clearTimeout(timeout);
        resolve();
      });
    });
  }

  private determineDisconnectReason(
    code: number | null,
    signal: string | null,
  ): DisconnectReason {
    if (this.userInitiatedDisconnect) {
      return { type: "user-initiated" };
    }

    // Exit code 137 = SIGKILL (container stopped/OOM killed)
    // Exit code 143 = SIGTERM (container stopped gracefully)
    if (
      code === 137 ||
      code === 143 ||
      signal === "SIGKILL" ||
      signal === "SIGTERM"
    ) {
      return { type: "container-stopped" };
    }

    // Exit code 1 with no signal typically means the relay/server process crashed
    if (code !== null && code !== 0) {
      return { type: "server-crashed", exitCode: code };
    }

    // Fallback: treat as network error
    return {
      type: "network-error",
      error: new Error("Connection lost unexpectedly"),
    };
  }
}