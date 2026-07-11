/* Copyright (c) 2026 Aergic Labs, LLC */
import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => {
  const vscode = {
    window: {
      showErrorMessage: vi.fn(),
      showInformationMessage: vi.fn(),
      showTextDocument: vi.fn().mockResolvedValue(undefined),
      showWarningMessage: vi.fn(),
      visibleTextEditors: [] as any[],
      createTerminal: vi
        .fn()
        .mockReturnValue({ show: vi.fn(), dispose: vi.fn() }),
      registerWebviewViewProvider: vi
        .fn()
        .mockReturnValue({ dispose: vi.fn() }),
    },
    workspace: {
      workspaceFolders: [{ uri: { fsPath: "/test/workspace" } }],
      textDocuments: [],
      registerTextDocumentContentProvider: vi
        .fn()
        .mockReturnValue({ dispose: vi.fn() }),
      openTextDocument: vi.fn().mockResolvedValue({ getText: () => "{}" }),
      onDidChangeWorkspaceFolders: vi
        .fn()
        .mockReturnValue({ dispose: vi.fn() }),
      onDidSaveTextDocument: vi.fn().mockReturnValue({ dispose: vi.fn() }),
      fs: {
        createDirectory: vi.fn().mockResolvedValue(undefined),
        writeFile: vi.fn().mockResolvedValue(undefined),
        readFile: vi.fn().mockResolvedValue(Buffer.from("{}", "utf-8")),
        stat: vi.fn().mockResolvedValue({ type: 1 }),
      },
    },
    commands: { executeCommand: vi.fn() },
    env: { remoteName: undefined, appRoot: "/mock/app/root" },
    ExtensionKind: { UI: 1, Workspace: 2 },
    ViewColumn: { One: 1 },
    Uri: {
      parse: (s: string) => ({ toString: () => s, fsPath: s }),
      file: (p: string) => ({
        toString: () => `file://${p}`,
        fsPath: p,
        scheme: "file",
        authority: "",
        path: p,
      }),
      joinPath: (base: any, ...segments: string[]) => {
        const basePath = base?.path ?? base?.fsPath ?? "";
        const joined =
          basePath.replace(/\/+$/, "") +
          "/" +
          segments.map((s) => s.replace(/^\/+/, "")).join("/");
        const fsPath = base?.fsPath
          ? `${base.fsPath.replace(/\/+$/, "")}/${segments
              .map((s) => s.replace(/^\/+/, ""))
              .join("/")}`
          : joined;
        return {
          toString: () => joined,
          fsPath,
          scheme: base?.scheme ?? "file",
          authority: base?.authority ?? "",
          path: joined,
        };
      },
    },
    extensions: { all: [] },
    EventEmitter: vi.fn().mockImplementation(() => ({
      event: vi.fn(),
      fire: vi.fn(),
      dispose: vi.fn(),
    })),
  };
  const fs = {
    readFileSync: vi.fn(() => "<html>${SCRIPT_URI} ${STYLE_URI}</html>"),
  };
  return { vscode, fs };
});

vi.mock("../../src/utils/logger", () => ({
  getLogger: () => ({
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
  }),
}));

vi.mock("../../src/utils/constants", () => ({
  BRAND: "Artizo",
  BRAND_PREFIX: "[Artizo]",
  MANAGED_LABEL: "com.artizo.managed=true",
}));

vi.mock("vscode", () => mocks.vscode);
vi.mock("node:fs", () => mocks.fs);

vi.mock("../../src/ai", async () => ({
  getAiAssist: vi.fn().mockResolvedValue({ isAvailable: () => false }),
}));

vi.mock("comment-json", () => ({
  parse: vi.fn(() => ({})),
  stringify: vi.fn((obj: unknown) => JSON.stringify(obj, null, 2)),
}));

import { SidebarProvider } from "../../src/sidebar/provider";
import {
  extractToggles,
  computeRunArgsToggle,
  computeMountsToggle,
} from "../../src/sidebar/configToggles";

