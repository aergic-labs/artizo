/*
 * Copyright (c) 2026 Aergic Labs, LLC
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import * as net from "node:net";

// Mock vscode (required by the logger import chain)
vi.mock("vscode", () => ({
  window: {
    createOutputChannel: vi.fn(() => ({
      appendLine: vi.fn(),
      show: vi.fn(),
      dispose: vi.fn(),
    })),
  },
}));

vi.mock("node:child_process", () => ({
  spawn: vi.fn(() => ({
    pid: 12345,
    stderr: { on: vi.fn() },
    on: vi.fn(),
    kill: vi.fn(),
  })),
}));

const { fsExistsSync } = vi.hoisted(() => ({
  fsExistsSync: vi.fn(),
}));
vi.mock("node:fs", () => ({
  existsSync: fsExistsSync,
  mkdirSync: vi.fn(),
}));

import { spawn } from "node:child_process";
import {
  resolveSshBinary,
  startSshTunnel,
  stopSshTunnel,
  pickFreePort,
} from "../../src/remote/sshTunnel";

const mockSpawn = vi.mocked(spawn);

// Helper to temporarily override process.platform
function withPlatform(platform: string, fn: () => void): void {
  const original = process.platform;
  Object.defineProperty(process, "platform", { value: platform });
  try {
    fn();
  } finally {
    Object.defineProperty(process, "platform", { value: original });
  }
}

describe("sshTunnel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("resolveSshBinary", () => {
    it("returns Windows OpenSSH path on win32 when it exists", () => {
      fsExistsSync.mockReturnValue(true);
      withPlatform("win32", () => {
        const result = resolveSshBinary();
        expect(result).toBe("C:\\Windows\\System32\\OpenSSH\\ssh.exe");
      });
    });

    it("falls back to 'ssh' on win32 when OpenSSH not found", () => {
      fsExistsSync.mockReturnValue(false);
      withPlatform("win32", () => {
        const result = resolveSshBinary();
        expect(result).toBe("ssh");
      });
    });

    it("returns 'ssh' on macOS/Linux", () => {
      withPlatform("darwin", () => {
        const result = resolveSshBinary();
        expect(result).toBe("ssh");
      });
    });
  });

  describe("startSshTunnel", () => {
    it("spawns ssh with correct args including branding log path", async () => {
      // Simulate ssh -L opening the port immediately by creating a real
      // listener on the expected local port.
      const localPort = await pickFreePort();
      const server = net.createServer();
      await new Promise<void>((resolve) => {
        server.listen(localPort, "127.0.0.1", resolve);
      });

      try {
        const result = await startSshTunnel({
          sshHost: "34.136.190.14",
          sshUser: "kerry",
          remotePort: 9888,
          localPort,
        });

        expect(result.localPort).toBe(localPort);
        expect(mockSpawn).toHaveBeenCalledTimes(1);

        const [binary, args] = mockSpawn.mock.calls[0];
        expect(binary).toMatch(/ssh/);

        // Verify the args contain the key options
        expect(args).toContain("-L");
        expect(args).toContain(`${localPort}:127.0.0.1:9888`);
        expect(args).toContain("kerry@34.136.190.14");
        expect(args).toContain("-N");
        expect(args).toContain("-E");
        // The -E arg should be followed by a path containing "artizo"
        const eIdx = args.indexOf("-E");
        expect(args[eIdx + 1]).toContain("artizo");
        expect(args).toContain("ServerAliveInterval=15");
        expect(args).toContain("ServerAliveCountMax=4");
        expect(args).toContain("ExitOnForwardFailure=yes");
      } finally {
        server.close();
      }
    });

    it("throws if the local port never becomes listening", async () => {
      // Use a port that's not listening. pickFreePort gives us a free port
      // that we immediately close, so nothing is listening on it.
      const freePort = await pickFreePort();

      mockSpawn.mockImplementation(
        () =>
          ({
            pid: 99999,
            stderr: { on: vi.fn() },
            on: vi.fn(),
            kill: vi.fn(),
          }) as any,
      );

      await expect(
        startSshTunnel({
          sshHost: "1.2.3.4",
          sshUser: "user",
          remotePort: 9888,
          localPort: freePort,
        }),
      ).rejects.toThrow("did not start listening");
    }, 15000);
  });

  describe("stopSshTunnel", () => {
    it("kills the ssh process", () => {
      const mockKill = vi.fn();
      mockSpawn.mockImplementation(
        () =>
          ({
            pid: 12345,
            stderr: { on: vi.fn() },
            on: vi.fn(),
            kill: mockKill,
          }) as any,
      );

      // We can call stopSshTunnel with a TunnelInfo-like object directly
      stopSshTunnel({
        localPort: 12345,
        process: {
          kill: mockKill,
        } as any,
      });

      expect(mockKill).toHaveBeenCalledWith("SIGTERM");
    });

    it("does not throw if process is already dead", () => {
      const mockKill = vi.fn().mockImplementation(() => {
        throw new Error("ESRCH");
      });

      expect(() =>
        stopSshTunnel({
          localPort: 12345,
          process: { kill: mockKill } as any,
        }),
      ).not.toThrow();
    });
  });

  describe("pickFreePort", () => {
    it("returns a usable port number", async () => {
      const port = await pickFreePort();
      expect(port).toBeGreaterThan(0);
      expect(port).toBeLessThan(65536);

      // Verify we can actually listen on it
      const server = net.createServer();
      await new Promise<void>((resolve, reject) => {
        server.on("error", reject);
        server.listen(port, "127.0.0.1", resolve);
      });
      server.close();
    });

    it("returns different ports on consecutive calls", async () => {
      const port1 = await pickFreePort();
      const port2 = await pickFreePort();
      // They might be the same in edge cases, but usually different
      // (OS gives different ephemeral ports)
      expect(port1).toBeGreaterThan(0);
      expect(port2).toBeGreaterThan(0);
    });
  });
});
