/*
 * Copyright (c) 2026 Aergic Labs, LLC
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";
import type { ExecServer } from "../../src/remote/execServerBridge";
vi.mock("vscode", () => ({
  workspace: {
    getConfiguration: vi.fn().mockReturnValue({
      get: vi.fn().mockReturnValue("docker"),
    }),
  },
}));

import {
  probeRelaySocket,
  healRelay,
  type HealParams,
} from "../../src/remote/relayHeal";
import {
  stableMetaPath,
  stablePidPath,
  type StableWorkspaceIdentity,
} from "../../src/remote/containerProxy";

interface ScriptedSpawn {
  status?: number;
  out?: string;
  err?: string;
}

/** A stateful fake ExecServer backed by an in-memory file map. */
interface FakeExecServer extends ExecServer {
  files: Map<string, string>;
  spawnCalls: Array<{ cmd: string; args: string[] }>;
}

function makeFakeExecServer(opts: {
  spawnImpl?: (
    cmd: string,
    args: string[],
    files: Map<string, string>,
  ) => ScriptedSpawn;
  tcpConnectImpl?: (host: string, port: number) => Promise<void>;
} = {}): FakeExecServer {
  const files = new Map<string, string>();
  const spawnCalls: Array<{ cmd: string; args: string[] }> = [];
  const server: FakeExecServer = {
    files,
    spawnCalls,
    tcpConnect: vi.fn(async (host: string, port: number) => {
      if (opts.tcpConnectImpl) {
        await opts.tcpConnectImpl(host, port);
      } else {
        throw new Error("ECONNREFUSED");
      }
      return {
        stream: { write: vi.fn(), end: vi.fn(), onDidReceiveMessage: vi.fn() },
        done: Promise.resolve(),
      };
    }),
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
      const scripted = opts.spawnImpl ? opts.spawnImpl(cmd, args, files) : {};
      const stdoutCbs: ((d: Uint8Array) => void)[] = [];
      const stderrCbs: ((d: Uint8Array) => void)[] = [];
      let exitResolve!: (e: { status: number; message?: string }) => void;
      const onExit = new Promise<{ status: number; message?: string }>((r) => {
        exitResolve = r;
      });
      let emitted = false;
      const emitLater = () => {
        if (emitted) return;
        emitted = true;
        setTimeout(() => {
          if (scripted.out) {
            const b = Buffer.from(scripted.out, "utf-8");
            for (const cb of stdoutCbs)
              cb(new Uint8Array(b.buffer, b.byteOffset, b.byteLength));
          }
          if (scripted.err) {
            const b = Buffer.from(scripted.err, "utf-8");
            for (const cb of stderrCbs)
              cb(new Uint8Array(b.buffer, b.byteOffset, b.byteLength));
          }
          if (typeof scripted.status === "number") {
            exitResolve({ status: scripted.status });
          }
        }, 0);
      };
      return {
        stdin: { write: vi.fn(), end: vi.fn() },
        stdout: {
          onDidReceiveMessage: (cb: (d: Uint8Array) => void) => {
            stdoutCbs.push(cb);
            emitLater();
          },
          onEnd: Promise.resolve(),
        },
        stderr: {
          onDidReceiveMessage: (cb: (d: Uint8Array) => void) => {
            stderrCbs.push(cb);
            emitLater();
          },
          onEnd: Promise.resolve(),
        },
        onExit,
      };
    }),
  };
  return server;
}

const identity: StableWorkspaceIdentity = {
  sshHost: "34.136.190.14",
  sshUser: "dev",
  sshPort: 22,
  hostWorkspacePath: "/home/ubuntu/foo",
  workspacePath: "/workspaces/foo",
};

const baseParams: HealParams = {
  identity,
  metaFileTimeoutMs: 200,
};

const META_HOST_NODE = "/opt/kiro-server/bin/abc/node";
const META_CONTAINER_NODE = "/tmp/.trae-server/node";
const META_FILE = stableMetaPath(identity);
const PID_FILE = stablePidPath(identity);

/** Heal info the relay writes at startup. */
function metaJson(
  overrides: Partial<{
    nodePath: string;
    installPath: string;
    containerId: string;
    containerPort: number;
  }> = {},
): string {
  return JSON.stringify({
    hostNodePath: META_HOST_NODE,
    nodePath: META_CONTAINER_NODE,
    containerId: "abc123fullid",
    containerPort: 38517,
    ...overrides,
  });
}

describe("probeRelaySocket", () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  it("returns true when tcpConnect succeeds", async () => {
    const server = makeFakeExecServer({ tcpConnectImpl: async () => {} });
    const result = await probeRelaySocket(server, 12345, () => {}, 1000);
    expect(result).toBe(true);
  });

  it("returns false when tcpConnect throws", async () => {
    const server = makeFakeExecServer();
    const result = await probeRelaySocket(server, 12345, () => {}, 1000);
    expect(result).toBe(false);
  });

  it("returns false on timeout", async () => {
    const server = makeFakeExecServer({
      tcpConnectImpl: () => new Promise(() => {}), // never resolves
    });
    const result = await probeRelaySocket(server, 12345, () => {}, 50);
    expect(result).toBe(false);
  });
});

