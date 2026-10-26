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
      const authority = makeSshAuthority("34.136.190.14", "dev");
      const result = decodeSshAuthority(authority);
      expect(result).toEqual({
        sshHost: "34.136.190.14",
        sshUser: "dev",
        sshPort: 22,
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
      const json = JSON.stringify({ user: "dev" });
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
        sshPort: 22,
      });
    });

    it("returns undefined for non-string hostName", () => {
      const json = JSON.stringify({ hostName: 123, user: "dev" });
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
        sshPort: 22,
      });
    });

    it("decodes a plain user@host authority", () => {
      expect(decodeSshAuthority("ssh-remote+dev@example.com")).toEqual({
        sshHost: "example.com",
        sshUser: "dev",
        sshPort: 22,
      });
    });

    it("decodes a plain host authority with no user", () => {
      const result = decodeSshAuthority("ssh-remote+example.com");
      expect(result?.sshHost).toBe("example.com");
      expect(result?.sshUser).toBe(os.userInfo().username);
    });

    it("decodes a plain user@host:port authority", () => {
      expect(decodeSshAuthority("ssh-remote+dev@host.example:2222")).toEqual({
        sshHost: "host.example",
        sshUser: "dev",
        sshPort: 2222,
      });
    });

    it("decodes a plain host:port authority with no user", () => {
      const result = decodeSshAuthority("ssh-remote+host.example:2222");
      expect(result?.sshHost).toBe("host.example");
      expect(result?.sshUser).toBe(os.userInfo().username);
      expect(result?.sshPort).toBe(2222);
    });

    it("decodes a plain user@host authority with leading whitespace", () => {
      expect(decodeSshAuthority("ssh-remote+ dev@example.com")).toEqual({
        sshHost: "example.com",
        sshUser: "dev",
        sshPort: 22,
      });
    });

    it("unescapes \\xNN sequences for uppercase hostnames", () => {
      // VS Code lowercases the authority; uppercase letters are escaped.
      const host = "MyHost.example";
      const escaped = host.replace(
        /[A-Z]/g,
        (ch) => `\\x${ch.charCodeAt(0).toString(16).toLowerCase()}`,
      );
      expect(decodeSshAuthority(`ssh-remote+dev@${escaped}`)).toEqual({
        sshHost: "MyHost.example",
        sshUser: "dev",
        sshPort: 22,
      });
    });

    it("returns undefined for a plain authority without a host", () => {
      expect(decodeSshAuthority("ssh-remote+")).toBeUndefined();
    });

    it("decodes a port from hex-JSON authority", () => {
      const json = JSON.stringify({ hostName: "1.2.3.4", user: "dev", port: 2222 });
      const hex = Buffer.from(json, "utf-8").toString("hex");
      expect(decodeSshAuthority(`ssh-remote+${hex}`)).toEqual({
        sshHost: "1.2.3.4",
        sshUser: "dev",
        sshPort: 2222,
      });
    });

    it("falls back to port 22 when hex-JSON port is missing", () => {
      const json = JSON.stringify({ hostName: "1.2.3.4", user: "dev" });
      const hex = Buffer.from(json, "utf-8").toString("hex");
      expect(decodeSshAuthority(`ssh-remote+${hex}`)?.sshPort).toBe(22);
    });

    it("ignores a non-numeric port in hex-JSON", () => {
      const json = JSON.stringify({ hostName: "1.2.3.4", user: "dev", port: "bogus" });
      const hex = Buffer.from(json, "utf-8").toString("hex");
      expect(decodeSshAuthority(`ssh-remote+${hex}`)?.sshPort).toBe(22);
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

    it("spawns a detached node process and returns the port from meta file", async () => {
      const containerId = "abc123";
      const metaFile = path.join(
        os.tmpdir(),
        `artizo-relay-${containerId}.meta.json`,
      );

      // The mocked spawn writes the meta file shortly after it's called,
      // so waitForMetaFile picks it up.
      mockSpawn.mockImplementation(() => {
        // Simulate the daemon writing the meta file (JSON {port, nodePath}).
        setTimeout(() => {
          fs.writeFileSync(
            metaFile,
            JSON.stringify({ port: 54321, nodePath: process.execPath }),
          );
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
          metaFileTimeoutMs: 200,
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
      const metaFile = path.join(
        os.tmpdir(),
        `artizo-relay-${containerId}.meta.json`,
      );

      mockSpawn.mockImplementation(() => {
        setTimeout(() => {
          fs.writeFileSync(
            metaFile,
            JSON.stringify({ port: 11111, nodePath: process.execPath }),
          );
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
      // The script must embed the host node path (process.execPath) so the
      // apex-side heal can re-spawn using the same binary. The path is embedded
      // via JSON.stringify, so on Windows it has escaped backslashes.
      expect(script).toContain(JSON.stringify(process.execPath));
      expect(script).toContain("META_FILE");
      expect(script).toContain("HOST_NODE_PATH");
      expect(script).not.toContain("PORT_FILE");
    });

    it("cleans up stale PID/meta files before starting", async () => {
      const containerId = "cleanup-test";
      const pidFile = path.join(os.tmpdir(), `artizo-relay-${containerId}.pid`);
      const metaFile = path.join(
        os.tmpdir(),
        `artizo-relay-${containerId}.meta.json`,
      );

      // Write stale files
      fs.writeFileSync(pidFile, "999999996");
      fs.writeFileSync(
        metaFile,
        JSON.stringify({ port: 99999, nodePath: "/old/node" }),
      );

      mockSpawn.mockImplementation(() => {
        setTimeout(() => {
          fs.writeFileSync(
            metaFile,
            JSON.stringify({ port: 33333, nodePath: process.execPath }),
          );
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

      // The stale meta file should have been deleted, and the new port
      // (written by the mock) should be returned.
      expect(result.relayPort).toBe(33333);
    });
  });
});
