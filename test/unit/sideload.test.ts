/*
 * Copyright (c) 2026 Aergic Labs, LLC
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "node:events";
import vscodeMock from "../__mocks__/vscode";

const {
  mockSpawn,
  mockExecFileSync,
  mockReadFileSync,
  mockAppendFileSync,
  mockStatSync,
  mockExistsSync,
  mockUnlinkSync,
  mockMkdirSync,
  mockRmSync,
  mockCreateReadStream,
  mockGetPlatformAdapter,
} = vi.hoisted(() => ({
  mockSpawn: vi.fn(),
  mockExecFileSync: vi.fn(),
  mockReadFileSync: vi.fn(),
  mockAppendFileSync: vi.fn(),
  mockStatSync: vi.fn(),
  mockExistsSync: vi.fn(),
  mockUnlinkSync: vi.fn(),
  mockMkdirSync: vi.fn(),
  mockRmSync: vi.fn(),
  mockCreateReadStream: vi.fn(),
  mockGetPlatformAdapter: vi.fn(),
}));

vi.mock("vscode", () => ({ default: vscodeMock, ...vscodeMock }));

vi.mock("node:child_process", () => ({
  spawn: (...args: unknown[]) => mockSpawn(...args),
  execFileSync: (...args: unknown[]) => mockExecFileSync(...args),
}));

vi.mock("node:fs", () => ({
  default: {
    readFileSync: mockReadFileSync,
    appendFileSync: mockAppendFileSync,
    statSync: mockStatSync,
    existsSync: mockExistsSync,
    unlinkSync: mockUnlinkSync,
    mkdirSync: mockMkdirSync,
    rmSync: mockRmSync,
    createReadStream: mockCreateReadStream,
  },
  readFileSync: mockReadFileSync,
  appendFileSync: mockAppendFileSync,
  statSync: mockStatSync,
  existsSync: mockExistsSync,
  unlinkSync: mockUnlinkSync,
  mkdirSync: mockMkdirSync,
  rmSync: mockRmSync,
  createReadStream: mockCreateReadStream,
}));

vi.mock("../../src/platform", () => ({
  getPlatformAdapter: () => mockGetPlatformAdapter(),
}));

vi.mock("../../src/remote/containerProxy", () => ({
  decodeSshAuthority: (authority: string | undefined) => {
    if (!authority) return undefined;
    // Expected form: ssh-remote+<host>
    const rest = authority.replace(/^ssh-remote\+/, "");
    if (rest === authority) return undefined;
    return { sshHost: rest, sshUser: "testuser" };
  },
}));

vi.mock("../../src/remote/sshTunnel", () => ({
  resolveSshBinary: () => "/usr/bin/ssh",
}));

vi.mock("../../src/host/services", () => ({
  getArgvExtensionId: () => "aergic.artizo-kiro",
}));

vi.mock("../../src/utils/logger", () => ({
  getLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

vi.mock("../../src/extensions/marketplaceClient", () => ({
  MarketplaceClient: vi.fn(),
}));

vi.mock("../../src/extensions/vsixExtract", () => ({
  extractVsix: vi.fn(),
}));

import * as vscode from "vscode";

import { __test } from "../../src/remote/sideload";

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

const AUTHORITY = "ssh-remote+myhost";

describe("homeCacheKey", () => {
  it("builds a globalState key from the authority", () => {
    expect(__test.homeCacheKey("ssh-remote+host")).toBe(
      "remoteHome:ssh-remote+host",
    );
  });
});

describe("resolveTarBinary", () => {
  it("returns tar on non-win32", () => {
    expect(__test.resolveTarBinary()).toBe("tar");
  });
});

describe("shellSingleQuote", () => {
  it("wraps a plain string in single quotes", () => {
    expect(__test.shellSingleQuote("hello")).toBe("'hello'");
  });

  it("escapes embedded single quotes", () => {
    expect(__test.shellSingleQuote("a'b")).toBe("'a'\\\''b'");
  });
});

describe("diag / initDiagPaths", () => {
  beforeEach(() => {
    mockAppendFileSync.mockReset();
    mockMkdirSync.mockReset();
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  it("initDiagPaths includes tmpdir and writes to it", () => {
    const ctx = {
      logPath: "/fake/log/path",
    } as any;
    __test.initDiagPaths(ctx);
    // diag writes a line to DIAG_PATHS via appendFileSync.
    expect(mockAppendFileSync).toHaveBeenCalled();
  });

  it("diag does not throw when appendFileSync fails", () => {
    mockAppendFileSync.mockImplementation(() => {
      throw new Error("EACCES");
    });
    const ctx = { logPath: undefined } as any;
    __test.initDiagPaths(ctx);
    expect(() => __test.diag("hello")).not.toThrow();
  });
});

describe("candidateRelDirs", () => {
  beforeEach(() => {
    mockGetPlatformAdapter.mockReset();
  });

  it("returns adapter candidate dirs", async () => {
    mockGetPlatformAdapter.mockResolvedValue({
      getRemoteExtensionsDirCandidates: () => [".trae-server/extensions"],
    });
    expect(await __test.candidateRelDirs()).toEqual([
      ".trae-server/extensions",
    ]);
  });
});

describe("markerExists", () => {
  beforeEach(() => {
    (vscode as any).workspace.fs.stat.mockReset();
  });

  it("returns true when stat succeeds", async () => {
    (vscode as any).workspace.fs.stat.mockResolvedValue({ size: 0 });
    const dir = vscode.Uri.parse(
      "vscode-remote://host/home/u/.trae-server/extensions",
    );
    expect(await __test.markerExists(dir, "ext-1.0.0")).toBe(true);
  });

  it("returns false when stat rejects", async () => {
    (vscode as any).workspace.fs.stat.mockRejectedValue(new Error("ENOENT"));
    const dir = vscode.Uri.parse(
      "vscode-remote://host/home/u/.trae-server/extensions",
    );
    expect(await __test.markerExists(dir, "ext-1.0.0")).toBe(false);
  });
});

describe("detectRemotePlatform", () => {
  beforeEach(() => {
    __test.resetRemotePlatformCache();
    mockExecFileSync.mockReset();
  });

  it("caches the result across calls", () => {
    mockExecFileSync.mockReturnValue("Linux x86_64\n");
    const first = __test.detectRemotePlatform(AUTHORITY);
    const second = __test.detectRemotePlatform(AUTHORITY);
    expect(first).toBe(second);
    expect(mockExecFileSync).toHaveBeenCalledTimes(1);
  });

  it("throws when authority cannot be decoded", () => {
    expect(() => __test.detectRemotePlatform(undefined)).toThrow(
      /Could not decode SSH authority/,
    );
  });

  it("throws when uname fails", () => {
    mockExecFileSync.mockImplementation(() => {
      throw new Error("ssh failed");
    });
    expect(() => __test.detectRemotePlatform(AUTHORITY)).toThrow(
      /Failed to detect remote platform/,
    );
  });
});

describe("runRemoteCmd", () => {
  const log = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  } as any;

  beforeEach(() => {
    mockSpawn.mockReset();
  });

  it("rejects when authority cannot be decoded", async () => {
    await expect(__test.runRemoteCmd("bad-auth", "ls", log)).rejects.toThrow(
      /Cannot decode SSH authority/,
    );
  });

  it("captures stdout and resolves on exit 0", async () => {
    const child = makeChild();
    mockSpawn.mockReturnValue(child);
    const p = __test.runRemoteCmd(AUTHORITY, "echo hi", log);
    child.stdout.emit("data", Buffer.from("hello\n"));
    child.emit("exit", 0);
    const result = await p;
    expect(result.stdout).toBe("hello\n");
    expect(result.code).toBe(0);
  });

  it("writes stdinInput and closes stdin", async () => {
    const child = makeChild();
    mockSpawn.mockReturnValue(child);
    const p = __test.runRemoteCmd(AUTHORITY, "cat", log, 15_000, "body");
    child.emit("exit", 0);
    await p;
    expect(child.stdin.write).toHaveBeenCalledWith("body");
    expect(child.stdin.end).toHaveBeenCalled();
  });

  it("rejects on spawn error", async () => {
    const child = makeChild();
    mockSpawn.mockReturnValue(child);
    const p = __test.runRemoteCmd(AUTHORITY, "ls", log);
    child.emit("error", new Error("spawn ENOENT"));
    await expect(p).rejects.toThrow(/spawn ENOENT/);
  });
});

describe("probeRemoteHome", () => {
  const log = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  } as any;

  beforeEach(() => {
    mockSpawn.mockReset();
  });

  it("returns undefined when authority cannot be decoded", async () => {
    expect(await __test.probeRemoteHome("bad-auth", log)).toBeUndefined();
  });

  it("returns trimmed HOME on exit 0", async () => {
    const child = makeChild();
    mockSpawn.mockReturnValue(child);
    const p = __test.probeRemoteHome(AUTHORITY, log);
    child.stdout.emit("data", Buffer.from("/home/u\n"));
    child.emit("exit", 0);
    expect(await p).toBe("/home/u");
  });

  it("returns undefined on non-zero exit", async () => {
    const child = makeChild();
    mockSpawn.mockReturnValue(child);
    const p = __test.probeRemoteHome(AUTHORITY, log);
    child.emit("exit", 1);
    expect(await p).toBeUndefined();
  });

  it("returns undefined on spawn error", async () => {
    const child = makeChild();
    mockSpawn.mockReturnValue(child);
    const p = __test.probeRemoteHome(AUTHORITY, log);
    child.emit("error", new Error("spawn failed"));
    expect(await p).toBeUndefined();
  });
});

describe("resolveRemoteHome", () => {
  const log = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  } as any;
  let ctx: any;

  beforeEach(() => {
    mockSpawn.mockReset();
    ctx = {
      globalState: {
        get: vi.fn().mockReturnValue(undefined),
        update: vi.fn().mockResolvedValue(undefined),
      },
    };
  });

  it("infers home from wsPath segments", async () => {
    expect(
      await __test.resolveRemoteHome(AUTHORITY, "/home/u/proj", ctx, log),
    ).toBe("/home/u");
  });

  it("uses cached home from globalState", async () => {
    ctx.globalState.get.mockReturnValue("/cached/home");
    expect(await __test.resolveRemoteHome(AUTHORITY, undefined, ctx, log)).toBe(
      "/cached/home",
    );
  });

  it("falls back to ssh probe", async () => {
    const child = makeChild();
    mockSpawn.mockReturnValue(child);
    const p = __test.resolveRemoteHome(AUTHORITY, undefined, ctx, log);
    child.stdout.emit("data", Buffer.from("/probed/home\n"));
    child.emit("exit", 0);
    expect(await p).toBe("/probed/home");
    expect(ctx.globalState.update).toHaveBeenCalledWith(
      "remoteHome:ssh-remote+myhost",
      "/probed/home",
    );
  });

  it("returns undefined when probe fails", async () => {
    const child = makeChild();
    mockSpawn.mockReturnValue(child);
    const p = __test.resolveRemoteHome(AUTHORITY, undefined, ctx, log);
    child.emit("exit", 1);
    expect(await p).toBeUndefined();
  });

  it("returns undefined for short wsPath", async () => {
    const child = makeChild();
    mockSpawn.mockReturnValue(child);
    const p = __test.resolveRemoteHome(AUTHORITY, "/only", ctx, log);
    child.emit("exit", 1);
    expect(await p).toBeUndefined();
  });
});

describe("findRemoteExtensionsDir", () => {
  const log = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  } as any;
  let ctx: any;

  beforeEach(() => {
    mockGetPlatformAdapter.mockReset();
    (vscode as any).workspace.fs.readDirectory.mockReset();
    ctx = {
      globalState: {
        get: vi.fn().mockReturnValue(undefined),
        update: vi.fn().mockResolvedValue(undefined),
      },
    };
  });

  it("returns the first existing candidate dir", async () => {
    mockGetPlatformAdapter.mockResolvedValue({
      getRemoteExtensionsDirCandidates: () => [".trae-server/extensions"],
    });
    (vscode as any).workspace.fs.readDirectory.mockResolvedValue([]);
    const result = await __test.findRemoteExtensionsDir(
      "/home/u",
      AUTHORITY,
      log,
      ctx,
    );
    expect(result).toBeDefined();
    expect(result?.path).toBe("/home/u/.trae-server/extensions");
    expect(ctx.globalState.update).toHaveBeenCalled();
  });

  it("returns undefined when no candidate exists", async () => {
    mockGetPlatformAdapter.mockResolvedValue({
      getRemoteExtensionsDirCandidates: () => [".trae-server/extensions"],
    });
    (vscode as any).workspace.fs.readDirectory.mockRejectedValue(
      new Error("ENOENT"),
    );
    const result = await __test.findRemoteExtensionsDir(
      "/home/u",
      AUTHORITY,
      log,
      ctx,
    );
    expect(result).toBeUndefined();
  });
});

describe("commitExtensionsJson", () => {
  const log = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  } as any;

  beforeEach(() => {
    (vscode as any).workspace.fs.readFile.mockReset();
    (vscode as any).workspace.fs.writeFile.mockReset();
  });

  it("does nothing for empty entries", async () => {
    const dir = vscode.Uri.parse(
      "vscode-remote://host/home/u/.trae-server/extensions",
    );
    await __test.commitExtensionsJson(dir, [], log);
    expect((vscode as any).workspace.fs.writeFile).not.toHaveBeenCalled();
  });

  it("seeds extensions.json when missing", async () => {
    (vscode as any).workspace.fs.readFile.mockRejectedValue(
      new Error("ENOENT"),
    );
    const dir = vscode.Uri.parse(
      "vscode-remote://host/home/u/.trae-server/extensions",
    );
    await __test.commitExtensionsJson(
      dir,
      [
        {
          folderName: "ext-1.0.0",
          extId: "pub.ext",
          version: "1.0.0",
          publisherDisplayName: "pub",
          targetPlatform: undefined,
        },
      ],
      log,
    );
    expect((vscode as any).workspace.fs.writeFile).toHaveBeenCalledTimes(1);
    const [, content] = (vscode as any).workspace.fs.writeFile.mock.calls[0];
    const text = new TextDecoder().decode(content);
    const parsed = JSON.parse(text);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].identifier.id).toBe("pub.ext");
  });

  it("skips entries already present", async () => {
    const existing = [
      {
        identifier: { id: "pub.ext" },
        version: "1.0.0",
        location: { path: "/x/pub.ext-1.0.0" },
      },
    ];
    (vscode as any).workspace.fs.readFile.mockResolvedValue(
      new TextEncoder().encode(JSON.stringify(existing)),
    );
    const dir = vscode.Uri.parse(
      "vscode-remote://host/home/u/.trae-server/extensions",
    );
    await __test.commitExtensionsJson(
      dir,
      [
        {
          folderName: "pub.ext-1.0.0",
          extId: "pub.ext",
          version: "1.0.0",
          publisherDisplayName: "pub",
          targetPlatform: undefined,
        },
      ],
      log,
    );
    expect((vscode as any).workspace.fs.writeFile).not.toHaveBeenCalled();
  });

  it("overwrites non-array extensions.json", async () => {
    (vscode as any).workspace.fs.readFile.mockResolvedValue(
      new TextEncoder().encode("{}"),
    );
    const dir = vscode.Uri.parse(
      "vscode-remote://host/home/u/.trae-server/extensions",
    );
    await __test.commitExtensionsJson(
      dir,
      [
        {
          folderName: "ext-1.0.0",
          extId: "pub.ext",
          version: "1.0.0",
          publisherDisplayName: "pub",
          targetPlatform: undefined,
        },
      ],
      log,
    );
    expect((vscode as any).workspace.fs.writeFile).toHaveBeenCalledTimes(1);
  });
});

describe("killRemoteServer", () => {
  const log = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  } as any;

  beforeEach(() => {
    mockSpawn.mockReset();
  });

  it("returns 0 when no PIDs found", async () => {
    const child = makeChild();
    mockSpawn.mockReturnValue(child);
    const p = __test.killRemoteServer(AUTHORITY, log);
    child.stdout.emit("data", Buffer.from(""));
    child.emit("exit", 0);
    expect(await p).toBe(0);
  });

  it("kills found PIDs", async () => {
    const children = [makeChild(), makeChild()];
    let i = 0;
    mockSpawn.mockImplementation(() => {
      const child = children[i++];
      // Emit exit on next tick so the promise is subscribed first.
      queueMicrotask(() => child.emit("exit", 0));
      return child;
    });
    const p = __test.killRemoteServer(AUTHORITY, log);
    children[0].stdout.emit("data", Buffer.from("111\n222\n"));
    expect(await p).toBe(2);
  });
});

describe("patchRemoteArgvJson", () => {
  const log = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  } as any;

  beforeEach(() => {
    mockGetPlatformAdapter.mockReset();
    mockSpawn.mockReset();
    __test.resetPatchScriptCache();
  });

  it("skips when adapter does not need argv patch", async () => {
    mockGetPlatformAdapter.mockResolvedValue({
      needsArgvPatch: () => false,
      getArgvDataFolderNames: () => [".trae"],
      getRemoteExtensionsDirCandidates: () => [".trae-server/extensions"],
    });
    expect(
      await __test.patchRemoteArgvJson("/home/u", AUTHORITY, log),
    ).toBeUndefined();
  });

  it("skips when bundled script is missing", async () => {
    mockGetPlatformAdapter.mockResolvedValue({
      needsArgvPatch: () => true,
      getArgvDataFolderNames: () => [".trae"],
      getRemoteExtensionsDirCandidates: () => [".trae-server/extensions"],
    });
    mockReadFileSync.mockImplementation(() => {
      throw new Error("ENOENT");
    });
    expect(
      await __test.patchRemoteArgvJson("/home/u", AUTHORITY, log),
    ).toBeUndefined();
  });
});

describe("readApexInstalledExtensions", () => {
  const log = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  } as any;

  beforeEach(() => {
    mockGetPlatformAdapter.mockReset();
  });

  it("returns empty when extensions.json is missing", async () => {
    mockGetPlatformAdapter.mockResolvedValue({
      getApexExtensionsDir: () => "/fake/exts",
    });
    mockReadFileSync.mockImplementation(() => {
      throw new Error("ENOENT");
    });
    expect(await __test.readApexInstalledExtensions(log)).toEqual([]);
  });

  it("parses and filters entries", async () => {
    mockGetPlatformAdapter.mockResolvedValue({
      getApexExtensionsDir: () => "/fake/exts",
    });
    const data = JSON.stringify([
      { identifier: { id: "vscode.builtin" }, version: "1.0.0" },
      { identifier: { id: "aergic.artizo-kiro" }, version: "1.0.0" },
      {
        identifier: { id: "pub.ext", uuid: "u1" },
        version: "2.0.0",
        relativeLocation: "pub.ext-2.0.0",
        metadata: { targetPlatform: "linux-x64", publisherDisplayName: "pub" },
      },
    ]);
    mockReadFileSync.mockReturnValue(data);
    const result = await __test.readApexInstalledExtensions(log);
    expect(result).toHaveLength(1);
    expect(result[0].extId).toBe("pub.ext");
    expect(result[0].version).toBe("2.0.0");
    expect(result[0].targetPlatform).toBe("linux-x64");
    expect(result[0].publisherDisplayName).toBe("pub");
  });

  it("returns empty for non-array json", async () => {
    mockGetPlatformAdapter.mockResolvedValue({
      getApexExtensionsDir: () => "/fake/exts",
    });
    mockReadFileSync.mockReturnValue("{}");
    expect(await __test.readApexInstalledExtensions(log)).toEqual([]);
  });
});

describe("loadRemotePatchScript", () => {
  beforeEach(() => {
    __test.resetPatchScriptCache();
    mockReadFileSync.mockReset();
  });

  it("returns undefined when no candidate exists", () => {
    mockReadFileSync.mockImplementation(() => {
      throw new Error("ENOENT");
    });
    expect(__test.loadRemotePatchScript()).toBeUndefined();
  });

  it("caches after first load attempt", () => {
    mockReadFileSync.mockImplementation(() => {
      throw new Error("ENOENT");
    });
    __test.loadRemotePatchScript();
    __test.loadRemotePatchScript();
    expect(mockReadFileSync).toHaveBeenCalledTimes(3); // 3 candidates, once
  });
});
