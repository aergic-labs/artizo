/*
 * Copyright (c) 2026 Aergic Labs, LLC
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { createHash } from "node:crypto";

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

import {
  decodeSshAuthority,
  stableMetaPath,
  stablePidPath,
  startRelayDaemon,
  type StableWorkspaceIdentity,
} from "../../src/remote/containerProxy";
import type { ExecServer } from "../../src/remote/execServerBridge";

/** A stateful fake ExecServer backed by an in-memory file map. */
interface FakeExecServer extends ExecServer {
  files: Map<string, string>;
  spawnCalls: Array<{ cmd: string; args: string[] }>;
}

function makeFakeExecServer(opts: {
  live?: boolean;
  onSpawn?: (cmd: string, args: string[], files: Map<string, string>) => void;
} = {}): FakeExecServer {
  const files = new Map<string, string>();
  const spawnCalls: Array<{ cmd: string; args: string[] }> = [];
  const server: FakeExecServer = {
    files,
    spawnCalls,
    tcpConnect: vi.fn(async () => {
      if (opts.live) {
        return {
          stream: {
            write: vi.fn(),
            end: vi.fn(),
            onDidReceiveMessage: vi.fn(),
          },
          done: Promise.resolve(),
        };
      }
      throw new Error("ECONNREFUSED");
    }),
    env: vi.fn(async () => ({
      env: { HOME: "/home/dev" },
      osPlatform: "linux",
    })),
    fs: {
      mkdirp: vi.fn(async () => {}),
      write: vi.fn(async (p: string) => {
        let content = "";
        return {
          stream: {
            write: (d: Uint8Array) => {
              content += Buffer.from(d).toString("utf-8");
            },
            end: () => {
              files.set(p, content);
            },
          },
          done: Promise.resolve(),
        };
      }),
      read: vi.fn(async (p: string) => {
        if (!files.has(p)) throw new Error(`ENOENT: ${p}`);
        const content = files.get(p)!;
        return {
          onDidReceiveMessage: (cb: (d: Uint8Array) => void) => {
            cb(new Uint8Array(Buffer.from(content)));
          },
          onEnd: Promise.resolve(),
        };
      }),
      stat: vi.fn(async (p: string) => {
        if (!files.has(p)) throw new Error(`ENOENT: ${p}`);
        return { type: 1, size: 0, mtime: 0, ctime: 0 };
      }),
      rm: vi.fn(async (p: string) => {
        files.delete(p);
      }),
      rename: vi.fn(async () => {}),
      readdir: vi.fn(async () => []),
    },
    spawn: vi.fn(async (cmd: string, args: string[]) => {
      spawnCalls.push({ cmd, args });
      opts.onSpawn?.(cmd, args, files);
      return {
        stdin: { write: vi.fn(), end: vi.fn() },
        stdout: { onDidReceiveMessage: vi.fn(), onEnd: Promise.resolve() },
        stderr: { onDidReceiveMessage: vi.fn(), onEnd: Promise.resolve() },
        onExit: new Promise<{ status: number }>(() => {}),
      };
    }),
  };
  return server;
}

/** Build a valid ssh-remote+<hex> authority from a hostName/user object. */
function makeSshAuthority(hostName: string, user: string): string {
  const json = JSON.stringify({ hostName, user });
  const hex = Buffer.from(json, "utf-8").toString("hex");
  return `ssh-remote+${hex}`;
}

