/*
 * Copyright (c) 2026 Aergic Labs, LLC
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";
import type { ExecServer } from "../../src/remote/execServerBridge";
import {
  probeRelayPort,
  healRelay,
  type HealParams,
} from "../../src/remote/relayHeal";

/** Minimal fake proc that records spawned commands and lets the test
 * script stdout/stderr/exit synchronously. */
interface FakeProc {
  command: string;
  args: string[];
  stdin: { write: Mock; end: Mock };
  stdout: { onDidReceiveMessage: (cb: (d: Uint8Array) => void) => void };
  stderr: { onDidReceiveMessage: (cb: (d: Uint8Array) => void) => void };
  onExit: Promise<{ status: number; message?: string }>;
}

interface ScriptedSpawn {
  status?: number;
  out?: string;
  err?: string;
}

function makeFakeExecServer(opts: {
  spawnImpl?: (command: string, args: string[]) => ScriptedSpawn;
  tcpConnectImpl?: (
    host: string,
    port: number,
  ) => Promise<{ ok: true } | { ok: false }>;
}): ExecServer {
  const spawnFn = vi.fn(async (command: string, args: string[]) => {
    const scripted = opts.spawnImpl ? opts.spawnImpl(command, args) : {};
    const stdoutCbs: ((d: Uint8Array) => void)[] = [];
    const stderrCbs: ((d: Uint8Array) => void)[] = [];
    let exitResolve!: (e: { status: number; message?: string }) => void;
    const onExit = new Promise<{ status: number; message?: string }>((r) => {
      exitResolve = r;
    });
    // Defer emission to a macrotask so callers have a chance to attach
    // onDidReceiveMessage callbacks before the data fires. Microtask deferral
    // is not enough: the async spawnFn's promise resolution is itself a
    // microtask scheduled after our queueMicrotask, so the emit would fire
    // before `await execServer.spawn()` resumes in the caller.
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
    let emitted = false;
    const proc: FakeProc = {
      command,
      args,
      stdin: { write: vi.fn(), end: vi.fn() },
      stdout: {
        onDidReceiveMessage: (cb) => {
          stdoutCbs.push(cb);
          emitLater();
        },
      },
      stderr: {
        onDidReceiveMessage: (cb) => {
          stderrCbs.push(cb);
          emitLater();
        },
      },
      onExit,
    };
    return proc;
  });
  const tcpConnectFn = vi.fn(async (host: string, port: number) => {
    if (!opts.tcpConnectImpl) {
      throw new Error(`connection refused: ${host}:${port}`);
    }
    const r = await opts.tcpConnectImpl(host, port);
    if (r.ok) {
      return {
        stream: { write: vi.fn(), end: vi.fn(), onDidReceiveMessage: vi.fn() },
        done: Promise.resolve(),
      };
    }
    throw new Error(`connection refused: ${host}:${port}`);
  });
  return {
    spawn: spawnFn as unknown as ExecServer["spawn"],
    tcpConnect: tcpConnectFn as unknown as ExecServer["tcpConnect"],
  } as ExecServer;
}

const baseParams: HealParams = {
  containerId: "abc123fullid",
  containerPort: 38517,
  installPath: "/tmp/.trae-server",
  hostWorkspacePath: "/home/ubuntu/foo",
  portFileTimeoutMs: 200,
};

describe("probeRelayPort", () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  it("returns true when tcpConnect succeeds", async () => {
    const server = makeFakeExecServer({
      tcpConnectImpl: async () => ({ ok: true }),
    });
    const result = await probeRelayPort(server, 45157, () => {}, 1000);
    expect(result).toBe(true);
  });

  it("returns false when tcpConnect throws", async () => {
    const server = makeFakeExecServer({
      tcpConnectImpl: async () => ({ ok: false }),
    });
    const result = await probeRelayPort(server, 45157, () => {}, 1000);
    expect(result).toBe(false);
  });

  it("returns false on timeout", async () => {
    const server = makeFakeExecServer({
      tcpConnectImpl: () => new Promise(() => {}), // never resolves
    });
    const result = await probeRelayPort(server, 45157, () => {}, 50);
    expect(result).toBe(false);
  });
});

