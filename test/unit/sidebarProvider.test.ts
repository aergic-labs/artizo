/*
 * Copyright (c) 2026 Aergic Labs, LLC
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, it, expect, vi } from "vitest";

// Mock getLogger so SidebarProvider doesn't crash
vi.mock("../../src/utils/logger", () => ({
  getLogger: () => ({
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
  }),
}));

// Mock constants
vi.mock("../../src/utils/constants", () => ({
  BRAND: "Artizo",
  BRAND_PREFIX: "[Artizo]",
  MANAGED_LABEL: "com.artizo.managed=true",
}));

// Mock vscode
vi.mock("vscode", () => ({
  window: {
    showErrorMessage: vi.fn(),
    showInformationMessage: vi.fn(),
    showTextDocument: vi.fn(),
    showWarningMessage: vi.fn(),
    createTerminal: vi
      .fn()
      .mockReturnValue({ show: vi.fn(), dispose: vi.fn() }),
    registerWebviewViewProvider: vi.fn().mockReturnValue({ dispose: vi.fn() }),
  },
  workspace: {
    workspaceFolders: [{ uri: { fsPath: "/test/workspace" } }],
    textDocuments: [],
    registerTextDocumentContentProvider: vi
      .fn()
      .mockReturnValue({ dispose: vi.fn() }),
    openTextDocument: vi.fn().mockResolvedValue({ getText: () => "{}" }),
    onDidChangeWorkspaceFolders: vi.fn().mockReturnValue({ dispose: vi.fn() }),
  },
  commands: { executeCommand: vi.fn() },
  env: { remoteName: undefined, appRoot: "/mock/app/root" },
  ExtensionKind: { UI: 1, Workspace: 2 },
  ViewColumn: { One: 1 },
  Uri: {
    parse: (s: string) => ({ toString: () => s }),
    joinPath: (...parts: string[]) => ({ toString: () => parts.join("/") }),
  },
  extensions: { all: [] },
  EventEmitter: vi.fn().mockImplementation(() => ({
    event: vi.fn(),
    fire: vi.fn(),
    dispose: vi.fn(),
  })),
}));

import { SidebarProvider } from "../../src/sidebar/provider";
import {
  extractToggles,
  computeRunArgsToggle,
  computeMountsToggle,
} from "../../src/sidebar/configToggles";

function createProvider() {
  return new SidebarProvider(
    { toString: () => "/mock/ext" } as any,
    {
      getConfigPath: vi
        .fn()
        .mockReturnValue("/test/.devcontainer/devcontainer.json"),
    },
    "docker",
  );
}

describe("SidebarProvider", () => {
  describe("extractToggles", () => {
    it("detects GPU from runArgs", () => {
      expect(extractToggles({ runArgs: ["--gpus", "all"] }).gpu).toBe(true);
    });

    it("detects no GPU when runArgs missing", () => {
      expect(extractToggles({}).gpu).toBe(false);
    });

    it("detects privileged mode", () => {
      expect(
        extractToggles({ runArgs: ["--privileged", "--other"] }).privileged,
      ).toBe(true);
    });

    it("detects mountHome via artizoManaged tag", () => {
      const features = extractToggles({
        mounts: [
          {
            source: "C:/Users/test",
            target: "/host-home",
            type: "bind",
            artizoManaged: "home",
          },
        ],
      });
      expect(features.mountHome).toBe(true);
    });

    it("returns false for mountHome when no tagged mount", () => {
      expect(
        extractToggles({ mounts: [{ source: "/other", target: "/tmp" }] })
          .mountHome,
      ).toBe(false);
    });

    it("detects sshAgent via artizoManaged tag", () => {
      const features = extractToggles({
        mounts: [
          {
            source: "SSH_AUTH_SOCK",
            target: "/tmp/ssh",
            artizoManaged: "sshAgent",
          },
        ],
      });
      expect(features.sshAgent).toBe(true);
    });

    it("detects waylandSocket via artizoManaged tag", () => {
      const features = extractToggles({
        mounts: [
          {
            source: "${localEnv:WAYLAND_DISPLAY}",
            target: "/tmp/.X11-unix",
            artizoManaged: "waylandSocket",
          },
        ],
      });
      expect(features.waylandSocket).toBe(true);
    });

    it("detects copyGitConfig defaults true when disableCopyGitConfig absent", () => {
      expect(extractToggles({}).copyGitConfig).toBe(true);
    });

    it("detects copyGitConfig false when disableCopyGitConfig is true", () => {
      expect(
        extractToggles({ disableCopyGitConfig: true }).copyGitConfig,
      ).toBe(false);
    });

    it("parses forwardPorts as numbers", () => {
      expect(
        extractToggles({ forwardPorts: [3000, 8080] }).forwardPorts,
      ).toEqual([
        { port: 3000, label: "" },
        { port: 8080, label: "" },
      ]);
    });

    it("parses forwardPorts as strings", () => {
      expect(
        extractToggles({ forwardPorts: ["3000", "8080"] }).forwardPorts,
      ).toEqual([
        { port: 3000, label: "" },
        { port: 8080, label: "" },
      ]);
    });

    it("handles empty or missing mounts", () => {
      const e1 = extractToggles({ mounts: [] });
      expect(e1.mountHome).toBe(false);
      expect(e1.sshAgent).toBe(false);
      expect(e1.waylandSocket).toBe(false);

      const e2 = extractToggles({});
      expect(e2.mountHome).toBe(false);
      expect(e2.sshAgent).toBe(false);
      expect(e2.waylandSocket).toBe(false);
    });

    it("reads extensions from customizations.vscode", () => {
      const features = extractToggles({
        customizations: { vscode: { extensions: ["ms-python.python"] } },
      });
      expect(features.extensions).toEqual(["ms-python.python"]);
    });

    it("reads remoteUser", () => {
      expect(extractToggles({ remoteUser: "node" }).remoteUser).toBe("node");
    });

    it("reads runArgs", () => {
      expect(
        extractToggles({ runArgs: ["--gpus", "all", "--privileged"] }).runArgs,
      ).toEqual(["--gpus", "all", "--privileged"]);
    });

    it("reads mounts preserving source/target", () => {
      const features = extractToggles({
        mounts: [{ source: "/host/path", target: "/container/path" }],
      });
      expect(features.mounts).toEqual([
        { source: "/host/path", target: "/container/path" },
      ]);
    });

    it("handles Mounts (capital M) as fallback", () => {
      const features = extractToggles({
        Mounts: [{ source: "/fallback", target: "/tmp" }],
      });
      expect(features.mounts).toEqual([
        { source: "/fallback", target: "/tmp" },
      ]);
    });
  });

  describe("hasConfig", () => {
    it("returns true when config path exists", () => {
      const p = createProvider();
      expect(p.hasConfig()).toBe(true);
    });

    it("returns false when config path is null", () => {
      const p = createProvider();
      (p as any).configManager.getConfigPath.mockReturnValue(null);
      expect(p.hasConfig()).toBe(false);
    });
  });

  describe("loadConfig", () => {
    it("returns early when remote", async () => {
      const p = createProvider();
      const vscode = await import("vscode");
      const spy = vi.spyOn(p, "postMessage");
      (vscode.env as any).remoteName = "artizo-container";
      await p.loadConfig();
      expect(spy).toHaveBeenCalledWith({
        type: "configMissing",
        remote: true,
      });
    });

    it("sends configMissing when no workspace", async () => {
      const p = createProvider();
      const vscode = await import("vscode");
      const spy = vi.spyOn(p, "postMessage");
      (vscode.env as any).remoteName = undefined;
      (vscode.workspace as any).workspaceFolders = undefined;
      await p.loadConfig();
      expect(spy).toHaveBeenCalledWith({
        type: "configMissing",
        noWorkspace: true,
      });
    });

    it("sends configMissing when no config file found", async () => {
      const p = createProvider();
      const vscode = await import("vscode");
      const spy = vi.spyOn(p, "postMessage");
      (vscode.env as any).remoteName = undefined;
      (vscode.workspace as any).workspaceFolders = [{ uri: { fsPath: "/ws" } }];
      (p as any).configManager.getConfigPath.mockReturnValue(null);
      await p.loadConfig();
      expect(spy).toHaveBeenCalledWith({ type: "configMissing" });
    });
  });

  describe("computeRunArgsToggle", () => {
    it("enables privileged mode without touching other args", () => {
      expect(
        computeRunArgsToggle(["--fuck-you"], ["runArgs", "--privileged"], true),
      ).toEqual(["--fuck-you", "--privileged"]);
    });

    it("disables privileged mode while keeping other args", () => {
      expect(
        computeRunArgsToggle(
          ["--privileged", "--fuck-you"],
          ["runArgs", "--privileged"],
          false,
        ),
      ).toEqual(["--fuck-you"]);
    });

    it("enables GPU (--gpus + all) without touching other args", () => {
      expect(
        computeRunArgsToggle(
          ["--fuck-you"],
          ["runArgs", "--gpus", "all"],
          true,
        ),
      ).toEqual(["--fuck-you", "--gpus", "all"]);
    });

    it("disables GPU while keeping other args", () => {
      expect(
        computeRunArgsToggle(
          ["--gpus", "all", "--fuck-you"],
          ["runArgs", "--gpus", "all"],
          false,
        ),
      ).toEqual(["--fuck-you"]);
    });

    it("idempotent: enabling already-enabled privileged changes nothing", () => {
      expect(
        computeRunArgsToggle(
          ["--privileged"],
          ["runArgs", "--privileged"],
          true,
        ),
      ).toEqual(["--privileged"]);
    });

    it("idempotent: disabling already-disabled privileged changes nothing", () => {
      expect(
        computeRunArgsToggle(
          ["--fuck-you"],
          ["runArgs", "--privileged"],
          false,
        ),
      ).toEqual(["--fuck-you"]);
    });

    it("handles empty runArgs", () => {
      expect(
        computeRunArgsToggle([], ["runArgs", "--privileged"], true),
      ).toEqual(["--privileged"]);
      expect(
        computeRunArgsToggle([], ["runArgs", "--privileged"], false),
      ).toEqual([]);
    });
  });

  describe("computeMountsToggle", () => {
    it("enables mountHome without touching other mounts", () => {
      const existing: any[] = [{ source: "/other", target: "/tmp" }];
      const result = computeMountsToggle(
        existing,
        ["mounts", "source=C:/Users/test", "target=/host-home"],
        true,
        "home",
      );
      expect(result).toHaveLength(2);
      expect((result[1] as any).artizoManaged).toBe("home");
    });

    it("disables mountHome while keeping other mounts", () => {
      const existing: any[] = [
        { source: "/other", target: "/tmp" },
        {
          source: "C:/Users/test",
          target: "/host-home",
          artizoManaged: "home",
        },
      ];
      const result = computeMountsToggle(
        existing,
        ["mounts", "source=x", "target=y"],
        false,
        "home",
      );
      expect(result).toHaveLength(1);
      expect(result[0].source).toBe("/other");
    });

    it("replaces existing tagged mount instead of duplicating", () => {
      const existing: any[] = [
        { source: "old/path", target: "/old-target", artizoManaged: "home" },
      ];
      const result = computeMountsToggle(
        existing,
        ["mounts", "source=C:/new", "target=/new-target"],
        true,
        "home",
      );
      expect(result).toHaveLength(1);
      expect(result[0].source).toBe("C:/new");
      expect(result[0].target).toBe("/new-target");
    });

    it("idempotent: disabling when no tagged mount changes nothing", () => {
      const existing: any[] = [{ source: "/other", target: "/tmp" }];
      const result = computeMountsToggle(
        existing,
        ["mounts", "source=x", "target=y"],
        false,
        "home",
      );
      expect(result).toEqual(existing);
    });

    it("handles empty mounts", () => {
      const result = computeMountsToggle(
        [],
        ["mounts", "source=C:/Users/test", "target=/host-home"],
        true,
        "home",
      );
      expect(result).toHaveLength(1);
      expect((result[0] as any).artizoManaged).toBe("home");
    });

    it("includes type when provided in patchPath", () => {
      const result = computeMountsToggle(
        [],
        ["mounts", "source=/host/path", "target=/container/path", "type=bind"],
        true,
        "home",
      );
      expect(result).toHaveLength(1);
      expect((result[0] as any).type).toBe("bind");
    });
  });
});