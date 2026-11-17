/*
 * Copyright (c) 2026 Aergic Labs, LLC
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { PassThrough } from "node:stream";

const agentExec = vi.fn();
vi.mock("vscode", () => ({
  workspace: {
    getConfiguration: () => ({ get: (_k: string, d: unknown) => d }),
  },
}));
vi.mock("../../src/remote/agentClient", () => ({
  getOrCreateAgent: vi.fn(async () => ({ exec: agentExec })),
}));

import { createRemoteCliHost } from "../../src/remote/remoteCliHost";
import type { ExecServer } from "../../src/remote/execServerBridge";

function makeExecServer() {
  const spawn = vi.fn(async () => ({
    stdin: { write() {}, end() {} },
    stdout: { onDidReceiveMessage: () => {}, onEnd: Promise.resolve() },
    stderr: { onDidReceiveMessage: () => {}, onEnd: Promise.resolve() },
    onExit: Promise.resolve({ status: 0 }),
  }));
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
  return { es, spawn };
}

describe("RemoteCliHost with the agent", () => {
  beforeEach(() => agentExec.mockReset());

  it("routes exec through the agent when it is available", async () => {
    const { es, spawn } = makeExecServer();
    const handle = {
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      exit: Promise.resolve({ code: 0, signal: null }),
      terminate: vi.fn(async () => {}),
    };
    agentExec.mockReturnValue(handle);

    const host = await createRemoteCliHost(es, "/home/u/ws");
    const result = await host.exec({ cmd: "docker", args: ["ps"] });

    expect(result).toBe(handle);
    expect(agentExec).toHaveBeenCalledWith({
      cmd: "docker",
      args: ["ps"],
      cwd: "/home/u/ws",
      env: { HOME: "/home/u" },
    });
    // Only the uname / id probes went through spawn.
    expect(spawn).toHaveBeenCalledTimes(3);
  });
});