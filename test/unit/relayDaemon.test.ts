/*
 * Copyright (c) 2026 Aergic Labs, LLC
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, it, expect, vi } from "vitest";

const { mockSpawn, mockCreateServer, mockFs } = vi.hoisted(() => ({
  mockSpawn: vi.fn(),
  mockCreateServer: vi.fn(),
  mockFs: {
    appendFileSync: vi.fn(),
    writeFileSync: vi.fn(),
    unlinkSync: vi.fn(),
  },
}));
vi.mock("node:child_process", () => ({ spawn: mockSpawn }));
vi.mock("node:net", () => ({ createServer: mockCreateServer }));
vi.mock("node:fs", () => mockFs);

import {
  launchDetachedDaemon,
  RELAY_DAEMON_ENV,
  startRelay,
  type RelayConfig,
} from "../../src/remote/relayDaemon";

function makeConfig(): RelayConfig {
  return {
    containerId: "abc123",
    containerPort: 38517,
    nodePath: "/tmp/.trae-server/node",
    dockerPath: "docker",
    port: 0,
    pidFile: "/tmp/.artizo/relays/x.pid",
    metaFile: "/tmp/.artizo/relays/x.meta.json",
    hostNodePath: "/home/dev/.kiro-server/bin/abc/node",
    idleTimeoutMs: 60_000,
    maxFailures: 5,
    logFile: "/tmp/relay.log",
    spawnedBy: "extension",
    daemonHash: "abc",
  };
}

describe("relayDaemon", () => {
  describe("startRelay", () => {
    it("listens, writes pid/meta, and pipes docker exec per connection", () => {
      vi.useFakeTimers();
      try {
        let handler: ((socket: unknown) => void) | undefined;
        const server = {
          listen: vi.fn((_port: number, _host: string, cb: () => void) => cb()),
          address: vi.fn(() => ({ port: 5000 })),
          on: vi.fn(),
        };
        mockCreateServer.mockImplementation(
          (_opts: unknown, cb: (socket: unknown) => void) => {
            handler = cb;
            return server;
          },
        );

        const child = {
          stdin: { on: vi.fn() },
          stdout: { pipe: vi.fn() },
          on: vi.fn(),
          kill: vi.fn(),
        };
        mockSpawn.mockReturnValue(child);

        const cfg = makeConfig();
        startRelay(cfg);

        expect(mockCreateServer).toHaveBeenCalledWith(
          { pauseOnConnect: true },
          expect.any(Function),
        );
        expect(server.listen).toHaveBeenCalledWith(
          0,
          "127.0.0.1",
          expect.any(Function),
        );

        expect(mockFs.writeFileSync).toHaveBeenCalledWith(
          cfg.pidFile,
          expect.any(String),
        );
        const metaCall = mockFs.writeFileSync.mock.calls.find(
          (c) => c[0] === cfg.metaFile,
        );
        expect(metaCall).toBeDefined();
        expect(JSON.parse(metaCall![1] as string)).toMatchObject({
          hostNodePath: cfg.hostNodePath,
          nodePath: cfg.nodePath,
          containerId: cfg.containerId,
          containerPort: cfg.containerPort,
          dockerPath: cfg.dockerPath,
          port: 5000,
          daemonHash: cfg.daemonHash,
          logFile: cfg.logFile,
        });

        const socket = {
          on: vi.fn(),
          pipe: vi.fn(),
          resume: vi.fn(),
          destroy: vi.fn(),
        };
        handler!(socket);

        expect(mockSpawn).toHaveBeenCalledWith(
          cfg.dockerPath,
          [
            "exec",
            "-i",
            cfg.containerId,
            cfg.nodePath,
            "-e",
            expect.any(String),
          ],
          { stdio: ["pipe", "pipe", "pipe"] },
        );
        expect(socket.pipe).toHaveBeenCalledWith(child.stdin);
        expect(child.stdout.pipe).toHaveBeenCalledWith(socket);
        expect(socket.resume).toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe("launchDetachedDaemon", () => {
    it("re-execs a detached copy with the daemon env flag", () => {
      const child = { unref: vi.fn(), on: vi.fn() };
      mockSpawn.mockReturnValue(child);
      const config: RelayConfig = {
        containerId: "abc123",
        containerPort: 38517,
        nodePath: "/tmp/.trae-server/node",
        dockerPath: "docker",
        port: 0,
        pidFile: "/tmp/.artizo/relays/x.pid",
        metaFile: "/tmp/.artizo/relays/x.meta.json",
        hostNodePath: "/home/dev/.kiro-server/bin/abc/node",
        idleTimeoutMs: 1,
        maxFailures: 1,
        logFile: "/tmp/relay.log",
        spawnedBy: "extension",
        daemonHash: "abc",
      };

      const { child: launched, getError } = launchDetachedDaemon(config);

      expect(launched).toBe(child);
      expect(getError()).toBeUndefined();
      expect(mockSpawn).toHaveBeenCalledWith(
        process.execPath,
        [process.argv[1], JSON.stringify(config)],
        expect.objectContaining({
          detached: true,
          stdio: "ignore",
          env: expect.objectContaining({ [RELAY_DAEMON_ENV]: "1" }),
        }),
      );
      expect(child.unref).toHaveBeenCalled();
      expect(child.on).toHaveBeenCalledWith("error", expect.any(Function));
    });
  });
});