function createProvider() {
  const mockHost = {
    kind: "local" as const,
    dockerPath: "docker",
    exec: vi.fn().mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" }),
    onReady: vi.fn(() => ({ dispose: vi.fn() })),
  } as any;
  return new SidebarProvider(
    { toString: () => "/mock/ext" } as any,
    {
      getConfigPath: vi
        .fn()
        .mockResolvedValue({ fsPath: "/test/.devcontainer/devcontainer.json" }),
    },
    mockHost,
  );
}

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

  it("copyGitConfig defaults true", () => {
    expect(extractToggles({}).copyGitConfig).toBe(true);
  });

  it("copyGitConfig false when disableCopyGitConfig is true", () => {
    expect(extractToggles({ disableCopyGitConfig: true }).copyGitConfig).toBe(
      false,
    );
  });

  it("parses forwardPorts as numbers", () => {
    expect(extractToggles({ forwardPorts: [3000, 8080] }).forwardPorts).toEqual(
      [
        { port: 3000, label: "" },
        { port: 8080, label: "" },
      ],
    );
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
    expect(features.mounts).toEqual([{ source: "/fallback", target: "/tmp" }]);
  });
});

describe("computeRunArgsToggle", () => {
  it("enables privileged mode without touching other args", () => {
    expect(
      computeRunArgsToggle(["--other"], ["runArgs", "--privileged"], true),
    ).toEqual(["--other", "--privileged"]);
  });

  it("disables privileged mode while keeping other args", () => {
    expect(
      computeRunArgsToggle(
        ["--privileged", "--other"],
        ["runArgs", "--privileged"],
        false,
      ),
    ).toEqual(["--other"]);
  });

  it("enables GPU (--gpus + all)", () => {
    expect(
      computeRunArgsToggle(["--other"], ["runArgs", "--gpus", "all"], true),
    ).toEqual(["--other", "--gpus", "all"]);
  });

  it("disables GPU while keeping other args", () => {
    expect(
      computeRunArgsToggle(
        ["--gpus", "all", "--other"],
        ["runArgs", "--gpus", "all"],
        false,
      ),
    ).toEqual(["--other"]);
  });

  it("idempotent: enabling already-enabled privileged", () => {
    expect(
      computeRunArgsToggle(["--privileged"], ["runArgs", "--privileged"], true),
    ).toEqual(["--privileged"]);
  });

  it("idempotent: disabling already-disabled privileged", () => {
    expect(
      computeRunArgsToggle(["--other"], ["runArgs", "--privileged"], false),
    ).toEqual(["--other"]);
  });

  it("handles empty runArgs", () => {
    expect(computeRunArgsToggle([], ["runArgs", "--privileged"], true)).toEqual(
      ["--privileged"],
    );
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
      { source: "C:/Users/test", target: "/host-home", artizoManaged: "home" },
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

  it("idempotent: disabling when no tagged mount", () => {
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

describe("SidebarProvider.hasConfig", () => {
  it("returns true when config path exists", async () => {
    const p = createProvider();
    await expect(p.hasConfig()).resolves.toBe(true);
  });

  it("returns false when config path is null", async () => {
    const p = createProvider();
    (p as any).configManager.getConfigPath.mockResolvedValue(null);
    await expect(p.hasConfig()).resolves.toBe(false);
  });
});

describe("SidebarProvider", () => {
  let provider: SidebarProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = createProvider();
  });

  function makeWebviewView(visible = true) {
    const postMessage = vi.fn();
    const onDidReceiveMessage = vi.fn();
    const onDidChangeVisibility = vi.fn().mockReturnValue({ dispose: vi.fn() });
    const asWebviewUri = vi.fn((u: any) => ({
      ...u,
      toString: () => `webview-uri:${u?.fsPath ?? u?.path ?? ""}`,
    }));
    const webview: any = {
      options: undefined,
      html: "",
      postMessage,
      onDidReceiveMessage,
      asWebviewUri,
    };
    const view: any = { webview, visible, onDidChangeVisibility };
    return {
      webview,
      view,
      postMessage,
      onDidReceiveMessage,
      onDidChangeVisibility,
    };
  }

  describe("resolveWebviewView", () => {
    it("sets webview options with localResourceRoots", () => {
      const { view } = makeWebviewView();
      provider.resolveWebviewView(view);
      expect(view.webview.options.enableScripts).toBe(true);
      expect(view.webview.options.localResourceRoots).toHaveLength(2);
    });

    it("sets html from getHtml", () => {
      const { view } = makeWebviewView();
      provider.resolveWebviewView(view);
      expect(view.webview.html).toContain("<html>");
    });

    it("registers onDidReceiveMessage listener", () => {
      const { view, onDidReceiveMessage } = makeWebviewView();
      provider.resolveWebviewView(view);
      expect(onDidReceiveMessage).toHaveBeenCalledTimes(1);
    });

    it("flushes pending messages then clears queue", async () => {
      const { view, postMessage } = makeWebviewView();
      // Queue a message before view is resolved
      provider.postMessage({ type: "expandSection", section: "config" });
      provider.resolveWebviewView(view);
      expect(postMessage).toHaveBeenCalledWith({
        type: "expandSection",
        section: "config",
      });
    });

    it("does not load data on resolve (waits for ready/visibility)", () => {
      const { view } = makeWebviewView(true);
      const spy = vi.spyOn((provider as any).configEdit, "loadConfig");
      provider.resolveWebviewView(view);
      expect(spy).not.toHaveBeenCalled();
    });

    it("registers onDidSaveTextDocument listener", () => {
      const { view } = makeWebviewView();
      provider.resolveWebviewView(view);
      const vscode = mocks.vscode;
      expect(vscode.workspace.onDidSaveTextDocument).toHaveBeenCalledTimes(1);
    });

    it("onDidSaveTextDocument reloads config when saved doc matches config path", async () => {
      const { view } = makeWebviewView();
      provider.resolveWebviewView(view);
      const callback =
        mocks.vscode.workspace.onDidSaveTextDocument.mock.calls[0][0];
      const spy = vi.spyOn((provider as any).configEdit, "loadConfig");
      const configPath = {
        fsPath: "/test/.devcontainer/devcontainer.json",
      };
      await callback({ uri: { fsPath: configPath.fsPath } });
      expect(spy).toHaveBeenCalledWith(true);
    });

    it("onDidSaveTextDocument does not reload when doc path differs", async () => {
      const { view } = makeWebviewView();
      provider.resolveWebviewView(view);
      const callback =
        mocks.vscode.workspace.onDidSaveTextDocument.mock.calls[0][0];
      const spy = vi.spyOn((provider as any).configEdit, "loadConfig");
      await callback({ uri: { fsPath: "/other/file.json" } });
      expect(spy).not.toHaveBeenCalled();
    });
  });

  describe("postMessage", () => {
    it("sends to view when view exists", () => {
      const { view, postMessage } = makeWebviewView();
      provider.resolveWebviewView(view);
      postMessage.mockClear();
      provider.postMessage({ type: "expandSection", section: "config" });
      expect(postMessage).toHaveBeenCalledTimes(1);
    });

    it("queues message when no view exists", () => {
      const fresh = createProvider();
      fresh.postMessage({ type: "expandSection", section: "config" });
      // Should not throw; message is queued internally
      expect((fresh as any)._pendingMessages).toHaveLength(1);
    });
  });

  describe("loadConfig", () => {
    it("delegates to configEdit.loadConfig", async () => {
      const spy = vi.spyOn((provider as any).configEdit, "loadConfig");
      await provider.loadConfig();
      expect(spy).toHaveBeenCalledWith(false);
    });

    it("passes checkErrors=true", async () => {
      const spy = vi.spyOn((provider as any).configEdit, "loadConfig");
      await provider.loadConfig(true);
      expect(spy).toHaveBeenCalledWith(true);
    });
  });

  describe("refreshCommands", () => {
    it("posts updateCommands message", async () => {
      const { view, postMessage } = makeWebviewView();
      provider.resolveWebviewView(view);
      postMessage.mockClear();
      await provider.refreshCommands();
      expect(postMessage).toHaveBeenCalledWith(
        expect.objectContaining({ type: "updateCommands" }),
      );
    });

    it("includes computed commands array", async () => {
      const { view, postMessage } = makeWebviewView();
      provider.resolveWebviewView(view);
      postMessage.mockClear();
      await provider.refreshCommands();
      const cmdCall = postMessage.mock.calls.find(
        (c) => c[0]?.type === "updateCommands",
      );
      expect(cmdCall).toBeTruthy();
      expect(Array.isArray(cmdCall![0].commands)).toBe(true);
    });
  });

  describe("expandSection", () => {
    it("posts expandSection message", () => {
      const { view, postMessage } = makeWebviewView();
      provider.resolveWebviewView(view);
      postMessage.mockClear();
      provider.expandSection("config");
      expect(postMessage).toHaveBeenCalledWith({
        type: "expandSection",
        section: "config",
      });
    });

    it("refreshes containers when section is containers", () => {
      const { view } = makeWebviewView();
      provider.resolveWebviewView(view);
      const spy = vi.spyOn(provider, "refreshContainers");
      provider.expandSection("containers");
      expect(spy).toHaveBeenCalled();
    });

    it("refreshes volumes when section is volumes", () => {
      const { view } = makeWebviewView();
      provider.resolveWebviewView(view);
      const spy = vi.spyOn(provider, "refreshVolumes");
      provider.expandSection("volumes");
      expect(spy).toHaveBeenCalled();
    });
  });

  describe("refreshContainers", () => {
    it("posts updateContainers on success", async () => {
      const { view, postMessage } = makeWebviewView();
      provider.resolveWebviewView(view);
      postMessage.mockClear();
      (provider as any).containerService.refreshContainers = vi
        .fn()
        .mockResolvedValue([{ id: "1", name: "c1" }]);
      await provider.refreshContainers();
      expect(postMessage).toHaveBeenCalledWith({
        type: "updateContainers",
        containers: [{ id: "1", name: "c1" }],
      });
    });

    it("posts empty containers on error", async () => {
      const { view, postMessage } = makeWebviewView();
      provider.resolveWebviewView(view);
      postMessage.mockClear();
      (provider as any).containerService.refreshContainers = vi
        .fn()
        .mockRejectedValue(new Error("boom"));
      await provider.refreshContainers();
      expect(postMessage).toHaveBeenCalledWith({
        type: "updateContainers",
        containers: [],
      });
    });

    it("wraps non-Error throws", async () => {
      const { view, postMessage } = makeWebviewView();
      provider.resolveWebviewView(view);
      postMessage.mockClear();
      (provider as any).containerService.refreshContainers = vi
        .fn()
        .mockRejectedValue("string error");
      await provider.refreshContainers();
      expect(postMessage).toHaveBeenCalledWith({
        type: "updateContainers",
        containers: [],
      });
    });
  });

  describe("refreshVolumes", () => {
    it("posts updateVolumes on success", async () => {
      const { view, postMessage } = makeWebviewView();
      provider.resolveWebviewView(view);
      postMessage.mockClear();
      (provider as any).volumeService.refreshVolumes = vi
        .fn()
        .mockResolvedValue([{ name: "v1" }]);
      await provider.refreshVolumes();
      expect(postMessage).toHaveBeenCalledWith({
        type: "updateVolumes",
        volumes: [{ name: "v1" }],
      });
    });

    it("posts empty volumes on error", async () => {
      const { view, postMessage } = makeWebviewView();
      provider.resolveWebviewView(view);
      postMessage.mockClear();
      (provider as any).volumeService.refreshVolumes = vi
        .fn()
        .mockRejectedValue(new Error("boom"));
      await provider.refreshVolumes();
      expect(postMessage).toHaveBeenCalledWith({
        type: "updateVolumes",
        volumes: [],
      });
    });

    it("wraps non-Error throws", async () => {
      const { view, postMessage } = makeWebviewView();
      provider.resolveWebviewView(view);
      postMessage.mockClear();
      (provider as any).volumeService.refreshVolumes = vi
        .fn()
        .mockRejectedValue(42);
      await provider.refreshVolumes();
      expect(postMessage).toHaveBeenCalledWith({
        type: "updateVolumes",
        volumes: [],
      });
    });
  });

  describe("dispose", () => {
    it("clears pending messages and view", () => {
      const { view } = makeWebviewView();
      provider.resolveWebviewView(view);
      provider.dispose();
      expect((provider as any)._view).toBeUndefined();
      expect((provider as any)._pendingMessages).toHaveLength(0);
    });

    it("disposes registered disposables", () => {
      const d1 = { dispose: vi.fn() };
      (provider as any)._disposables.push(d1);
      provider.dispose();
      expect(d1.dispose).toHaveBeenCalled();
    });
  });
});

describe("SidebarProvider.handleMessage", () => {
  let provider: SidebarProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = createProvider();
  });

  function makeWebviewView(visible = true) {
    const postMessage = vi.fn();
    const onDidReceiveMessage = vi.fn();
    const onDidChangeVisibility = vi.fn().mockReturnValue({ dispose: vi.fn() });
    const asWebviewUri = vi.fn((u: any) => ({
      ...u,
      toString: () => `webview-uri:${u?.fsPath ?? u?.path ?? ""}`,
    }));
    const webview: any = {
      options: undefined,
      html: "",
      postMessage,
      onDidReceiveMessage,
      asWebviewUri,
    };
    const view: any = { webview, visible, onDidChangeVisibility };
    return {
      webview,
      view,
      postMessage,
      onDidReceiveMessage,
      onDidChangeVisibility,
    };
  }

  it("delegates repairConfig to configEdit", async () => {
    (provider as any).configEdit.repairConfig = vi.fn();
    await (provider as any).handleMessage({ type: "repairConfig" });
    expect((provider as any).configEdit.repairConfig).toHaveBeenCalled();
  });

  it("delegates openConfigFile to configEdit", async () => {
    (provider as any).configEdit.openConfigFileInEditor = vi.fn();
    await (provider as any).handleMessage({ type: "openConfigFile" });
    expect(
      (provider as any).configEdit.openConfigFileInEditor,
    ).toHaveBeenCalled();
  });

  it("routes aiGenerateConfig message", async () => {
    (provider as any).ai.aiGenerateConfig = vi.fn();
    await (provider as any).handleMessage({ type: "aiGenerateConfig" });
    expect((provider as any).ai.aiGenerateConfig).toHaveBeenCalled();
  });

  it("routes aiUpdateConfig message", async () => {
    (provider as any).ai.aiUpdateConfig = vi.fn();
    await (provider as any).handleMessage({ type: "aiUpdateConfig" });
    expect((provider as any).ai.aiUpdateConfig).toHaveBeenCalled();
  });

  it("routes aiFixConfig message", async () => {
    (provider as any).ai.aiFixConfig = vi.fn();
    await (provider as any).handleMessage({ type: "aiFixConfig" });
    expect((provider as any).ai.aiFixConfig).toHaveBeenCalled();
  });

  it("ready message triggers loadConfig + refreshes", async () => {
    const { view } = makeWebviewView();
    provider.resolveWebviewView(view);
    const loadSpy = vi.spyOn((provider as any).configEdit, "loadConfig");
    const contSpy = vi.spyOn(provider, "refreshContainers");
    const volSpy = vi.spyOn(provider, "refreshVolumes");
    const cmdSpy = vi.spyOn(provider, "refreshCommands");
    await (provider as any).handleMessage({ type: "ready" });
    expect(loadSpy).toHaveBeenCalled();
    expect(contSpy).toHaveBeenCalled();
    expect(volSpy).toHaveBeenCalled();
    expect(cmdSpy).toHaveBeenCalled();
  });

  it("toggleSoftware delegates to configEdit", async () => {
    (provider as any).configEdit.toggleSoftware = vi.fn();
    await (provider as any).handleMessage({
      type: "toggleSoftware",
      featureRef: "python",
      enabled: true,
    });
    expect((provider as any).configEdit.toggleSoftware).toHaveBeenCalledWith(
      "python",
      true,
    );
  });

  it("toggleOption delegates to configEdit", async () => {
    (provider as any).configEdit.toggleOption = vi.fn();
    await (provider as any).handleMessage({
      type: "toggleOption",
      feature: "gpu",
      enabled: true,
      mountPath: "/x",
    });
    expect((provider as any).configEdit.toggleOption).toHaveBeenCalledWith(
      "gpu",
      true,
      "/x",
    );
  });

  it("addPort delegates to configEdit", async () => {
    (provider as any).configEdit.addPort = vi.fn();
    await (provider as any).handleMessage({
      type: "addPort",
      port: 3000,
      label: "web",
    });
    expect((provider as any).configEdit.addPort).toHaveBeenCalledWith(
      3000,
      "web",
    );
  });

  it("removePort delegates to configEdit", async () => {
    (provider as any).configEdit.removePort = vi.fn();
    await (provider as any).handleMessage({
      type: "removePort",
      index: 2,
    });
    expect((provider as any).configEdit.removePort).toHaveBeenCalledWith(2);
  });

  it("addExtension delegates to configEdit", async () => {
    (provider as any).configEdit.addExtension = vi.fn();
    await (provider as any).handleMessage({
      type: "addExtension",
      extensionId: "ms-python.python",
    });
    expect((provider as any).configEdit.addExtension).toHaveBeenCalledWith(
      "ms-python.python",
    );
  });

  it("removeExtension delegates to configEdit", async () => {
    (provider as any).configEdit.removeExtension = vi.fn();
    await (provider as any).handleMessage({
      type: "removeExtension",
      index: 1,
    });
    expect((provider as any).configEdit.removeExtension).toHaveBeenCalledWith(
      1,
    );
  });

  it("toggleExtension delegates to configEdit", async () => {
    (provider as any).configEdit.toggleExtension = vi.fn();
    await (provider as any).handleMessage({
      type: "toggleExtension",
      extensionId: "ext",
      enabled: false,
    });
    expect((provider as any).configEdit.toggleExtension).toHaveBeenCalledWith(
      "ext",
      false,
    );
  });

  it("addMount delegates to configEdit", async () => {
    (provider as any).configEdit.addMount = vi.fn();
    await (provider as any).handleMessage({
      type: "addMount",
      source: "/src",
      target: "/tgt",
    });
    expect((provider as any).configEdit.addMount).toHaveBeenCalledWith(
      "/src",
      "/tgt",
    );
  });

  it("removeMount delegates to configEdit", async () => {
    (provider as any).configEdit.removeMount = vi.fn();
    await (provider as any).handleMessage({
      type: "removeMount",
      index: 0,
    });
    expect((provider as any).configEdit.removeMount).toHaveBeenCalledWith(0);
  });

  it("addRunArg delegates to configEdit", async () => {
    (provider as any).configEdit.addRunArg = vi.fn();
    await (provider as any).handleMessage({
      type: "addRunArg",
      arg: "--privileged",
    });
    expect((provider as any).configEdit.addRunArg).toHaveBeenCalledWith(
      "--privileged",
    );
  });

  it("removeRunArg delegates to configEdit", async () => {
    (provider as any).configEdit.removeRunArg = vi.fn();
    await (provider as any).handleMessage({
      type: "removeRunArg",
      index: 3,
    });
    expect((provider as any).configEdit.removeRunArg).toHaveBeenCalledWith(3);
  });

  it("setRemoteUser delegates to configEdit", async () => {
    (provider as any).configEdit.setRemoteUser = vi.fn();
    await (provider as any).handleMessage({
      type: "setRemoteUser",
      user: "node",
    });
    expect((provider as any).configEdit.setRemoteUser).toHaveBeenCalledWith(
      "node",
    );
  });

  it("action message executes vscode command", async () => {
    await (provider as any).handleMessage({
      type: "action",
      command: "artizo.someCommand",
    });
    expect(mocks.vscode.commands.executeCommand).toHaveBeenCalledWith(
      "artizo.someCommand",
    );
  });

  it("runCommand message executes vscode command", async () => {
    await (provider as any).handleMessage({
      type: "runCommand",
      command: "artizo.runIt",
    });
    expect(mocks.vscode.commands.executeCommand).toHaveBeenCalledWith(
      "artizo.runIt",
    );
  });

  it("containerAction delegates to handleContainerAction", async () => {
    const spy = vi.spyOn(
      (provider as any).containerService,
      "handleContainerAction",
    );
    await (provider as any).handleMessage({
      type: "containerAction",
      action: "start",
      containerId: "abc",
      containerName: "my-container",
    });
    expect(spy).toHaveBeenCalledWith("start", "abc", "my-container");
  });

  it("containerAction start triggers refreshContainers", async () => {
    const { view } = makeWebviewView();
    provider.resolveWebviewView(view);
    vi.spyOn(
      (provider as any).containerService,
      "handleContainerAction",
    ).mockResolvedValue(undefined);
    const spy = vi.spyOn(provider, "refreshContainers");
    await (provider as any).handleMessage({
      type: "containerAction",
      action: "start",
      containerId: "abc",
    });
    expect(spy).toHaveBeenCalled();
  });

  it("containerAction connectCurrentWindow does not refresh", async () => {
    const { view } = makeWebviewView();
    provider.resolveWebviewView(view);
    vi.spyOn(
      (provider as any).containerService,
      "handleContainerAction",
    ).mockResolvedValue(undefined);
    const spy = vi.spyOn(provider, "refreshContainers");
    await (provider as any).handleMessage({
      type: "containerAction",
      action: "connectCurrentWindow",
      containerId: "abc",
    });
    expect(spy).not.toHaveBeenCalled();
  });

  it("volumeAction delegates to handleVolumeAction", async () => {
    const spy = vi.spyOn((provider as any).volumeService, "handleVolumeAction");
    await (provider as any).handleMessage({
      type: "volumeAction",
      action: "inspect",
      volumeName: "vol1",
    });
    expect(spy).toHaveBeenCalledWith("inspect", "vol1");
  });

  it("volumeAction remove triggers refreshVolumes", async () => {
    const { view } = makeWebviewView();
    provider.resolveWebviewView(view);
    vi.spyOn(
      (provider as any).volumeService,
      "handleVolumeAction",
    ).mockResolvedValue(undefined);
    const spy = vi.spyOn(provider, "refreshVolumes");
    await (provider as any).handleMessage({
      type: "volumeAction",
      action: "remove",
      volumeName: "vol1",
    });
    expect(spy).toHaveBeenCalled();
  });

  it("volumeAction inspect does not refresh", async () => {
    const { view } = makeWebviewView();
    provider.resolveWebviewView(view);
    vi.spyOn(
      (provider as any).volumeService,
      "handleVolumeAction",
    ).mockResolvedValue(undefined);
    const spy = vi.spyOn(provider, "refreshVolumes");
    await (provider as any).handleMessage({
      type: "volumeAction",
      action: "inspect",
      volumeName: "vol1",
    });
    expect(spy).not.toHaveBeenCalled();
  });

  it("refreshSection containers triggers refreshContainers", async () => {
    const { view } = makeWebviewView();
    provider.resolveWebviewView(view);
    const spy = vi.spyOn(provider, "refreshContainers");
    await (provider as any).handleMessage({
      type: "refreshSection",
      section: "containers",
    });
    expect(spy).toHaveBeenCalled();
  });

  it("refreshSection volumes triggers refreshVolumes", async () => {
    const { view } = makeWebviewView();
    provider.resolveWebviewView(view);
    const spy = vi.spyOn(provider, "refreshVolumes");
    await (provider as any).handleMessage({
      type: "refreshSection",
      section: "volumes",
    });
    expect(spy).toHaveBeenCalled();
  });

  it("generateConfig message delegates to generateConfig", async () => {
    const spy = vi.spyOn(provider as any, "generateConfig");
    await (provider as any).handleMessage({
      type: "generateConfig",
      image: "node:18",
    });
    expect(spy).toHaveBeenCalledWith("node:18");
  });
});

describe("SidebarProvider.generateConfig", () => {
  let provider: SidebarProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = createProvider();
  });

  it("returns early when no workspace folder", async () => {
    mocks.vscode.workspace.workspaceFolders = [];
    const spy = vi.spyOn((provider as any).configEdit, "loadConfig");
    await (provider as any).generateConfig("node:18");
    expect(spy).not.toHaveBeenCalled();
    mocks.vscode.workspace.workspaceFolders = [
      { uri: { fsPath: "/test/workspace" } },
    ];
  });

  it("creates config dir and file on success", async () => {
    const createDir = mocks.vscode.workspace.fs.createDirectory;
    const writeFile = mocks.vscode.workspace.fs.writeFile;
    const loadSpy = vi.spyOn((provider as any).configEdit, "loadConfig");
    await (provider as any).generateConfig("node:18");
    expect(createDir).toHaveBeenCalled();
    expect(writeFile).toHaveBeenCalled();
    expect(loadSpy).toHaveBeenCalled();
  });

  it("posts expandSection config on success", async () => {
    const postSpy = vi.spyOn(provider, "postMessage");
    await (provider as any).generateConfig("node:18");
    expect(postSpy).toHaveBeenCalledWith({
      type: "expandSection",
      section: "config",
    });
  });

  it("posts configMissing and shows error on fs failure", async () => {
    const createDir = mocks.vscode.workspace.fs.createDirectory;
    createDir.mockRejectedValueOnce(new Error("disk full"));
    const postSpy = vi.spyOn(provider, "postMessage");
    const showErr = mocks.vscode.window.showErrorMessage;
    await (provider as any).generateConfig("node:18");
    expect(postSpy).toHaveBeenCalledWith({ type: "configMissing" });
    expect(showErr).toHaveBeenCalledWith(
      expect.stringContaining("Failed to create config"),
    );
  });

  it("wraps non-Error failures in error message", async () => {
    mocks.vscode.workspace.fs.createDirectory.mockRejectedValueOnce("oops");
    const showErr = mocks.vscode.window.showErrorMessage;
    await (provider as any).generateConfig("node:18");
    expect(showErr).toHaveBeenCalledWith(expect.stringContaining("oops"));
  });
});
