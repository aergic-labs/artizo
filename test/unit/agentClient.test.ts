/*
 * Copyright (c) 2026 Aergic Labs, LLC
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, it, expect, vi } from "vitest";

vi.mock("vscode", () => ({
  workspace: {
    getConfiguration: () => ({ get: (_k: string, d: unknown) => d }),
  },
  window: {
    createOutputChannel: () => ({
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
      trace: vi.fn(),
      appendLine: vi.fn(),
    }),
  },
}));
import {
  AgentClient,
  getOrCreateAgent,
  setAgentExtensionPath,
} from "../../src/remote/agentClient";
import { createRemoteCliHost } from "../../src/remote/remoteCliHost";
import type { ExecServer, SpawnedCommand } from "../../src/remote/execServerBridge";

/**
 * Fake spawned agent process: decodes frames written to stdin and lets the test
 * push frames back through stdout.
 */
function fakeAgent() {
  const frames: Array<{ type: number; id: number; payload: Buffer }> = [];
  const stdoutCbs: Array<(d: Uint8Array) => void> = [];
  const stderrCbs: Array<(d: Uint8Array) => void> = [];
  let buf = Buffer.alloc(0);
  let exitResolve!: (v: { status: number }) => void;
  const onExit = new Promise<{ status: number }>((r) => (exitResolve = r));

  const proc: SpawnedCommand = {
    stdin: {
      write(data: Uint8Array) {
        buf = Buffer.concat([buf, Buffer.from(data)]);
        while (buf.length >= 9) {
          const type = buf[0];
          const id = buf.readUInt32BE(1);
          const len = buf.readUInt32BE(5);
          if (buf.length < 9 + len) return;
          frames.push({ type, id, payload: buf.subarray(9, 9 + len) });
          buf = buf.subarray(9 + len);
        }
      },
      end() {},
    },
    stdout: { onDidReceiveMessage: (cb) => stdoutCbs.push(cb), onEnd: Promise.resolve() },
    stderr: { onDidReceiveMessage: (cb) => stderrCbs.push(cb), onEnd: Promise.resolve() },
    onExit,
  };

  const sendFrame = (type: number, id: number, payload: Buffer, split = false) => {
    const hdr = Buffer.alloc(9);
    hdr[0] = type;
    hdr.writeUInt32BE(id, 1);
    hdr.writeUInt32BE(payload.length, 5);
    const all = Buffer.concat([hdr, payload]);
    if (split) {
      for (const chunk of [all.subarray(0, 4), all.subarray(4, 11), all.subarray(11)]) {
        for (const cb of stdoutCbs) cb(new Uint8Array(chunk));
      }
    } else {
      for (const cb of stdoutCbs) cb(new Uint8Array(all));
    }
  };

  return { proc, frames, sendFrame, exitResolve };
}

const flush = () => new Promise((r) => setImmediate(r));

