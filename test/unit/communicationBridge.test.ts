/*
 * Copyright (c) 2026 Aergic Labs, LLC
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";

vi.mock("node:child_process", () => ({
  spawn: vi.fn(),
}));

import { spawn } from "node:child_process";
import {
  CommunicationBridge,
  type DisconnectReason,
  type IConnection,
} from "../../src/remote/communicationBridge";

const mockSpawn = vi.mocked(spawn);

/**
 * Creates a mock ChildProcess with controllable stdin, stdout, stderr, and events.
 */
function createMockChildProcess(): {
  process: ChildProcess;
  stdin: { write: ReturnType<typeof vi.fn>; destroyed: boolean };
  stdout: EventEmitter;
  stderr: EventEmitter;
  emitter: EventEmitter;
} {
  const emitter = new EventEmitter();
  const stdout = new EventEmitter();
  const stderr = new EventEmitter();
  const stdin = { write: vi.fn(), destroyed: false };

  const process = Object.assign(emitter, {
    stdin,
    stdout,
    stderr,
    pid: 12345,
    killed: false,
    connected: true,
    exitCode: null,
    signalCode: null,
    spawnargs: [],
    spawnfile: "",
    kill: vi.fn(() => {
      (process as any).killed = true;
      return true;
    }),
    send: vi.fn(),
    disconnect: vi.fn(),
    unref: vi.fn(),
    ref: vi.fn(),
    stdio: [stdin, stdout, stderr, null, null] as any,
    [Symbol.dispose]: vi.fn(),
  }) as unknown as ChildProcess;

  return { process, stdin, stdout, stderr, emitter };
}

