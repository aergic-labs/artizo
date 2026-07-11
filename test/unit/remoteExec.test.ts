/*
 * Copyright (c) 2026 Aergic Labs, LLC
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "node:events";

const { mockSpawn, mockGetRemoteExecServer } = vi.hoisted(() => ({
  mockSpawn: vi.fn(),
  mockGetRemoteExecServer: vi.fn(),
}));

vi.mock("node:child_process", () => ({
  spawn: (...args: unknown[]) => mockSpawn(...args),
}));

vi.mock("../../src/remote/sshTunnel", () => ({
  resolveSshBinary: () => "/usr/bin/ssh",
}));

vi.mock("../../src/remote/containerProxy", () => ({
  decodeSshAuthority: (authority: string | undefined) => {
    if (!authority) return undefined;
    const rest = authority.replace(/^ssh-remote\+/, "");
    if (rest === authority) return undefined;
    return { sshHost: rest, sshUser: "testuser" };
  },
}));

vi.mock("../../src/ssh/askpass", () => ({
  batchModeArgs: (hasAskpass: boolean) =>
    hasAskpass ? [] : ["-o", "BatchMode=yes"],
  sshEnvForAskpass: () => ({}),
  startAskpass: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("vscode", () => ({
  workspace: {
    getRemoteExecServer: mockGetRemoteExecServer,
  },
}));

vi.mock("../../src/utils/logger", () => ({
  getLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    show: vi.fn(),
    dispose: vi.fn(),
  }),
}));

import { SshRemoteExec, getRemoteExec } from "../../src/remote/remoteExec";

const AUTHORITY = "ssh-remote+myhost";

/** Build a fake child_process child (EventEmitter) with stdin/stdout/stderr. */
function makeChild(): any {
  const c = new EventEmitter() as any;
  c.stdin = new EventEmitter();
  c.stdin.write = vi.fn();
  c.stdin.end = vi.fn();
  c.stdin.on = vi.fn();
  c.stdout = new EventEmitter();
  c.stderr = new EventEmitter();
  c.kill = vi.fn();
  c.pid = 12345;
  return c;
}

describe("SshRemoteExec", () => {
  beforeEach(() => {
    mockSpawn.mockReset();
    mockGetRemoteExecServer.mockReset();
  });

  describe("constructor", () => {
    it("throws on undecodable authority", () => {
      expect(() => new SshRemoteExec("badauth")).toThrow(
        /Cannot decode SSH authority/,
      );
    });

    it("accepts a valid ssh-remote+ authority", () => {
      expect(() => new SshRemoteExec(AUTHORITY)).not.toThrow();
    });
  });

  describe("run", () => {
    it("spawns ssh and resolves with collected stdout/stderr", async () => {
      const child = makeChild();
      mockSpawn.mockReturnValue(child);
      const exec = new SshRemoteExec(AUTHORITY);
      const p = exec.run("uname -ms");
      child.stdout.emit("data", Buffer.from("Linux x86_64\n"));
      child.emit("exit", 0);
      const result = await p;
      expect(result.stdout).toBe("Linux x86_64\n");
      expect(result.code).toBe(0);
      expect(mockSpawn).toHaveBeenCalledTimes(1);
      const [binary, args] = mockSpawn.mock.calls[0];
      expect(binary).toBe("/usr/bin/ssh");
      expect(args).toContain("testuser@myhost");
      expect(args).toContain("uname -ms");
    });

    it("writes stdin input and ends stdin", async () => {
      const child = makeChild();
      mockSpawn.mockReturnValue(child);
      const exec = new SshRemoteExec(AUTHORITY);
      const p = exec.run("cat", { stdin: "body" });
      child.emit("exit", 0);
      await p;
      expect(child.stdin.write).toHaveBeenCalledWith("body");
      expect(child.stdin.end).toHaveBeenCalled();
    });

    it("rejects on timeout by killing the process", async () => {
      const child = makeChild();
      mockSpawn.mockReturnValue(child);
      const exec = new SshRemoteExec(AUTHORITY);
      const p = exec.run("sleep 999", { timeout: 50 });
      await expect(p).rejects.toThrow(/timed out/);
      expect(child.kill).toHaveBeenCalledWith("SIGKILL");
    });

    it("rejects on spawn error", async () => {
      const child = makeChild();
      mockSpawn.mockReturnValue(child);
      const exec = new SshRemoteExec(AUTHORITY);
      const p = exec.run("ls");
      child.emit("error", new Error("spawn ENOENT"));
      await expect(p).rejects.toThrow(/spawn ENOENT/);
    });
  });

  describe("streamToStdin", () => {
    it("pipes input to stdin and resolves on exit 0", async () => {
      const child = makeChild();
      mockSpawn.mockReturnValue(child);
      const exec = new SshRemoteExec(AUTHORITY);
      const input = new EventEmitter() as any;
      input.pipe = vi.fn((dest: any) => dest);
      const p = exec.streamToStdin("tar xzf -", input);
      child.emit("exit", 0);
      await p;
      expect(input.pipe).toHaveBeenCalledWith(child.stdin);
    });

    it("rejects on non-zero exit", async () => {
      const child = makeChild();
      mockSpawn.mockReturnValue(child);
      const exec = new SshRemoteExec(AUTHORITY);
      const input = new EventEmitter() as any;
      input.pipe = vi.fn((dest: any) => dest);
      const p = exec.streamToStdin("tar xzf -", input);
      child.emit("exit", 1);
      await expect(p).rejects.toThrow(/stream failed/);
    });

    it("rejects on input stream error and kills the process", async () => {
      const child = makeChild();
      mockSpawn.mockReturnValue(child);
      const exec = new SshRemoteExec(AUTHORITY);
      const input = new EventEmitter() as any;
      input.pipe = vi.fn((dest: any) => dest);
      const p = exec.streamToStdin("tar xzf -", input);
      input.emit("error", new Error("read failed"));
      await expect(p).rejects.toThrow(/input stream error/);
      expect(child.kill).toHaveBeenCalled();
    });
  });
});

describe("ExecServerRemoteExec (via getRemoteExec)", () => {
  it("returns ExecServer-backed exec when getRemoteExecServer is available", async () => {
    const fakeProc = {
      stdin: { write: vi.fn(), end: vi.fn() },
      stdout: {
        onDidReceiveMessage: (cb: (d: Uint8Array) => void) => {
          cb(new TextEncoder().encode("Linux x86_64"));
          return { dispose: vi.fn() };
        },
      },
      stderr: {
        onDidReceiveMessage: () => ({ dispose: vi.fn() }),
      },
      onExit: Promise.resolve({ status: 0 }),
      kill: vi.fn(),
    };
    const mockExecServer = { spawn: vi.fn().mockResolvedValue(fakeProc) };
    mockGetRemoteExecServer.mockResolvedValue(mockExecServer);

    const handle = await getRemoteExec(AUTHORITY, "/fake/ext/path");
    expect(handle.askpass).toBeUndefined();

    const result = await handle.exec.run("uname -ms");
    expect(result.stdout).toBe("Linux x86_64");
    expect(result.code).toBe(0);
    expect(mockExecServer.spawn).toHaveBeenCalledWith("sh", ["-c", "uname -ms"]);

    mockGetRemoteExecServer.mockResolvedValue(undefined);
  });

  it("falls back to SshRemoteExec when getRemoteExecServer returns undefined", async () => {
    mockGetRemoteExecServer.mockResolvedValue(undefined);
    const handle = await getRemoteExec(AUTHORITY, "/fake/ext/path");
    expect(handle.exec).toBeInstanceOf(SshRemoteExec);
  });
});
