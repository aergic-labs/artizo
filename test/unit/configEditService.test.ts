/*
 * Copyright (c) 2026 Aergic Labs, LLC
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, it, expect, vi, beforeEach, beforeAll } from "vitest";

// Mock getLogger so ConfigEditService doesn't crash
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
vi.mock("vscode", () => {
  const fsApi = {
    readDirectory: vi.fn().mockRejectedValue(new Error("ENOENT")),
    readFile: vi.fn().mockResolvedValue(new TextEncoder().encode("{}")),
    writeFile: vi.fn().mockResolvedValue(undefined),
    copy: vi.fn().mockResolvedValue(undefined),
    stat: vi.fn().mockRejectedValue(new Error("ENOENT")),
    createDirectory: vi.fn().mockResolvedValue(undefined),
    delete: vi.fn().mockResolvedValue(undefined),
    rename: vi.fn().mockResolvedValue(undefined),
  };
  return {
    window: {
      showErrorMessage: vi.fn().mockResolvedValue(undefined),
      showInformationMessage: vi.fn().mockResolvedValue(undefined),
      showTextDocument: vi.fn(),
      showWarningMessage: vi.fn(),
      createTerminal: vi
        .fn()
        .mockReturnValue({ show: vi.fn(), dispose: vi.fn() }),
      registerWebviewViewProvider: vi
        .fn()
        .mockReturnValue({ dispose: vi.fn() }),
      activeTextEditor: undefined as any,
      visibleTextEditors: [] as any[],
    },
    workspace: {
      workspaceFolders: [{ uri: { fsPath: "/test/workspace" } }],
      textDocuments: [] as any[],
      openTextDocument: vi.fn().mockResolvedValue({ getText: () => "{}" }),
      registerTextDocumentContentProvider: vi
        .fn()
        .mockReturnValue({ dispose: vi.fn() }),
      onDidChangeWorkspaceFolders: vi
        .fn()
        .mockReturnValue({ dispose: vi.fn() }),
      applyEdit: vi.fn().mockResolvedValue(true),
      fs: fsApi,
      getConfiguration: vi.fn().mockReturnValue({
        get: vi.fn((_k: string, d: unknown) => d),
        update: vi.fn().mockResolvedValue(undefined),
      }),
    },
    commands: { executeCommand: vi.fn().mockResolvedValue(undefined) },
    env: { remoteName: undefined, appRoot: "/mock/app/root" },
    ExtensionKind: { UI: 1, Workspace: 2 },
    ViewColumn: { One: 1 },
    Uri: {
      parse: (s: string) => ({ toString: () => s, fsPath: s }),
      file: (p: string) => ({ fsPath: p, toString: () => p }),
      joinPath: (...parts: string[]) => ({
        toString: () => parts.join("/"),
        fsPath: parts.join("/"),
      }),
      from: (o: { scheme: string; path: string }) => ({
        scheme: o.scheme,
        path: o.path,
        fsPath: o.path,
        toString: () => `${o.scheme}://${o.path}`,
      }),
    },
    Range: class {
      constructor(
        public start: any,
        public end: any,
      ) {}
    },
    WorkspaceEdit: class {
      replace = vi.fn();
      insert = vi.fn();
      delete = vi.fn();
    },
    extensions: { all: [] as any[] },
    EventEmitter: vi.fn().mockImplementation(() => ({
      event: vi.fn(),
      fire: vi.fn(),
      dispose: vi.fn(),
    })),
  };
});

const { mockIsInDevContainer } = vi.hoisted(() => ({
  mockIsInDevContainer: vi.fn(() => false),
}));

vi.mock("../../src/host/state", () => ({
  isInDevContainerWindow: mockIsInDevContainer,
}));

const { mockRepair } = vi.hoisted(() => ({
  mockRepair: vi.fn((content: string) =>
    content.includes("{") ? content : "{}",
  ),
}));

vi.mock("../../src/sidebar/jsonRepair.js", () => ({
  repairDevcontainerJson: mockRepair,
}));

vi.mock("../../src/ai", async () => ({
  getAiAssist: vi.fn(),
}));

import { ConfigEditService } from "../../src/sidebar/configEditService";
import { isAiAvailable } from "../../src/sidebar/aiAvailability";
import { getAiAssist } from "../../src/ai";
import * as vscode from "vscode";

function createService() {
  const post = vi.fn();
  const refreshCommands = vi.fn();
  const configManager = {
    getConfigPath: vi
      .fn()
      .mockResolvedValue({ fsPath: "/test/.devcontainer/devcontainer.json" }),
  };
  const host = {
    kind: "local" as const,
    dockerPath: "docker",
    exec: vi.fn().mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" }),
    onReady: vi.fn(() => ({ dispose: vi.fn() })),
  } as any;
  const service = new ConfigEditService({
    configManager,
    host,
    post,
    refreshCommands,
  });
  return { service, post, refreshCommands, configManager };
}

// Stub the editor-doc boundary: getEditorDoc returns the given content,
// applyAndSave performs the real jsonc edit (so we assert real output), and
// reloadFromContent is a spy capturing the final patched JSON.
async function editable(service: ConfigEditService, content: string) {
  const { applyEdits } = await import("jsonc-parser");
  vi.spyOn(service as any, "getEditorDoc").mockResolvedValue({
    getText: () => content,
    uri: { fsPath: "/test/.devcontainer/devcontainer.json" },
  });
  vi.spyOn(service as any, "applyAndSave").mockImplementation((async (
    c: unknown,
    edits: unknown,
  ) => applyEdits(c as string, edits as any)) as any);
  return vi
    .spyOn(service as any, "reloadFromContent")
    .mockResolvedValue(undefined);
}

describe("isAiAvailable", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns true when AI is available", async () => {
    (getAiAssist as any).mockResolvedValue({
      isAvailable: () => Promise.resolve(true),
    });
    await expect(isAiAvailable()).resolves.toBe(true);
  });

  it("returns false when AI is not available", async () => {
    (getAiAssist as any).mockResolvedValue({
      isAvailable: () => Promise.resolve(false),
    });
    await expect(isAiAvailable()).resolves.toBe(false);
  });
});

describe("ConfigEditService loadConfig", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns early when managed", async () => {
    const { service, post } = createService();
    (getAiAssist as any).mockResolvedValue({
      isAvailable: () => Promise.resolve(false),
    });
    mockIsInDevContainer.mockReturnValue(true);
    await service.loadConfig();
    expect(post).toHaveBeenCalledWith({
      type: "configMissing",
      managed: true,
      aiAvailable: false,
    });
    mockIsInDevContainer.mockReturnValue(false);
  });

  it("sends configMissing when no workspace", async () => {
    const { service, post } = createService();
    (getAiAssist as any).mockResolvedValue({
      isAvailable: () => Promise.resolve(false),
    });
    mockIsInDevContainer.mockReturnValue(false);
    (vscode.workspace as any).workspaceFolders = undefined;
    await service.loadConfig();
    expect(post).toHaveBeenCalledWith({
      type: "configMissing",
      noWorkspace: true,
      aiAvailable: false,
    });
  });

  it("sends configMissing when no config file found", async () => {
    const { service, post, configManager } = createService();
    (getAiAssist as any).mockResolvedValue({
      isAvailable: () => Promise.resolve(false),
    });
    mockIsInDevContainer.mockReturnValue(false);
    (vscode.workspace as any).workspaceFolders = [{ uri: { fsPath: "/ws" } }];
    configManager.getConfigPath.mockResolvedValue(null);
    await service.loadConfig();
    expect(post).toHaveBeenCalledWith({
      type: "configMissing",
      aiAvailable: false,
    });
  });
});

describe("ConfigEditService config edits", () => {
  let service: ConfigEditService;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockIsInDevContainer.mockReturnValue(false);
    (vscode as any).workspace.workspaceFolders = [
      { uri: { fsPath: "/test/workspace" } },
    ];
    ({ service } = createService());
  });

  describe("toggleOption", () => {
    it("adds --privileged to runArgs when enabled", async () => {
      const reload = await editable(service, '{ "runArgs": [] }');
      await (service as any).toggleOption("privileged", true);
      expect(reload).toHaveBeenCalledTimes(1);
      expect(reload.mock.calls[0][0]).toContain("--privileged");
    });

    it("removes --privileged from runArgs when disabled", async () => {
      const reload = await editable(service, '{ "runArgs": ["--privileged"] }');
      await (service as any).toggleOption("privileged", false);
      expect(reload.mock.calls[0][0]).not.toContain("--privileged");
    });

    it("adds the --gpus runArgs when gpu enabled", async () => {
      const reload = await editable(service, '{ "runArgs": [] }');
      await (service as any).toggleOption("gpu", true);
      const patched = reload.mock.calls[0][0];
      expect(patched).toContain("--gpus");
      expect(patched).toContain("all");
    });

    it("adds a tagged mount for mountHome when enabled", async () => {
      const reload = await editable(service, '{ "mounts": [] }');
      await (service as any).toggleOption("mountHome", true);
      const patched = reload.mock.calls[0][0];
      expect(patched).toContain("/host-home");
      expect(patched).toContain("artizoManaged");
    });

    it("honors a custom mountHome target path", async () => {
      const reload = await editable(service, '{ "mounts": [] }');
      await (service as any).toggleOption("mountHome", true, "/custom-home");
      expect(reload.mock.calls[0][0]).toContain("/custom-home");
    });

    it("sets disableCopyGitConfig=true when copyGitConfig disabled", async () => {
      const reload = await editable(service, "{}");
      await (service as any).toggleOption("copyGitConfig", false);
      expect(reload.mock.calls[0][0]).toContain("disableCopyGitConfig");
    });

    it("clears disableCopyGitConfig when copyGitConfig enabled", async () => {
      const reload = await editable(
        service,
        '{ "disableCopyGitConfig": true }',
      );
      await (service as any).toggleOption("copyGitConfig", true);
      expect(reload.mock.calls[0][0]).not.toContain("disableCopyGitConfig");
    });

    it("ignores an unknown feature", async () => {
      const reload = await editable(service, "{}");
      await (service as any).toggleOption("bogus-feature", true);
      expect(reload).not.toHaveBeenCalled();
    });
  });

  describe("patchConfig-based edits", () => {
    it("addPort appends a bare port number", async () => {
      const reload = await editable(service, '{ "forwardPorts": [3000] }');
      await (service as any).addPort(8080, "");
      expect(reload.mock.calls[0][0]).toContain("8080");
    });

    it("addPort appends a labeled port object", async () => {
      const reload = await editable(service, "{}");
      await (service as any).addPort(3000, "web");
      const patched = reload.mock.calls[0][0];
      expect(patched).toContain("web");
      expect(patched).toContain("3000");
    });

    it("removePort drops the port at the given index", async () => {
      const reload = await editable(
        service,
        '{ "forwardPorts": [3000, 8080] }',
      );
      await (service as any).removePort(0);
      const patched = reload.mock.calls[0][0];
      expect(patched).not.toContain("3000");
      expect(patched).toContain("8080");
    });

    it("addExtension appends to customizations.vscode.extensions", async () => {
      const reload = await editable(service, "{}");
      await (service as any).addExtension("ms-python.python");
      expect(reload.mock.calls[0][0]).toContain("ms-python.python");
    });

    it("addExtension is a no-op when already present", async () => {
      const reload = await editable(
        service,
        '{ "customizations": { "vscode": { "extensions": ["ms-python.python"] } } }',
      );
      await (service as any).addExtension("ms-python.python");
      expect(reload).not.toHaveBeenCalled();
    });

    it("addRunArg appends when absent and skips when present", async () => {
      const reload = await editable(service, '{ "runArgs": ["--init"] }');
      await (service as any).addRunArg("--privileged");
      expect(reload.mock.calls[0][0]).toContain("--privileged");

      reload.mockClear();
      await (service as any).addRunArg("--init");
      expect(reload).not.toHaveBeenCalled();
    });

    it("addMount appends a source/target pair", async () => {
      const reload = await editable(service, '{ "mounts": [] }');
      await (service as any).addMount("/host", "/container");
      const patched = reload.mock.calls[0][0];
      expect(patched).toContain("/host");
      expect(patched).toContain("/container");
    });

    it("setRemoteUser writes the remoteUser field", async () => {
      const reload = await editable(service, "{}");
      await (service as any).setRemoteUser("node");
      expect(reload.mock.calls[0][0]).toContain("node");
    });
  });
});

describe("ConfigEditService helpers", () => {
  let service: ConfigEditService;

  beforeEach(() => {
    vi.clearAllMocks();
    ({ service } = createService());
  });

  it("getLineColumn returns 1-based coordinates", () => {
    const text = "line1\nline2\nline3";
    const result = (service as any).getLineColumn(text, 7);
    expect(result).toEqual({ line: 2, column: 2 });
  });

  it("getLineColumn at offset 0 returns line 1 column 1", () => {
    const result = (service as any).getLineColumn("abc", 0);
    expect(result).toEqual({ line: 1, column: 1 });
  });

  it("friendlyError delegates to printParseErrorCode", () => {
    const result = (service as any).friendlyError(1);
    expect(typeof result).toBe("string");
    expect(result.length).toBeGreaterThan(0);
  });
});

describe("ConfigEditService getConfigPath & openConfigFileInEditor", () => {
  let service: ConfigEditService;
  let configManager: { getConfigPath: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    vi.clearAllMocks();
    mockIsInDevContainer.mockReturnValue(false);
    ({ service, configManager } = createService() as any);
    (vscode as any).workspace.workspaceFolders = [
      { uri: { fsPath: "/test/workspace" } },
    ];
  });

  it("getConfigPath returns undefined when no workspace", async () => {
    (vscode.workspace as any).workspaceFolders = undefined;
    await expect(service.getConfigPath()).resolves.toBeUndefined();
  });

  it("getConfigPath returns the configManager result", async () => {
    configManager.getConfigPath.mockResolvedValue({
      fsPath: "/test/.devcontainer/devcontainer.json",
    });
    await expect(service.getConfigPath()).resolves.toEqual({
      fsPath: "/test/.devcontainer/devcontainer.json",
    });
  });

  it("getConfigPath returns undefined when configManager returns null", async () => {
    configManager.getConfigPath.mockResolvedValue(null);
    await expect(service.getConfigPath()).resolves.toBeUndefined();
  });

  it("openConfigFileInEditor no-ops when no config", async () => {
    configManager.getConfigPath.mockResolvedValue(null);
    await service.openConfigFileInEditor();
    expect(vscode.workspace.openTextDocument).not.toHaveBeenCalled();
  });

  it("openConfigFileInEditor no-ops when already active", async () => {
    configManager.getConfigPath.mockResolvedValue({
      fsPath: "/test/.devcontainer/devcontainer.json",
    });
    (vscode.window as any).activeTextEditor = {
      document: {
        uri: { fsPath: "/test/.devcontainer/devcontainer.json" },
      },
    };
    await service.openConfigFileInEditor();
    expect(vscode.workspace.openTextDocument).not.toHaveBeenCalled();
    (vscode.window as any).activeTextEditor = undefined;
  });

  it("openConfigFileInEditor opens the document when not active", async () => {
    configManager.getConfigPath.mockResolvedValue({
      fsPath: "/test/.devcontainer/devcontainer.json",
    });
    (vscode.window as any).activeTextEditor = undefined;
    const doc = { uri: { fsPath: "/test/.devcontainer/devcontainer.json" } };
    (vscode.workspace.openTextDocument as any).mockResolvedValue(doc);
    await service.openConfigFileInEditor();
    expect(vscode.workspace.openTextDocument).toHaveBeenCalled();
    expect(vscode.window.showTextDocument).toHaveBeenCalledWith(doc, {
      viewColumn: 1,
      preview: false,
      preserveFocus: true,
    });
  });

  it("openConfigFileInEditor swallows open errors", async () => {
    configManager.getConfigPath.mockResolvedValue({
      fsPath: "/test/.devcontainer/devcontainer.json",
    });
    (vscode.window as any).activeTextEditor = undefined;
    (vscode.workspace.openTextDocument as any).mockRejectedValue(
      new Error("locked"),
    );
    await expect(service.openConfigFileInEditor()).resolves.toBeUndefined();
  });
});

describe("ConfigEditService toggleSoftware", () => {
  let service: ConfigEditService;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockIsInDevContainer.mockReturnValue(false);
    (vscode as any).workspace.workspaceFolders = [
      { uri: { fsPath: "/test/workspace" } },
    ];
    ({ service } = createService());
  });

  it("no-ops when getEditorDoc returns undefined", async () => {
    vi.spyOn(service as any, "getEditorDoc").mockResolvedValue(undefined);
    await service.toggleSoftware("python", true);
    // Should not throw and should not post
  });

  it("adds a feature when enabled", async () => {
    const reload = await editable(service, '{ "features": {} }');
    await service.toggleSoftware("python", true);
    expect(reload.mock.calls[0][0]).toContain("python");
  });

  it("removes a feature when disabled", async () => {
    const reload = await editable(service, '{ "features": { "python": {} } }');
    await service.toggleSoftware("python", false);
    expect(reload.mock.calls[0][0]).not.toContain("python");
  });

  it("adds features key when missing and enabled", async () => {
    const reload = await editable(service, "{}");
    await service.toggleSoftware("node", true);
    expect(reload.mock.calls[0][0]).toContain("node");
  });
});

describe("ConfigEditService extension remove/toggle", () => {
  let service: ConfigEditService;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockIsInDevContainer.mockReturnValue(false);
    (vscode as any).workspace.workspaceFolders = [
      { uri: { fsPath: "/test/workspace" } },
    ];
    ({ service } = createService());
  });

  it("removeExtension drops the extension at index", async () => {
    const reload = await editable(
      service,
      '{ "customizations": { "vscode": { "extensions": ["a", "b"] } } }',
    );
    await service.removeExtension(0);
    const patched = reload.mock.calls[0][0];
    expect(patched).not.toContain('"a"');
    expect(patched).toContain('"b"');
  });

  it("toggleExtension(true) delegates to addExtension", async () => {
    const reload = await editable(service, "{}");
    await service.toggleExtension("ms-python.python", true);
    expect(reload.mock.calls[0][0]).toContain("ms-python.python");
  });

  it("toggleExtension(false) removes when present", async () => {
    const reload = await editable(
      service,
      '{ "customizations": { "vscode": { "extensions": ["a", "b"] } } }',
    );
    await service.toggleExtension("a", false);
    expect(reload.mock.calls[0][0]).not.toContain('"a"');
  });

  it("toggleExtension(false) is a no-op when absent", async () => {
    const reload = await editable(service, "{}");
    await service.toggleExtension("missing", false);
    expect(reload).not.toHaveBeenCalled();
  });
});

describe("ConfigEditService mount/runArg remove + addMount dedup", () => {
  let service: ConfigEditService;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockIsInDevContainer.mockReturnValue(false);
    (vscode as any).workspace.workspaceFolders = [
      { uri: { fsPath: "/test/workspace" } },
    ];
    ({ service } = createService());
  });

  it("removeMount drops the mount at index", async () => {
    const reload = await editable(
      service,
      '{ "mounts": [{ "source": "/a", "target": "/b" }, { "source": "/c", "target": "/d" }] }',
    );
    await service.removeMount(0);
    const patched = reload.mock.calls[0][0];
    expect(patched).not.toContain('"/a"');
    expect(patched).toContain('"/c"');
  });

  it("removeRunArg drops the arg at index", async () => {
    const reload = await editable(
      service,
      '{ "runArgs": ["--init", "--privileged"] }',
    );
    await service.removeRunArg(0);
    const patched = reload.mock.calls[0][0];
    expect(patched).not.toContain('"--init"');
    expect(patched).toContain('"--privileged"');
  });

  it("addMount skips when the pair already exists", async () => {
    const reload = await editable(
      service,
      '{ "mounts": [{ "source": "/a", "target": "/b" }] }',
    );
    await service.addMount("/a", "/b");
    expect(reload).not.toHaveBeenCalled();
  });

  it("setRemoteUser with empty string writes undefined (clears field)", async () => {
    const reload = await editable(service, '{ "remoteUser": "old" }');
    await service.setRemoteUser("");
    expect(reload).toHaveBeenCalled();
  });
});

describe("ConfigEditService loadConfig success path", () => {
  let service: ConfigEditService;
  let post: ReturnType<typeof vi.fn>;
  let refreshCommands: ReturnType<typeof vi.fn>;
  let configManager: { getConfigPath: ReturnType<typeof vi.fn> };

  beforeEach(async () => {
    vi.clearAllMocks();
    mockIsInDevContainer.mockReturnValue(false);
    (vscode as any).workspace.workspaceFolders = [
      { uri: { fsPath: "/test/workspace" } },
    ];
    (vscode as any).workspace.textDocuments = [];
    (vscode as any).window.visibleTextEditors = [];
    ({ service, post, refreshCommands, configManager } =
      createService() as any);
    configManager.getConfigPath.mockResolvedValue({
      fsPath: "/test/.devcontainer/devcontainer.json",
    });
  });

  it("loads, opens editor, posts configLoaded and refreshes commands", async () => {
    const doc = {
      getText: () => JSON.stringify({ runArgs: ["--init"], mounts: [] }),
      uri: { fsPath: "/test/.devcontainer/devcontainer.json" },
      isClosed: false,
    };
    (vscode.workspace.openTextDocument as any).mockResolvedValue(doc);
    await service.loadConfig();
    const calls = post.mock.calls.map((c) => c[0]);
    expect(calls.some((m) => m.type === "configLoaded")).toBe(true);
    expect(refreshCommands).toHaveBeenCalled();
  });

  it("does not re-open editor when already visible", async () => {
    const doc = {
      getText: () => "{}",
      uri: { fsPath: "/test/.devcontainer/devcontainer.json" },
      isClosed: false,
    };
    (vscode.workspace as any).textDocuments = [doc];
    (vscode.window as any).visibleTextEditors = [{ document: doc }];
    await service.loadConfig();
    expect(vscode.window.showTextDocument).not.toHaveBeenCalled();
  });

  it("returns early when content is unparseable", async () => {
    // parse() returns undefined for input it can't handle; use a string that
    // produces undefined. jsonc-parser parse('') returns undefined.
    const doc = {
      getText: () => "",
      uri: { fsPath: "/test/.devcontainer/devcontainer.json" },
      isClosed: false,
    };
    (vscode.workspace.openTextDocument as any).mockResolvedValue(doc);
    await service.loadConfig();
    expect(post).not.toHaveBeenCalled();
  });

  it("sends parse errors when checkErrors=true and content has errors", async () => {
    // Malformed JSONC triggers jsonc-parser parse errors.
    const doc = {
      getText: () => '{ "runArgs": [broken }',
      uri: { fsPath: "/test/.devcontainer/devcontainer.json" },
      isClosed: false,
    };
    (vscode.workspace.openTextDocument as any).mockResolvedValue(doc);
    await service.loadConfig(true);
    const loaded = post.mock.calls
      .map((c) => c[0])
      .find((m) => m.type === "configLoaded");
    expect(loaded).toBeDefined();
    expect(loaded.errors).toBeDefined();
    expect(loaded.errors.length).toBeGreaterThan(0);
    expect(loaded.errors[0]).toHaveProperty("line");
    expect(loaded.errors[0]).toHaveProperty("column");
  });

  it("checkErrors=true with clean JSON produces no errors", async () => {
    const doc = {
      getText: () => JSON.stringify({ runArgs: [] }),
      uri: { fsPath: "/test/.devcontainer/devcontainer.json" },
      isClosed: false,
    };
    (vscode.workspace.openTextDocument as any).mockResolvedValue(doc);
    await service.loadConfig(true);
    const loaded = post.mock.calls
      .map((c) => c[0])
      .find((m) => m.type === "configLoaded");
    expect(loaded.errors).toEqual([]);
  });

  it("returns undefined when getEditorDoc cannot open", async () => {
    (vscode.workspace.openTextDocument as any).mockRejectedValue(
      new Error("ENOENT"),
    );
    await service.loadConfig();
    expect(post).not.toHaveBeenCalled();
  });
});

describe("ConfigEditService sendInstalledExtensions", () => {
  let service: ConfigEditService;
  let post: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockIsInDevContainer.mockReturnValue(false);
    (vscode as any).workspace.workspaceFolders = [
      { uri: { fsPath: "/test/workspace" } },
    ];
    (vscode as any).extensions.all = [];
    ({ service, post } = createService());
  });

  it("posts setInstalledExtensions with sorted, filtered extensions", () => {
    (vscode as any).extensions.all = [
      {
        id: "vscode.builtin",
        extensionPath: "/mock/app/root/builtin",
        packageJSON: { displayName: "Builtin" },
      },
      {
        id: "ms-python.python",
        extensionPath: "/ext/python",
        packageJSON: { displayName: "Python" },
      },
      {
        id: "aergic.artizo-something",
        extensionPath: "/ext/artizo",
        packageJSON: { displayName: "Artizo" },
      },
      {
        id: "dbaeumer.vscode-eslint",
        extensionPath: "/ext/eslint",
        packageJSON: { displayName: "ESLint" },
      },
    ];
    (service as any).sendInstalledExtensions({
      customizations: {
        vscode: { extensions: ["ms-python.python"] },
      },
    });
    const msg = post.mock.calls.find(
      (c) => c[0].type === "setInstalledExtensions",
    )![0];
    const ids = msg.extensions.map((e: any) => e.id);
    expect(ids).toEqual(["dbaeumer.vscode-eslint", "ms-python.python"]);
    const py = msg.extensions.find((e: any) => e.id === "ms-python.python");
    expect(py.enabled).toBe(true);
    const eslint = msg.extensions.find(
      (e: any) => e.id === "dbaeumer.vscode-eslint",
    );
    expect(eslint.enabled).toBe(false);
  });

  it("falls back to id when displayName missing", () => {
    (vscode as any).extensions.all = [
      {
        id: "some.ext",
        extensionPath: "/ext/some",
        packageJSON: {},
      },
    ];
    (service as any).sendInstalledExtensions({});
    const msg = post.mock.calls.find(
      (c) => c[0].type === "setInstalledExtensions",
    )![0];
    expect(msg.extensions[0].label).toBe("some.ext");
  });
});

describe("ConfigEditService repairConfig", () => {
  let service: ConfigEditService;
  let configManager: { getConfigPath: ReturnType<typeof vi.fn> };

  beforeEach(async () => {
    vi.clearAllMocks();
    mockIsInDevContainer.mockReturnValue(false);
    (vscode as any).workspace.workspaceFolders = [
      { uri: { fsPath: "/test/workspace" } },
    ];
    (vscode as any).workspace.textDocuments = [];
    ({ service, configManager } = createService() as any);
    configManager.getConfigPath.mockResolvedValue({
      fsPath: "/test/.devcontainer/devcontainer.json",
    });
    (vscode as any).workspace.fs.stat.mockRejectedValue(new Error("ENOENT"));
    (vscode as any).workspace.fs.readFile.mockResolvedValue(
      new TextEncoder().encode('{ "name": "test" }'),
    );
    (vscode as any).workspace.fs.writeFile.mockResolvedValue(undefined);
  });

  it("returns early when no workspace", async () => {
    (vscode as any).workspace.workspaceFolders = undefined;
    await expect(service.repairConfig()).resolves.toBeUndefined();
  });

  it("returns early when no config path", async () => {
    configManager.getConfigPath.mockResolvedValue(null);
    await expect(service.repairConfig()).resolves.toBeUndefined();
  });

  it("writes backup and repaired content via fs when no editor doc", async () => {
    (vscode as any).workspace.openTextDocument.mockRejectedValue(
      new Error("ENOENT"),
    );
    await service.repairConfig();
    // writeFile called at least twice: backup + repaired content
    expect(
      (vscode as any).workspace.fs.writeFile.mock.calls.length,
    ).toBeGreaterThanOrEqual(2);
    expect(vscode.window.showInformationMessage).toHaveBeenCalled();
  });

  it("applies repair via editor when doc available", async () => {
    const doc = {
      getText: () => '{ "name": "test" }',
      uri: { fsPath: "/test/.devcontainer/devcontainer.json" },
      isClosed: false,
      positionAt: (n: number) => ({ line: 0, character: n }),
      save: vi.fn().mockResolvedValue(true),
    };
    (vscode as any).workspace.textDocuments = [doc];
    (vscode as any).workspace.applyEdit = vi.fn().mockResolvedValue(true);
    await service.repairConfig();
    expect(doc.save).toHaveBeenCalled();
  });

  it("shows error message when repair throws", async () => {
    (vscode as any).workspace.openTextDocument.mockRejectedValue(
      new Error("ENOENT"),
    );
    (vscode as any).workspace.fs.readFile.mockResolvedValue(
      new TextEncoder().encode('{ "name": "test" }'),
    );
    mockRepair.mockImplementationOnce(() => {
      throw new Error("cannot repair");
    });
    await service.repairConfig();
    expect(vscode.window.showErrorMessage).toHaveBeenCalled();
  });
});

describe("ConfigEditService patchConfig no-doc fallback", () => {
  let service: ConfigEditService;

  beforeEach(() => {
    vi.clearAllMocks();
    mockIsInDevContainer.mockReturnValue(false);
    (vscode as any).workspace.workspaceFolders = [
      { uri: { fsPath: "/test/workspace" } },
    ];
    ({ service } = createService());
  });

  it("patchConfig is a no-op when getEditorDoc returns undefined", async () => {
    vi.spyOn(service as any, "getEditorDoc").mockResolvedValue(undefined);
    await (service as any).patchConfig(["remoteUser"], "node");
    // no throw, no post
  });

  it("getConfigValue returns undefined when no doc", async () => {
    vi.spyOn(service as any, "getEditorDoc").mockResolvedValue(undefined);
    await expect(
      (service as any).getConfigValue(["runArgs"]),
    ).resolves.toBeUndefined();
  });
});

describe("ConfigEditService applyAndSave fallback", () => {
  let service: ConfigEditService;
  let configManager: { getConfigPath: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    vi.clearAllMocks();
    mockIsInDevContainer.mockReturnValue(false);
    (vscode as any).workspace.workspaceFolders = [
      { uri: { fsPath: "/test/workspace" } },
    ];
    ({ service, configManager } = createService() as any);
    configManager.getConfigPath.mockResolvedValue({
      fsPath: "/test/.devcontainer/devcontainer.json",
    });
  });

  it("writes via fs when no editor doc available", async () => {
    const { modify } = await import("jsonc-parser");
    const content = "{}";
    const edits = modify(content, ["remoteUser"], "node", {
      formattingOptions: { eol: "\n", insertSpaces: true, tabSize: 2 },
    });
    vi.spyOn(service as any, "getEditorDoc").mockResolvedValue(undefined);
    const result = await (service as any).applyAndSave(content, edits);
    expect(result).toContain("node");
    expect((vscode as any).workspace.fs.writeFile).toHaveBeenCalled();
  });
});