describe("healRelay", () => {
  it("returns container-missing with friendly name when docker inspect says not running", async () => {
    const server = makeFakeExecServer({
      spawnImpl: (cmd) => {
        if (cmd === "docker") return { status: 0, out: "false\n" };
        return { status: 0, out: "" };
      },
    });
    server.files.set(META_FILE, metaJson());
    const result = await healRelay(server, baseParams, () => {});
    expect(result.kind).toBe("container-missing");
    if (result.kind === "container-missing") {
      expect(result.message).toContain("foo");
      expect(result.message).not.toContain("abc123fullid");
      expect(result.message.toLowerCase()).toContain("rebuild");
    }
  });

  it("returns container-missing when docker inspect exits non-zero", async () => {
    const server = makeFakeExecServer({
      spawnImpl: (cmd) => {
        if (cmd === "docker") {
          return { status: 1, out: "", err: "No such container" };
        }
        return { status: 0, out: "" };
      },
    });
    server.files.set(META_FILE, metaJson());
    const result = await healRelay(server, baseParams, () => {});
    expect(result.kind).toBe("container-missing");
    if (result.kind === "container-missing") {
      expect(result.message).toContain("foo");
    }
  });

  it("spawns the daemon with config from the meta file", async () => {
    const server = makeFakeExecServer({
      spawnImpl: (cmd, _args, files) => {
        if (cmd === "docker") return { status: 0, out: "true\n" };
        // The relay writes its pid file once listening.
        files.set(PID_FILE, "1234");
        return {};
      },
    });
    server.files.set(META_FILE, metaJson());

    const result = await healRelay(server, baseParams, () => {});
    expect(result.kind).toBe("ok");

    const relaySpawn = server.spawnCalls.find((s) => s.cmd === META_HOST_NODE);
    expect(relaySpawn).toBeDefined();
    expect(relaySpawn!.args[0]).toBe("/tmp/artizo-relay.cjs");
    const config = JSON.parse(relaySpawn!.args[1] as string);
    expect(config).toMatchObject({
      containerId: "abc123fullid",
      containerPort: 38517,
      nodePath: META_CONTAINER_NODE,
      hostNodePath: META_HOST_NODE,
      port: 0,
      spawnedBy: "heal",
    });
  });

  it("returns error when the relay does not write its pid file in time", async () => {
    const server = makeFakeExecServer({
      spawnImpl: (cmd) => {
        if (cmd === "docker") return { status: 0, out: "true\n" };
        return {};
      },
    });
    server.files.set(META_FILE, metaJson());

    const result = await healRelay(server, baseParams, () => {});
    expect(result.kind).toBe("error");
    if (result.kind === "error") {
      expect(result.message).toMatch(/did not start/);
    }
  });

  it("returns no-heal-info when the meta file is missing", async () => {
    const server = makeFakeExecServer();
    const result = await healRelay(server, baseParams, () => {});
    expect(result.kind).toBe("no-heal-info");
  });

  it("returns error when the meta file is incomplete", async () => {
    const server = makeFakeExecServer();
    server.files.set(
      META_FILE,
      JSON.stringify({ containerId: "abc123fullid" }),
    );
    const result = await healRelay(server, baseParams, () => {});
    expect(result.kind).toBe("error");
    if (result.kind === "error") {
      expect(result.message).toContain("incomplete");
    }
  });

  it("returns no-heal-info when the meta file is unparseable", async () => {
    const server = makeFakeExecServer();
    server.files.set(META_FILE, "not-json{{");
    const result = await healRelay(server, baseParams, () => {});
    expect(result.kind).toBe("no-heal-info");
  });

  it("returns error when ExecServer has no spawn", async () => {
    const server = {
      tcpConnect: vi.fn(),
      // no spawn
    } as unknown as ExecServer;
    const result = await healRelay(server, baseParams, () => {});
    expect(result.kind).toBe("error");
  });

  it("uses containerId short hash when hostWorkspacePath is empty", async () => {
    const emptyHomeIdentity = { ...identity, hostWorkspacePath: "" };
    const server = makeFakeExecServer({
      spawnImpl: (cmd) => {
        if (cmd === "docker") return { status: 1, out: "", err: "nope" };
        return { status: 0, out: "" };
      },
    });
    server.files.set(stableMetaPath(emptyHomeIdentity), metaJson());
    const result = await healRelay(
      server,
      { ...baseParams, identity: emptyHomeIdentity },
      () => {},
    );
    expect(result.kind).toBe("container-missing");
    if (result.kind === "container-missing") {
      // Falls back to first 12 chars of containerId
      expect(result.message).toContain("abc123fullid".slice(0, 12));
    }
  });
});