describe("AgentClient", () => {
  it("sends EXEC and routes stdout/stderr/exit back", async () => {
    const agent = fakeAgent();
    const client = new AgentClient(agent.proc);

    const handle = client.exec({ cmd: "ls", args: ["-l"], cwd: "/tmp", env: { A: "1" } });
    await flush();

    expect(agent.frames).toHaveLength(1);
    expect(agent.frames[0].type).toBe(1);
    expect(agent.frames[0].id).toBe(1);
    expect(JSON.parse(agent.frames[0].payload.toString())).toEqual({
      cmd: "ls",
      args: ["-l"],
      cwd: "/tmp",
      env: { A: "1" },
    });

    const out: Buffer[] = [];
    const err: Buffer[] = [];
    handle.stdout.on("data", (d: Buffer) => out.push(d));
    handle.stderr.on("data", (d: Buffer) => err.push(d));

    // Deliberately split the frames across reads to exercise buffering.
    agent.sendFrame(101, 1, Buffer.from("hello"), true);
    agent.sendFrame(102, 1, Buffer.from("oops"), true);
    agent.sendFrame(103, 1, Buffer.from(JSON.stringify({ code: 3 })), true);
    await flush();

    expect(Buffer.concat(out).toString()).toBe("hello");
    expect(Buffer.concat(err).toString()).toBe("oops");
    await expect(handle.exit).resolves.toEqual({ code: 3, signal: null });
  });

  it("writes STDIN and STDIN_END frames", async () => {
    const agent = fakeAgent();
    const client = new AgentClient(agent.proc);
    const handle = client.exec({ cmd: "cat" });
    await flush();

    handle.stdin.write(Buffer.from("abc"));
    handle.stdin.end();
    await flush();

    const types = agent.frames.map((f) => f.type);
    expect(types).toEqual([1, 2, 3]);
    expect(agent.frames[1].payload.toString()).toBe("abc");
  });

  it("sends TERMINATE for terminate()", async () => {
    const agent = fakeAgent();
    const client = new AgentClient(agent.proc);
    const handle = client.exec({ cmd: "sleep", args: ["10"] });
    await flush();

    await handle.terminate();
    await flush();

    expect(agent.frames.map((f) => f.type)).toEqual([1, 4]);
    expect(agent.frames[1].id).toBe(1);
  });

  it("rejects pending execs when the agent exits", async () => {
    const agent = fakeAgent();
    const client = new AgentClient(agent.proc);
    const handle = client.exec({ cmd: "sleep", args: ["10"] });
    const settled = handle.exit.catch((e: Error) => e);
    await flush();

    agent.exitResolve({ status: 1 });
    await flush();

    expect((await settled as Error).message).toMatch(/agent exited/);
  });

  it("surfaces agent ERROR frames as rejection with the parsed message", async () => {
    const agent = fakeAgent();
    const client = new AgentClient(agent.proc);
    const handle = client.exec({ cmd: "nope" });
    const settled = handle.exit.catch((e: Error) => e);
    await flush();

    agent.sendFrame(104, 1, Buffer.from(JSON.stringify({ message: "no such file" })));
    await flush();

    expect(((await settled) as Error).message).toBe("no such file");
  });

  it("rejects exec() after the agent exits", async () => {
    const agent = fakeAgent();
    const client = new AgentClient(agent.proc);
    agent.exitResolve({ status: 0 });
    await flush();

    expect(() => client.exec({ cmd: "ls" })).toThrow(/closed/);
  });
});

describe("getOrCreateAgent", () => {
  it("returns undefined and does not cache without an extension path", async () => {
    setAgentExtensionPath(undefined);
    const es = { tcpConnect: vi.fn() } as unknown as ExecServer;
    await expect(getOrCreateAgent(es)).resolves.toBeUndefined();
  });

  it("caches one promise per ExecServer", async () => {
    setAgentExtensionPath("/nonexistent-extension");
    const es = {
      tcpConnect: vi.fn(),
      spawn: vi.fn(),
      fs: {},
      env: async () => ({ env: {}, osPlatform: "linux" }),
    } as unknown as ExecServer;
    const a = getOrCreateAgent(es);
    const b = getOrCreateAgent(es);
    expect(a).toBe(b);
    // Binary is missing, so the agent is unavailable.
    await expect(a).resolves.toBeUndefined();
  });
});

describe("RemoteCliHost exec fallback", () => {
  it("uses ExecServer.spawn when the agent is unavailable", async () => {
    setAgentExtensionPath(undefined);
    const writes: Uint8Array[] = [];
    const spawn = vi.fn(async () => {
      let exitResolve!: (v: { status: number }) => void;
      const onExit = new Promise<{ status: number }>((r) => (exitResolve = r));
      setTimeout(() => exitResolve({ status: 0 }), 0);
      return {
        stdin: { write: (d: Uint8Array) => writes.push(d), end() {} },
        stdout: { onDidReceiveMessage: () => {}, onEnd: Promise.resolve() },
        stderr: { onDidReceiveMessage: () => {}, onEnd: Promise.resolve() },
        onExit,
      } satisfies SpawnedCommand;
    });
    const es = {
      tcpConnect: vi.fn(),
      spawn,
      fs: {
        stat: async () => ({ type: 1 }),
        mkdirp: async () => {},
        write: async () => ({ stream: { write() {}, end() {} }, done: Promise.resolve() }),
        read: async () => ({ onDidReceiveMessage: () => {}, onEnd: Promise.resolve() }),
        rm: async () => {},
        rename: async () => {},
        readdir: async () => [],
      },
      env: async () => ({ env: { HOME: "/home/u" }, osPlatform: "linux" }),
    } as unknown as ExecServer;

    const host = await createRemoteCliHost(es, "/home/u/ws");
    const handle = await host.exec({ cmd: "docker", args: ["ps"], cwd: "/home/u/ws" });
    await flush();

    // uname + id -u + id -g, then the exec itself.
    expect(spawn).toHaveBeenCalledTimes(4);
    expect(spawn).toHaveBeenLastCalledWith("docker", ["ps"], {
      cwd: "/home/u/ws",
      env: { HOME: "/home/u" },
    });
    await expect(handle.exit).resolves.toEqual({ code: 0, signal: null });
  });
});