describe("containerProxy", () => {
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
      const json = JSON.stringify({
        hostName: "1.2.3.4",
        user: "dev",
        port: 2222,
      });
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
      const json = JSON.stringify({
        hostName: "1.2.3.4",
        user: "dev",
        port: "bogus",
      });
      const hex = Buffer.from(json, "utf-8").toString("hex");
      expect(decodeSshAuthority(`ssh-remote+${hex}`)?.sshPort).toBe(22);
    });
  });

  describe("startRelayDaemon", () => {
    const daemonSource = "// relay daemon test source";
    let daemonPath: string;
    let targetPath: string;

    const daemonHash = createHash("sha256")
      .update(daemonSource)
      .digest("hex")
      .slice(0, 16);

    function makeIdentity(workspacePath: string): StableWorkspaceIdentity {
      return {
        sshHost: "34.136.190.14",
        sshUser: "dev",
        sshPort: 22,
        hostWorkspacePath: "/home/dev/app",
        workspacePath,
      };
    }

    function start(
      execServer: ExecServer,
      identity: StableWorkspaceIdentity,
      extra: Partial<Parameters<typeof startRelayDaemon>[0]> = {},
    ) {
      return startRelayDaemon({
        execServer,
        hostNodePath: "/home/dev/.kiro-server/bin/abc/node",
        logFile: "/home/dev/.artizo/logs/relay.log",
        containerId: "abc123",
        containerPort: 38517,
        nodePath: "/tmp/.artizo-server/abc/node",
        dockerPath: "docker",
        identity,
        relayScriptPath: daemonPath,
        relayScriptTargetPath: targetPath,
        ...extra,
      });
    }

    beforeEach(() => {
      daemonPath = path.join(os.tmpdir(), "relay-daemon-src.cjs");
      targetPath = path.join(os.tmpdir(), "relay-daemon-target.cjs");
      fs.writeFileSync(daemonPath, daemonSource);
    });

    it("spawns the relay through the ExecServer and returns the port", async () => {
      const identity = makeIdentity("/workspaces/abc123");
      const metaFile = stableMetaPath(identity);
      const execServer = makeFakeExecServer({
        onSpawn: (_cmd, _args, files) => {
          files.set(metaFile, JSON.stringify({ port: 12345, daemonHash }));
        },
      });

      const result = await start(execServer, identity);

      expect(result.port).toBe(12345);
      expect(result.metaFile).toBe(metaFile);
      expect(result.pidFile).toBe(stablePidPath(identity));
      expect(execServer.spawnCalls).toHaveLength(1);
      expect(execServer.spawnCalls[0].cmd).toBe(
        "/home/dev/.kiro-server/bin/abc/node",
      );
      expect(execServer.spawnCalls[0].args[0]).toBe(targetPath);
    });

    it("throws if the relay never reports a port", async () => {
      const identity = makeIdentity("/workspaces/timeout-test");
      const execServer = makeFakeExecServer();

      await expect(
        start(execServer, identity, { timeoutMs: 200 }),
      ).rejects.toThrow("did not write a port");
    }, 5000);

    it("writes the bundled daemon and passes the config as argv", async () => {
      const identity = makeIdentity("/workspaces/script-test");
      const metaFile = stableMetaPath(identity);
      const execServer = makeFakeExecServer({
        onSpawn: (_cmd, _args, files) => {
          files.set(metaFile, JSON.stringify({ port: 22222, daemonHash }));
        },
      });

      await start(execServer, identity, { dockerPath: "/usr/bin/docker" });

      expect(execServer.files.get(targetPath)).toBe(daemonSource);
      const config = JSON.parse(execServer.spawnCalls[0].args[1] as string);
      expect(config).toMatchObject({
        containerId: "abc123",
        containerPort: 38517,
        nodePath: "/tmp/.artizo-server/abc/node",
        dockerPath: "/usr/bin/docker",
        port: 0,
        hostNodePath: "/home/dev/.kiro-server/bin/abc/node",
      });
    });

    it("cleans up stale meta and pid files before starting", async () => {
      const identity = makeIdentity("/workspaces/cleanup-test");
      const metaFile = stableMetaPath(identity);
      const pidFile = stablePidPath(identity);
      let metaExistedAtSpawn = true;
      let pidExistedAtSpawn = true;
      const execServer = makeFakeExecServer({
        onSpawn: (_cmd, _args, files) => {
          metaExistedAtSpawn = files.has(metaFile);
          pidExistedAtSpawn = files.has(pidFile);
          files.set(metaFile, JSON.stringify({ port: 44444, daemonHash }));
        },
      });
      execServer.files.set(metaFile, JSON.stringify({ nodePath: "/old/node" }));
      execServer.files.set(pidFile, "999999996");

      const result = await start(execServer, identity);

      expect(metaExistedAtSpawn).toBe(false);
      expect(pidExistedAtSpawn).toBe(false);
      expect(result.port).toBe(44444);
    });

    it("reuses a live relay when the daemon hash matches", async () => {
      const identity = makeIdentity("/workspaces/live");
      const metaFile = stableMetaPath(identity);
      const execServer = makeFakeExecServer({ live: true });
      execServer.files.set(
        metaFile,
        JSON.stringify({ daemonHash, port: 5555 }),
      );

      const result = await start(execServer, identity);

      expect(execServer.spawn).not.toHaveBeenCalled();
      expect(result.port).toBe(5555);
    });

    it("replaces a live relay when the daemon hash differs", async () => {
      const identity = makeIdentity("/workspaces/stale");
      const metaFile = stableMetaPath(identity);
      const execServer = makeFakeExecServer({
        live: true,
        onSpawn: (_cmd, _args, files) => {
          files.set(metaFile, JSON.stringify({ port: 6666, daemonHash }));
        },
      });
      execServer.files.set(
        metaFile,
        JSON.stringify({ daemonHash: "old", port: 5555 }),
      );

      const result = await start(execServer, identity);

      expect(execServer.spawn).toHaveBeenCalled();
      expect(result.port).toBe(6666);
    });

    it("throws when the ExecServer lacks fs or spawn", async () => {
      const identity = makeIdentity("/workspaces/no-fs");
      const execServer = { tcpConnect: vi.fn() } as unknown as ExecServer;

      await expect(start(execServer, identity)).rejects.toThrow(
        "missing fs or spawn",
      );
    });
  });
});
