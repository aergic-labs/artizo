/*
 * Copyright (c) 2026 Aergic Labs, LLC
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// Hoisted mock for the 'vscode' module. host.ts has a top-level
// `import * as vscode from "vscode"`, which vitest cannot resolve because
// vscode is not installed in node_modules (it's provided by the extension
// host at runtime). This factory returns the same shape as
// test/__mocks__/vscode.ts.
vi.mock("vscode", () => ({
  window: {
    createOutputChannel: vi.fn(() => ({
      trace: vi.fn(),
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      append: vi.fn(),
      appendLine: vi.fn(),
      replace: vi.fn(),
      clear: vi.fn(),
      show: vi.fn(),
      hide: vi.fn(),
      dispose: vi.fn(),
    })),
    createTerminal: vi.fn(),
    createStatusBarItem: vi.fn(),
    showErrorMessage: vi.fn(),
    showInformationMessage: vi.fn(),
    showOpenDialog: vi.fn(),
    showQuickPick: vi.fn(),
    showInputBox: vi.fn(),
    withProgress: vi.fn(),
    onDidChangeActiveTerminal: vi.fn(),
  },
  commands: {
    registerCommand: vi.fn(),
    executeCommand: vi.fn(),
  },
  workspace: {
    getConfiguration: vi.fn().mockReturnValue({
      get: vi.fn((_key: string, defaultValue: unknown) => defaultValue),
      update: vi.fn().mockResolvedValue(undefined),
    }),
    workspaceFolders: [],
    registerRemoteAuthorityResolver: vi.fn(),
    registerFileSystemProvider: vi.fn(),
  },
  env: {
    remoteName: undefined,
    remoteAuthority: undefined as string | undefined,
    appRoot: "/mock/app/root",
  },
  StatusBarAlignment: { Left: 1, Right: 2 },
  ProgressLocation: { Notification: 15 },
  ExtensionKind: { UI: 1, Workspace: 2 },
  ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
  Uri: {
    file: (p: string) => ({
      fsPath: p,
      scheme: "file",
      authority: "",
      path: p,
    }),
    parse: (p: string) => ({
      fsPath: p,
      scheme: "file",
      authority: "",
      path: p,
    }),
  },
  EventEmitter: class {
    event = vi.fn();
    fire() {}
  },
  Disposable: {
    from() {
      return { dispose: vi.fn() };
    },
  },
}));

// Mock isInDevContainer before importing Host so the factory uses our stub.
vi.mock("../../src/host/state", () => ({
  isInDevContainer: vi.fn(() => false),
}));

// Mock execFilePromise so exec() doesn't spawn a real process.
vi.mock("../../src/utils/dockerUtils", () => ({
  execFilePromise: vi.fn(),
}));

import { Host } from "../../src/host/host";
import { isInDevContainer } from "../../src/host/state";
import { execFilePromise } from "../../src/utils/dockerUtils";
import * as vscode from "vscode";

const mockedExec = vi.mocked(execFilePromise);
const mockedIsInDevContainer = vi.mocked(isInDevContainer);

describe("Host", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedIsInDevContainer.mockReturnValue(false);
    // Reset workspace folders to empty by default.
    (vscode.workspace as any).workspaceFolders = [];
  });

  describe("create (local)", () => {
    it("creates a local host when not in a devcontainer", () => {
      const host = Host.create({ dockerPath: "docker" });
      expect(host.kind).toBe("local");
      expect(host.isManaged).toBe(false);
      expect(host.workspace).toBeUndefined();
    });

    it("sets workspace from the first workspace folder fsPath", () => {
      (vscode.workspace as any).workspaceFolders = [
        { uri: { fsPath: "/home/user/project", scheme: "file" } },
      ];
      const host = Host.create({ dockerPath: "docker" });
      expect(host.workspace).toBe("/home/user/project");
    });
  });

  describe("create (managed)", () => {
    it("creates a managed host when inside a devcontainer with a folder", () => {
      mockedIsInDevContainer.mockReturnValue(true);
      // Authority encoded as artizo-container+<hex-of-id>
      const id = "/home/user/project";
      const hex = Buffer.from(id, "utf-8").toString("hex");
      (vscode.workspace as any).workspaceFolders = [
        {
          uri: {
            fsPath: "/workspace",
            scheme: "vscode-remote",
            authority: `artizo-container+${hex}`,
          },
        },
      ];

      const host = Host.create({ dockerPath: "docker" });
      expect(host.kind).toBe("managed");
      expect(host.isManaged).toBe(true);
      expect(host.workspace).toBe(id);
    });

    it("leaves workspace undefined when managed with no folder", () => {
      mockedIsInDevContainer.mockReturnValue(true);
      (vscode.workspace as any).workspaceFolders = [];

      const host = Host.create({ dockerPath: "docker" });
      expect(host.kind).toBe("managed");
      expect(host.workspace).toBeUndefined();
    });
  });

  describe("exec", () => {
    it("calls execFilePromise for local hosts", async () => {
      mockedExec.mockResolvedValue({
        exitCode: 0,
        stdout: "ok",
        stderr: "",
      });
      const host = Host.create({ dockerPath: "docker" });

      const result = await host.exec({ cmd: "echo", args: ["hi"] });
      expect(mockedExec).toHaveBeenCalledWith("echo", ["hi"], { cwd: undefined });
      expect(result).toEqual({ exitCode: 0, stdout: "ok", stderr: "" });
    });

    it("defaults args to empty array", async () => {
      mockedExec.mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" });
      const host = Host.create({ dockerPath: "docker" });

      await host.exec({ cmd: "docker" });
      expect(mockedExec).toHaveBeenCalledWith("docker", [], { cwd: undefined });
    });

    it("throws when running on a managed host", async () => {
      mockedIsInDevContainer.mockReturnValue(true);
      (vscode.workspace as any).workspaceFolders = [];
      const host = Host.create({ dockerPath: "docker" });

      await expect(host.exec({ cmd: "docker" })).rejects.toThrow(
        "Docker execution from managed container not supported.",
      );
      expect(mockedExec).not.toHaveBeenCalled();
    });
  });

  describe("dockerExec", () => {
    it("builds docker exec args with containerId and command", async () => {
      mockedExec.mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" });
      const host = Host.create({ dockerPath: "docker" });

      await host.dockerExec("abc123", ["ls", "/"]);
      expect(mockedExec).toHaveBeenCalledWith(
        "docker",
        ["exec", "abc123", "ls", "/"],
        { cwd: undefined },
      );
    });

    it("adds -u and -w options when provided", async () => {
      mockedExec.mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" });
      const host = Host.create({ dockerPath: "docker" });

      await host.dockerExec("cid", ["sh"], {
        user: "root",
        workdir: "/srv",
      });
      expect(mockedExec).toHaveBeenCalledWith(
        "docker",
        ["exec", "-u", "root", "-w", "/srv", "cid", "sh"],
        { cwd: undefined },
      );
    });
  });

});
