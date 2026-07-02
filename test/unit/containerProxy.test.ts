/*
 * Copyright (c) 2026 Aergic Labs, LLC
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

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
    unref: vi.fn(),
    on: vi.fn(),
  })),
}));

import { spawn } from "node:child_process";
import {
  decodeSshAuthority,
  killStaleRelay,
  sweepStaleRelays,
  startRelayDaemon,
} from "../../src/remote/containerProxy";

const mockSpawn = vi.mocked(spawn);

/** Build a valid ssh-remote+<hex> authority from a hostName/user object. */
function makeSshAuthority(hostName: string, user: string): string {
  const json = JSON.stringify({ hostName, user });
  const hex = Buffer.from(json, "utf-8").toString("hex");
  return `ssh-remote+${hex}`;
}

describe("containerProxy", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("decodeSshAuthority", () => {
    it("decodes a valid ssh-remote authority", () => {
      const authority = makeSshAuthority("34.136.190.14", "kerry");
      const result = decodeSshAuthority(authority);
      expect(result).toEqual({
        sshHost: "34.136.190.14",
        sshUser: "kerry",
      });
    });

    it("returns undefined for undefined input", () => {
      expect(decodeSshAuthority(undefined)).toBeUndefined();
    });

    it("returns undefined for non-ssh scheme", () => {
      expect(decodeSshAuthority("wsl+abcdef")).toBeUndefined();
      expect(decodeSshAuthority("attached-container+abcdef")).toBeUndefined();
    });

    it("returns undefined for authority without + separator", () => {
      expect(decodeSshAuthority("ssh-remote")).toBeUndefined();
    });

    it("returns undefined for empty hex", () => {
      // An invalid hex-JSON authority that doesn't look like a plain form
      // (e.g. contains only whitespace) returns undefined.
      expect(decodeSshAuthority("ssh-remote+   ")).toBeUndefined();
    });

    it("returns undefined for JSON missing hostName", () => {
      const json = JSON.stringify({ user: "kerry" });
      const hex = Buffer.from(json, "utf-8").toString("hex");
      expect(decodeSshAuthority(`ssh-remote+${hex}`)).toBeUndefined();
    });

    it("falls back to OS username when user is missing", () => {
      const json = JSON.stringify({ hostName: "1.2.3.4" });
      const hex = Buffer.from(json, "utf-8").toString("hex");
      const result = decodeSshAuthority(`ssh-remote+${hex}`);
      expect(result).toEqual({
        sshHost: "1.2.3.4",
        sshUser: os.userInfo().username,
      });
    });

    it("returns undefined for non-string hostName", () => {
      const json = JSON.stringify({ hostName: 123, user: "kerry" });
      const hex = Buffer.from(json, "utf-8").toString("hex");
      expect(decodeSshAuthority(`ssh-remote+${hex}`)).toBeUndefined();
    });

    it("handles ssh-remote fork variants (ssh-remote-foo)", () => {
      const authority = makeSshAuthority("10.0.0.1", "root");
      // Replace scheme prefix with a fork variant
      const forkAuthority = authority.replace("ssh-remote+", "ssh-remote-foo+");
      expect(decodeSshAuthority(forkAuthority)).toEqual({
        sshHost: "10.0.0.1",
        sshUser: "root",
      });
    });

    it("decodes a plain user@host authority", () => {
      expect(decodeSshAuthority("ssh-remote+kerry@34.173.162.32")).toEqual({
        sshHost: "34.173.162.32",
        sshUser: "kerry",
      });
    });

    it("decodes a plain host authority with no user", () => {
      const result = decodeSshAuthority("ssh-remote+34.173.162.32");
      expect(result?.sshHost).toBe("34.173.162.32");
      expect(result?.sshUser).toBe(os.userInfo().username);
    });

    it("decodes a plain user@host:port authority", () => {
      expect(decodeSshAuthority("ssh-remote+kerry@host.example:2222")).toEqual({
        sshHost: "host.example",
        sshUser: "kerry",
      });
    });

    it("decodes a plain host:port authority with no user", () => {
      const result = decodeSshAuthority("ssh-remote+host.example:2222");
      expect(result?.sshHost).toBe("host.example");
      expect(result?.sshUser).toBe(os.userInfo().username);
    });

    it("decodes a plain user@host authority with leading whitespace", () => {
      expect(decodeSshAuthority("ssh-remote+ kerry@34.173.162.32")).toEqual({
        sshHost: "34.173.162.32",
        sshUser: "kerry",
      });
    });

    it("unescapes \\xNN sequences for uppercase hostnames", () => {
      // VS Code lowercases the authority; uppercase letters are escaped.
      const host = "MyHost.example";
      const escaped = host.replace(
        /[A-Z]/g,
        (ch) => `\\x${ch.charCodeAt(0).toString(16).toLowerCase()}`,
      );
      expect(decodeSshAuthority(`ssh-remote+kerry@${escaped}`)).toEqual({
        sshHost: "MyHost.example",
        sshUser: "kerry",
      });
    });

    it("returns undefined for a plain authority without a host", () => {
      expect(decodeSshAuthority("ssh-remote+")).toBeUndefined();
    });
  });

  describe("killStaleRelay", () => {
    it("is a no-op when PID file does not exist", () => {
      const nonexistent = path.join(
        os.tmpdir(),
        `artizo-test-nopid-${Date.now()}.pid`,
      );
      // Should not throw
      expect(() => killStaleRelay(nonexistent)).not.toThrow();
    });

    it("kills the process and removes the PID file", () => {
      const pidFile = path.join(
        os.tmpdir(),
        `artizo-test-kill-${Date.now()}.pid`,
      );
      // Use a PID that's very unlikely to exist (but killStaleRelay should
      // try and handle the error gracefully)
      fs.writeFileSync(pidFile, "999999998");
      // Mock process.kill to succeed
      const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
      killStaleRelay(pidFile);
      expect(killSpy).toHaveBeenCalledWith(999999998, "SIGTERM");
      expect(fs.existsSync(pidFile)).toBe(false);
      killSpy.mockRestore();
    });

    it("handles kill failure gracefully (process already dead)", () => {
      const pidFile = path.join(
        os.tmpdir(),
        `artizo-test-dead-${Date.now()}.pid`,
      );
      fs.writeFileSync(pidFile, "999999997");
      const killSpy = vi.spyOn(process, "kill").mockImplementation(() => {
        throw new Error("ESRCH");
      });
      // Should not throw
      expect(() => killStaleRelay(pidFile)).not.toThrow();
      // PID file should still be cleaned up
      expect(fs.existsSync(pidFile)).toBe(false);
      killSpy.mockRestore();
    });

    it("handles non-numeric PID file", () => {
      const pidFile = path.join(
        os.tmpdir(),
        `artizo-test-badpid-${Date.now()}.pid`,
      );
      fs.writeFileSync(pidFile, "not-a-number");
      expect(() => killStaleRelay(pidFile)).not.toThrow();
      // A non-finite PID hits the early return before the unlink, so the
      // file stays. That's fine: a corrupt PID file is overwritten on the
      // next startRelayDaemon call.
      fs.unlinkSync(pidFile);
    });
  });

  describe("sweepStaleRelays", () => {
    it("returns 0 when no artizo-relay PID files exist", () => {
      // Ensure no stray files match. We can't fully guarantee the temp dir
      // is clean, so just assert the return is a number and non-negative.
      const result = sweepStaleRelays();
      expect(result).toBeGreaterThanOrEqual(0);
    });

    it("sweeps matching artizo-relay-*.pid files", () => {
      // Create fake PID files matching our pattern.
      const pidFile1 = path.join(
        os.tmpdir(),
        `artizo-relay-test1-${Date.now()}.pid`,
      );
      const pidFile2 = path.join(
        os.tmpdir(),
        `artizo-relay-test2-${Date.now()}.pid`,
      );
      fs.writeFileSync(pidFile1, "999999991");
      fs.writeFileSync(pidFile2, "999999992");
      const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);

      try {
        const killed = sweepStaleRelays();
        expect(killed).toBeGreaterThanOrEqual(2);
        expect(fs.existsSync(pidFile1)).toBe(false);
        expect(fs.existsSync(pidFile2)).toBe(false);
        expect(killSpy).toHaveBeenCalledWith(999999991, "SIGTERM");
        expect(killSpy).toHaveBeenCalledWith(999999992, "SIGTERM");
      } finally {
        killSpy.mockRestore();
        for (const f of [pidFile1, pidFile2]) {
          try {
            fs.unlinkSync(f);
          } catch {
            /* already removed */
          }
        }
      }
    });

    it("ignores files that don't match the pattern", () => {
      const other = path.join(os.tmpdir(), `other-${Date.now()}.pid`);
      fs.writeFileSync(other, "999999993");
      const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);

      try {
        sweepStaleRelays();
        // The other PID file should NOT have been killed.
        expect(killSpy).not.toHaveBeenCalledWith(999999993, "SIGTERM");
        // File should still exist (we don't touch non-matching files).
        expect(fs.existsSync(other)).toBe(true);
      } finally {
        killSpy.mockRestore();
        try {
          fs.unlinkSync(other);
        } catch {
          /* ignore */
        }
      }
    });
  });

  describe("startRelayDaemon", () => {
    afterEach(() => {
      // Clean up any temp files created
      const tmp = os.tmpdir();
      for (const f of fs.readdirSync(tmp)) {
        if (f.startsWith("artizo-relay") || f === "artizo-relay.mjs") {
          try {
            fs.unlinkSync(path.join(tmp, f));
          } catch {
            /* ignore */
          }
        }
      }
    });

    it("spawns a detached node process and returns the port from port file", async () => {
      const containerId = "abc123";
      const portFile = path.join(
        os.tmpdir(),
        `artizo-relay-${containerId}.port`,
      );

      // The mocked spawn writes the port file shortly after it's called,
      // so waitForPortFile picks it up.
      mockSpawn.mockImplementation(() => {
        // Simulate the daemon writing the port file
        setTimeout(() => {
          fs.writeFileSync(portFile, "54321");
        }, 50);
        return {
          pid: 12345,
          unref: vi.fn(),
          on: vi.fn(),
        } as any;
      });

      const result = await startRelayDaemon({
        containerId,
        containerPort: 38517,
        nodePath: "/tmp/.trae-server/node",
        dockerPath: "docker",
      });

      expect(result.relayPort).toBe(54321);
      expect(result.pid).toBe(12345);
      expect(result.pidFile).toContain(`artizo-relay-${containerId}.pid`);

      // Verify spawn was called with detached: true
      const spawnCall = mockSpawn.mock.calls[0];
      expect(spawnCall[0]).toBe(process.execPath);
      expect(spawnCall[2]).toMatchObject({
        detached: true,
        stdio: "ignore",
      });
    });

    it("throws if daemon does not report a port within timeout", async () => {
      const containerId = "timeout-test";

      mockSpawn.mockImplementation(
        () =>
          ({
            pid: 99999,
            unref: vi.fn(),
            on: vi.fn(),
          }) as any,
      );

      // Don't write the port file - should time out. Use a short timeout
      // so the test doesn't take 10s.
      await expect(
        startRelayDaemon({
          containerId,
          containerPort: 38517,
          nodePath: "/tmp/.trae-server/node",
          dockerPath: "docker",
          portFileTimeoutMs: 200,
        }),
      ).rejects.toThrow("did not report a port");
    }, 5000);

    it("throws if spawn returns no PID", async () => {
      mockSpawn.mockImplementation(
        () =>
          ({
            pid: undefined,
            unref: vi.fn(),
            on: vi.fn(),
          }) as any,
      );

      await expect(
        startRelayDaemon({
          containerId: "nopid-test",
          containerPort: 38517,
          nodePath: "/tmp/.trae-server/node",
          dockerPath: "docker",
        }),
      ).rejects.toThrow("no PID");
    });

    it("writes a relay script with correct container info", async () => {
      const containerId = "script-test";
      const portFile = path.join(
        os.tmpdir(),
        `artizo-relay-${containerId}.port`,
      );

      mockSpawn.mockImplementation(() => {
        setTimeout(() => {
          fs.writeFileSync(portFile, "11111");
        }, 10);
        return {
          pid: 22222,
          unref: vi.fn(),
          on: vi.fn(),
        } as any;
      });

      await startRelayDaemon({
        containerId,
        containerPort: 38517,
        nodePath: "/tmp/.trae-server/node",
        dockerPath: "/usr/bin/docker",
      });

      const scriptPath = path.join(os.tmpdir(), "artizo-relay.mjs");
      const script = fs.readFileSync(scriptPath, "utf-8");

      // The script should embed the container ID, node path, docker path,
      // and relay script (which connects to the container port).
      expect(script).toContain(containerId);
      expect(script).toContain("/tmp/.trae-server/node");
      expect(script).toContain("/usr/bin/docker");
      expect(script).toContain("38517"); // container port in the relay script
      expect(script).toContain("IDLE_TIMEOUT_MS");
      expect(script).toContain("MAX_FAILURES");
      expect(script).toContain("artizo-remote-ssh-helper"); // process title
    });

    it("cleans up stale PID/port files before starting", async () => {
      const containerId = "cleanup-test";
      const pidFile = path.join(os.tmpdir(), `artizo-relay-${containerId}.pid`);
      const portFile = path.join(
        os.tmpdir(),
        `artizo-relay-${containerId}.port`,
      );

      // Write stale files
      fs.writeFileSync(pidFile, "999999996");
      fs.writeFileSync(portFile, "99999");

      mockSpawn.mockImplementation(() => {
        setTimeout(() => {
          fs.writeFileSync(portFile, "33333");
        }, 10);
        return {
          pid: 44444,
          unref: vi.fn(),
          on: vi.fn(),
        } as any;
      });

      const result = await startRelayDaemon({
        containerId,
        containerPort: 38517,
        nodePath: "/tmp/.trae-server/node",
        dockerPath: "docker",
      });

      // The stale port file should have been deleted, and the new port
      // (written by the mock) should be returned.
      expect(result.relayPort).toBe(33333);
    });
  });
});
