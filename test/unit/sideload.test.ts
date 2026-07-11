/*
 * Copyright (c) 2026 Aergic Labs, LLC
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
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
import type { RemoteExec, RemoteExecResult } from "../../src/remote/remoteExec";

/** Build a mock RemoteExec with vi.fn() for run and streamToStdin. */
function makeMockExec(): RemoteExec & { run: any; streamToStdin: any } {
  return {
    run: vi.fn(async (): Promise<RemoteExecResult> => ({
      stdout: "",
      stderr: "",
      code: 0,
    })),
    streamToStdin: vi.fn(async (): Promise<void> => {}),
  };
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
    expect(__test.shellSingleQuote("a'b")).toBe("'a'\\''b'");
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
  const log = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  } as any;

  beforeEach(() => {
    __test.resetRemotePlatformCache();
  });

  it("caches the result across calls", async () => {
    const exec = makeMockExec();
    exec.run.mockResolvedValue({ stdout: "Linux x86_64\n", stderr: "", code: 0 });
    const first = await __test.detectRemotePlatform(AUTHORITY, exec);
    const second = await __test.detectRemotePlatform(AUTHORITY, exec);
    expect(first).toBe(second);
    expect(exec.run).toHaveBeenCalledTimes(1);
  });

  it("throws when authority is undefined", async () => {
    const exec = makeMockExec();
    await expect(__test.detectRemotePlatform(undefined, exec)).rejects.toThrow(
      /No remote authority/,
    );
  });

  it("throws when uname fails", async () => {
    const exec = makeMockExec();
    exec.run.mockResolvedValue({ stdout: "", stderr: "err", code: 1 });
    await expect(__test.detectRemotePlatform(AUTHORITY, exec)).rejects.toThrow(
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

  it("captures stdout and resolves on exit 0", async () => {
    const exec = makeMockExec();
    exec.run.mockResolvedValue({ stdout: "hello\n", stderr: "", code: 0 });
    const result = await __test.runRemoteCmd("echo hi", log, 15_000, undefined, exec);
    expect(result.stdout).toBe("hello\n");
    expect(result.code).toBe(0);
  });

  it("writes stdinInput and passes it to exec.run", async () => {
    const exec = makeMockExec();
    exec.run.mockResolvedValue({ stdout: "", stderr: "", code: 0 });
    await __test.runRemoteCmd("cat", log, 15_000, "body", exec);
    expect(exec.run).toHaveBeenCalledWith("cat", {
      stdin: "body",
      timeout: 15_000,
    });
  });

  it("rejects on spawn error", async () => {
    const exec = makeMockExec();
    exec.run.mockRejectedValue(new Error("spawn ENOENT"));
    await expect(
      __test.runRemoteCmd("ls", log, 15_000, undefined, exec),
    ).rejects.toThrow(/spawn ENOENT/);
  });
});

describe("probeRemoteHome", () => {
  const log = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  } as any;

  it("returns trimmed HOME on exit 0", async () => {
    const exec = makeMockExec();
    exec.run.mockResolvedValue({ stdout: "/home/u\n", stderr: "", code: 0 });
    expect(await __test.probeRemoteHome(log, exec)).toBe("/home/u");
  });

  it("returns undefined on non-zero exit", async () => {
    const exec = makeMockExec();
    exec.run.mockResolvedValue({ stdout: "", stderr: "", code: 1 });
    expect(await __test.probeRemoteHome(log, exec)).toBeUndefined();
  });

  it("returns undefined on spawn error", async () => {
    const exec = makeMockExec();
    exec.run.mockRejectedValue(new Error("spawn failed"));
    expect(await __test.probeRemoteHome(log, exec)).toBeUndefined();
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
    ctx = {
      globalState: {
        get: vi.fn().mockReturnValue(undefined),
        update: vi.fn().mockResolvedValue(undefined),
      },
    };
  });

  it("infers home from wsPath segments", async () => {
    const exec = makeMockExec();
    expect(
      await __test.resolveRemoteHome(AUTHORITY, "/home/u/proj", ctx, log, exec),
    ).toBe("/home/u");
  });

  it("uses cached home from globalState", async () => {
    const exec = makeMockExec();
    ctx.globalState.get.mockReturnValue("/cached/home");
    expect(
      await __test.resolveRemoteHome(AUTHORITY, undefined, ctx, log, exec),
    ).toBe("/cached/home");
  });

  it("falls back to ssh probe", async () => {
    const exec = makeMockExec();
    exec.run.mockResolvedValue({ stdout: "/probed/home\n", stderr: "", code: 0 });
    expect(
      await __test.resolveRemoteHome(AUTHORITY, undefined, ctx, log, exec),
    ).toBe("/probed/home");
    expect(ctx.globalState.update).toHaveBeenCalledWith(
      "remoteHome:ssh-remote+myhost",
      "/probed/home",
    );
  });

  it("returns undefined when probe fails", async () => {
    const exec = makeMockExec();
    exec.run.mockResolvedValue({ stdout: "", stderr: "", code: 1 });
    expect(
      await __test.resolveRemoteHome(AUTHORITY, undefined, ctx, log, exec),
    ).toBeUndefined();
  });

  it("returns undefined for short wsPath", async () => {
    const exec = makeMockExec();
    exec.run.mockResolvedValue({ stdout: "", stderr: "", code: 1 });
    expect(
      await __test.resolveRemoteHome(AUTHORITY, "/only", ctx, log, exec),
    ).toBeUndefined();
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

  it("returns 0 when no PIDs found", async () => {
    const exec = makeMockExec();
    exec.run.mockResolvedValue({ stdout: "", stderr: "", code: 0 });
    expect(await __test.killRemoteServer(log, exec)).toBe(0);
  });

  it("kills found PIDs", async () => {
    const exec = makeMockExec();
    exec.run.mockResolvedValueOnce({ stdout: "111\n222\n", stderr: "", code: 0 });
    exec.run.mockResolvedValueOnce({ stdout: "", stderr: "", code: 0 });
    expect(await __test.killRemoteServer(log, exec)).toBe(2);
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
    __test.resetPatchScriptCache();
  });

  it("skips when adapter does not need argv patch", async () => {
    const exec = makeMockExec();
    mockGetPlatformAdapter.mockResolvedValue({
      needsArgvPatch: () => false,
      getArgvDataFolderNames: () => [".trae"],
      getRemoteExtensionsDirCandidates: () => [".trae-server/extensions"],
    });
    expect(
      await __test.patchRemoteArgvJson("/home/u", log, exec),
    ).toBeUndefined();
  });

  it("skips when bundled script is missing", async () => {
    const exec = makeMockExec();
    mockGetPlatformAdapter.mockResolvedValue({
      needsArgvPatch: () => true,
      getArgvDataFolderNames: () => [".trae"],
      getRemoteExtensionsDirCandidates: () => [".trae-server/extensions"],
    });
    mockReadFileSync.mockImplementation(() => {
      throw new Error("ENOENT");
    });
    expect(
      await __test.patchRemoteArgvJson("/home/u", log, exec),
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