describe("healRelay", () => {
  it("returns container-missing with friendly name when docker inspect says not running", async () => {
    const server = makeFakeExecServer({
      spawnImpl: (cmd, args) => {
        if (cmd === "docker" && args[0] === "inspect") {
          return { status: 0, out: "false\n" };
        }
        return { status: 0, out: "" };
      },
    });
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
      spawnImpl: (cmd, args) => {
        if (cmd === "docker" && args[0] === "inspect") {
          return { status: 1, out: "", err: "No such container" };
        }
        return { status: 0, out: "" };
      },
    });
    const result = await healRelay(server, baseParams, () => {});
    expect(result.kind).toBe("container-missing");
    if (result.kind === "container-missing") {
      expect(result.message).toContain("foo");
    }
  });

  it("ships script and respawns relay, returns new port", async () => {
    const spawned: { cmd: string; args: string[] }[] = [];
    const server = makeFakeExecServer({
      spawnImpl: (cmd, args) => {
        spawned.push({ cmd, args });
        if (cmd === "docker" && args[0] === "inspect") {
          return { status: 0, out: "true\n" };
        }
        if (cmd === "sh" && args[0] === "-c" && args[1].includes("cat >")) {
          // script write
          return { status: 0, out: "" };
        }
        if (cmd === "sh" && args[0] === "-c" && args[1].includes("nohup")) {
          // spawn+poll: emit new port
          return { status: 0, out: "41234\n" };
        }
        return { status: 0, out: "" };
      },
    });
    const result = await healRelay(server, baseParams, () => {});
    expect(result.kind).toBe("ok");
    if (result.kind === "ok") {
      expect(result.relayPort).toBe(41234);
    }
    // Verify the inspect, the script write, and the nohup poll all ran.
    const inspected = spawned.some(
      (s) => s.cmd === "docker" && s.args[0] === "inspect",
    );
    const wroteScript = spawned.some(
      (s) => s.cmd === "sh" && s.args[1].includes("artizo-relay.mjs"),
    );
    const spawnedRelay = spawned.some(
      (s) => s.cmd === "sh" && s.args[1].includes("nohup node"),
    );
    expect(inspected).toBe(true);
    expect(wroteScript).toBe(true);
    expect(spawnedRelay).toBe(true);
  });

  it("returns error when relay does not report a port in time", async () => {
    const server = makeFakeExecServer({
      spawnImpl: (cmd, args) => {
        if (cmd === "docker" && args[0] === "inspect") {
          return { status: 0, out: "true\n" };
        }
        if (cmd === "sh" && args[0] === "-c" && args[1].includes("cat >")) {
          return { status: 0, out: "" };
        }
        // poll times out
        return { status: 1, out: "", err: "TIMEOUT" };
      },
    });
    const result = await healRelay(server, baseParams, () => {});
    expect(result.kind).toBe("error");
    if (result.kind === "error") {
      expect(result.message).toMatch(/did not report a port|TIMEOUT/);
    }
  });

  it("returns error when script write fails", async () => {
    const server = makeFakeExecServer({
      spawnImpl: (cmd) => {
        if (cmd === "docker") return { status: 0, out: "true\n" };
        if (cmd === "sh") {
          // Distinguish by args; first sh call is the cat-write.
          return { status: 1, out: "", err: "Permission denied" };
        }
        return { status: 0, out: "" };
      },
    });
    const result = await healRelay(server, baseParams, () => {});
    expect(result.kind).toBe("error");
    if (result.kind === "error") {
      expect(result.message).toContain("ship relay script");
    }
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
    const server = makeFakeExecServer({
      spawnImpl: (cmd) => {
        if (cmd === "docker") return { status: 1, out: "", err: "nope" };
        return { status: 0, out: "" };
      },
    });
    const result = await healRelay(
      server,
      { ...baseParams, hostWorkspacePath: "" },
      () => {},
    );
    expect(result.kind).toBe("container-missing");
    if (result.kind === "container-missing") {
      // Falls back to first 12 chars of containerId
      expect(result.message).toContain("abc123fullid".slice(0, 12));
    }
  });
});