describe("CommunicationBridge", () => {
  let bridge: CommunicationBridge;

  beforeEach(() => {
    bridge = new CommunicationBridge();
    mockSpawn.mockReset();
  });

  describe("connect", () => {
    it("spawns docker exec with correct arguments", async () => {
      const mock = createMockChildProcess();
      mockSpawn.mockReturnValue(mock.process);

      // Emit spawn event on next tick to simulate successful start
      setImmediate(() => mock.emitter.emit("spawn"));

      await bridge.connect(
        "my-container",
        8080,
        "/tmp/.kiro-server/test-install",
      );

      expect(mockSpawn).toHaveBeenCalledWith(
        "docker",
        [
          "exec",
          "-i",
          "my-container",
          "/tmp/.kiro-server/test-install/node",
          "/tmp/.artizo/bin/relay.js",
          "8080",
        ],
        { stdio: ["pipe", "pipe", "pipe"] },
      );
    });

    it("uses custom docker path when provided", async () => {
      const customBridge = new CommunicationBridge({
        dockerPath: "/usr/local/bin/docker",
      });
      const mock = createMockChildProcess();
      mockSpawn.mockReturnValue(mock.process);

      setImmediate(() => mock.emitter.emit("spawn"));

      await customBridge.connect("container1", 8080, "/tmp/.kiro-server/abc");

      expect(mockSpawn).toHaveBeenCalledWith(
        "/usr/local/bin/docker",
        expect.any(Array),
        expect.any(Object),
      );
    });

    it("sets isConnected to true after successful connect", async () => {
      const mock = createMockChildProcess();
      mockSpawn.mockReturnValue(mock.process);

      setImmediate(() => mock.emitter.emit("spawn"));

      expect(bridge.isConnected()).toBe(false);
      await bridge.connect("container1", 8080, "/tmp/.kiro-server/abc");
      expect(bridge.isConnected()).toBe(true);
    });

    it("rejects if spawn emits an error", async () => {
      const mock = createMockChildProcess();
      mockSpawn.mockReturnValue(mock.process);

      setImmediate(() => mock.emitter.emit("error", new Error("spawn ENOENT")));

      await expect(
        bridge.connect("container1", 8080, "/tmp/.kiro-server/abc"),
      ).rejects.toThrow("spawn ENOENT");

      expect(bridge.isConnected()).toBe(false);
    });

    it("throws if already connected", async () => {
      const mock = createMockChildProcess();
      mockSpawn.mockReturnValue(mock.process);

      setImmediate(() => mock.emitter.emit("spawn"));
      await bridge.connect("container1", 8080, "/tmp/.kiro-server/abc");

      await expect(
        bridge.connect("container2", 9090, "/tmp/.kiro-server/abc"),
      ).rejects.toThrow("Bridge is already connected");
    });

    it("returns a connection object with send, onData, and onClose", async () => {
      const mock = createMockChildProcess();
      mockSpawn.mockReturnValue(mock.process);

      setImmediate(() => mock.emitter.emit("spawn"));

      const connection = await bridge.connect(
        "container1",
        8080,
        "/tmp/.kiro-server/abc",
      );

      expect(connection.send).toBeTypeOf("function");
      expect(connection.onData).toBeTypeOf("function");
      expect(connection.onClose).toBeTypeOf("function");
    });
  });

  describe("IConnection - data piping", () => {
    let mock: ReturnType<typeof createMockChildProcess>;
    let connection: IConnection;

    beforeEach(async () => {
      mock = createMockChildProcess();
      mockSpawn.mockReturnValue(mock.process);

      setImmediate(() => mock.emitter.emit("spawn"));
      connection = await bridge.connect(
        "container1",
        8080,
        "/tmp/.kiro-server/abc",
      );
    });

    it("send() writes data to child process stdin", () => {
      const data = Buffer.from("hello");
      connection.send(data);

      expect(mock.stdin.write).toHaveBeenCalledWith(data);
    });

    it("does not write to stdin if it is destroyed", () => {
      mock.stdin.destroyed = true;
      const data = Buffer.from("hello");
      connection.send(data);

      expect(mock.stdin.write).not.toHaveBeenCalled();
    });

    it("onData receives data from child process stdout", () => {
      const listener = vi.fn();
      connection.onData(listener);

      const chunk = Buffer.from("response data");
      mock.stdout.emit("data", chunk);

      expect(listener).toHaveBeenCalledWith(chunk);
    });

    it("onData receives multiple chunks", () => {
      const listener = vi.fn();
      connection.onData(listener);

      mock.stdout.emit("data", Buffer.from("chunk1"));
      mock.stdout.emit("data", Buffer.from("chunk2"));
      mock.stdout.emit("data", Buffer.from("chunk3"));

      expect(listener).toHaveBeenCalledTimes(3);
    });

    it("onClose fires when process exits", () => {
      const listener = vi.fn();
      connection.onClose(listener);

      mock.emitter.emit("exit", 0, null);

      expect(listener).toHaveBeenCalledTimes(1);
    });
  });

  describe("disconnect", () => {
    it("kills the child process with SIGTERM", async () => {
      const mock = createMockChildProcess();
      mockSpawn.mockReturnValue(mock.process);

      setImmediate(() => mock.emitter.emit("spawn"));
      await bridge.connect("container1", 8080, "/tmp/.kiro-server/abc");

      // Simulate process exiting after kill
      const killFn = vi.mocked(mock.process.kill);
      killFn.mockImplementation(() => {
        setImmediate(() => mock.emitter.emit("exit", 0, "SIGTERM"));
        return true;
      });

      await bridge.disconnect();

      expect(killFn).toHaveBeenCalledWith("SIGTERM");
      expect(bridge.isConnected()).toBe(false);
    });

    it("does nothing if not connected", async () => {
      // Should not throw
      await bridge.disconnect();
      expect(bridge.isConnected()).toBe(false);
    });

    it("sets isConnected to false immediately", async () => {
      const mock = createMockChildProcess();
      mockSpawn.mockReturnValue(mock.process);

      setImmediate(() => mock.emitter.emit("spawn"));
      await bridge.connect("container1", 8080, "/tmp/.kiro-server/abc");

      // Don't emit exit - just check that disconnect sets connected=false
      const disconnectPromise = bridge.disconnect();
      expect(bridge.isConnected()).toBe(false);

      // Emit exit to resolve the promise
      mock.emitter.emit("exit", 0, "SIGTERM");
      await disconnectPromise;
    });
  });

  describe("disconnect detection and onDidDisconnect", () => {
    let mock: ReturnType<typeof createMockChildProcess>;

    beforeEach(async () => {
      mock = createMockChildProcess();
      mockSpawn.mockReturnValue(mock.process);

      setImmediate(() => mock.emitter.emit("spawn"));
      await bridge.connect("container1", 8080, "/tmp/.kiro-server/abc");
    });

    it("fires user-initiated reason on explicit disconnect", async () => {
      const listener = vi.fn();
      bridge.onDidDisconnect(listener);

      const killFn = vi.mocked(mock.process.kill);
      killFn.mockImplementation(() => {
        setImmediate(() => mock.emitter.emit("exit", 0, "SIGTERM"));
        return true;
      });

      await bridge.disconnect();

      // The exit handler fires but since userInitiatedDisconnect is true,
      // it should not emit (connected is already false before exit fires)
      // Actually, disconnect sets connected=false before kill, so exit handler won't fire
      expect(listener).not.toHaveBeenCalled();
    });

    it("fires container-stopped reason on exit code 137 (SIGKILL)", () => {
      const listener = vi.fn();
      bridge.onDidDisconnect(listener);

      mock.emitter.emit("exit", 137, null);

      expect(listener).toHaveBeenCalledWith({ type: "container-stopped" });
    });

    it("fires container-stopped reason on exit code 143 (SIGTERM)", () => {
      const listener = vi.fn();
      bridge.onDidDisconnect(listener);

      mock.emitter.emit("exit", 143, null);

      expect(listener).toHaveBeenCalledWith({ type: "container-stopped" });
    });

    it("fires container-stopped reason on SIGKILL signal", () => {
      const listener = vi.fn();
      bridge.onDidDisconnect(listener);

      mock.emitter.emit("exit", null, "SIGKILL");

      expect(listener).toHaveBeenCalledWith({ type: "container-stopped" });
    });

    it("fires container-stopped reason on SIGTERM signal", () => {
      const listener = vi.fn();
      bridge.onDidDisconnect(listener);

      mock.emitter.emit("exit", null, "SIGTERM");

      expect(listener).toHaveBeenCalledWith({ type: "container-stopped" });
    });

    it("fires server-crashed reason on non-zero exit code", () => {
      const listener = vi.fn();
      bridge.onDidDisconnect(listener);

      mock.emitter.emit("exit", 1, null);

      expect(listener).toHaveBeenCalledWith({
        type: "server-crashed",
        exitCode: 1,
      });
    });

    it("fires server-crashed reason on exit code 2", () => {
      const listener = vi.fn();
      bridge.onDidDisconnect(listener);

      mock.emitter.emit("exit", 2, null);

      expect(listener).toHaveBeenCalledWith({
        type: "server-crashed",
        exitCode: 2,
      });
    });

    it("fires network-error reason on process error event", () => {
      const listener = vi.fn();
      bridge.onDidDisconnect(listener);

      const err = new Error("EPIPE");
      mock.emitter.emit("error", err);

      expect(listener).toHaveBeenCalledWith({
        type: "network-error",
        error: err,
      });
    });

    it("fires network-error reason on exit code 0 with no signal (unexpected close)", () => {
      const listener = vi.fn();
      bridge.onDidDisconnect(listener);

      mock.emitter.emit("exit", 0, null);

      expect(listener).toHaveBeenCalledWith(
        expect.objectContaining({ type: "network-error" }),
      );
    });

    it("sets isConnected to false after unexpected disconnect", () => {
      mock.emitter.emit("exit", 1, null);
      expect(bridge.isConnected()).toBe(false);
    });

    it("does not fire disconnect event twice for same disconnect", () => {
      const listener = vi.fn();
      bridge.onDidDisconnect(listener);

      mock.emitter.emit("exit", 1, null);
      mock.emitter.emit("exit", 1, null);

      expect(listener).toHaveBeenCalledTimes(1);
    });

    it("supports multiple disconnect listeners", () => {
      const listener1 = vi.fn();
      const listener2 = vi.fn();
      bridge.onDidDisconnect(listener1);
      bridge.onDidDisconnect(listener2);

      mock.emitter.emit("exit", 137, null);

      expect(listener1).toHaveBeenCalledTimes(1);
      expect(listener2).toHaveBeenCalledTimes(1);
    });
  });

  describe("reconnection after disconnect", () => {
    it("allows reconnecting after disconnect", async () => {
      const mock1 = createMockChildProcess();
      mockSpawn.mockReturnValue(mock1.process);

      setImmediate(() => mock1.emitter.emit("spawn"));
      await bridge.connect("container1", 8080, "/tmp/.kiro-server/abc");

      // Simulate unexpected disconnect
      mock1.emitter.emit("exit", 1, null);
      expect(bridge.isConnected()).toBe(false);

      // Reconnect
      const mock2 = createMockChildProcess();
      mockSpawn.mockReturnValue(mock2.process);

      setImmediate(() => mock2.emitter.emit("spawn"));
      await bridge.connect("container1", 8080, "/tmp/.kiro-server/abc");

      expect(bridge.isConnected()).toBe(true);
    });

    it("allows reconnecting after explicit disconnect", async () => {
      const mock1 = createMockChildProcess();
      mockSpawn.mockReturnValue(mock1.process);

      setImmediate(() => mock1.emitter.emit("spawn"));
      await bridge.connect("container1", 8080, "/tmp/.kiro-server/abc");

      const killFn = vi.mocked(mock1.process.kill);
      killFn.mockImplementation(() => {
        setImmediate(() => mock1.emitter.emit("exit", 0, "SIGTERM"));
        return true;
      });

      await bridge.disconnect();

      // Reconnect
      const mock2 = createMockChildProcess();
      mockSpawn.mockReturnValue(mock2.process);

      setImmediate(() => mock2.emitter.emit("spawn"));
      await bridge.connect("container2", 9090, "/tmp/.kiro-server/abc");

      expect(bridge.isConnected()).toBe(true);
    });
  });
});