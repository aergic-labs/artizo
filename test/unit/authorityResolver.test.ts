/*
 * Copyright (c) 2026 Aergic Labs, LLC
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import vscodeMock from "../__mocks__/vscode";

vi.mock("vscode", () => ({ default: vscodeMock, ...vscodeMock }));

// Mock child_process for docker commands
vi.mock("node:child_process", () => ({
  execFile: vi.fn(),
}));

// Mock sshTunnel so the proxy path tests don't spawn real ssh processes or
// touch the network. Deterministic ports + fake child process.
const { mockStartManagedSshTunnel, mockTunnelStop } = vi.hoisted(() => ({
  mockStartManagedSshTunnel: vi.fn(),
  mockTunnelStop: vi.fn(),
}));
vi.mock("../../src/remote/sshTunnel", () => ({
  startManagedSshTunnel: mockStartManagedSshTunnel,
  pickFreePort: vi.fn(),
}));

// Mock execServerBridge so proxy path tests don't create real servers.
const { mockStartExecServerBridge } = vi.hoisted(() => ({
  mockStartExecServerBridge: vi.fn(),
}));
vi.mock("../../src/remote/execServerBridge", () => ({
  startExecServerBridge: mockStartExecServerBridge,
}));
import { execFile } from "node:child_process";
import * as vscode from "vscode";
import {
  RemoteAuthorityResolver,
  registerAuthorityResolver,
  SCHEME_DEV_CONTAINER,
  SCHEME_ATTACHED_CONTAINER,
} from "../../src/remote/authorityResolver";
import { encodeAuthority } from "../../src/utils/uriUtils";

const mockExecFile = vi.mocked(execFile);

/** Helper to set up execFile mock for docker inspect and docker ps commands. */
function setupMockForInspect(
  containerData: Record<string, unknown>,
  exitCode = 0,
) {
  mockExecFile.mockImplementation((_cmd: any, args: any, ...rest: any[]) => {
    const callback = typeof rest[0] === "function" ? rest[0] : rest[1];
    const argsArray = args as string[];

    if (argsArray[0] === "inspect") {
      if (exitCode !== 0) {
        const error: any = new Error("Command failed");
        error.code = exitCode;
        error.stdout = "";
        error.stderr = "No such container";
        callback(error, "", "No such container");
      } else {
        callback(null, JSON.stringify(containerData), "");
      }
    } else {
      callback(null, "", "");
    }
    return {} as any;
  });
}

function setupMockForPs(containerId: string) {
  mockExecFile.mockImplementation((_cmd: any, args: any, ...rest: any[]) => {
    const callback = typeof rest[0] === "function" ? rest[0] : rest[1];
    const argsArray = args as string[];

    if (argsArray[0] === "ps") {
      callback(null, containerId ? `${containerId}\n` : "", "");
    } else if (argsArray[0] === "inspect") {
      // After finding via ps, inspect is called
      const data = makeContainerData({ Id: containerId });
      callback(null, JSON.stringify(data), "");
    } else {
      callback(null, "", "");
    }
    return {} as any;
  });
}

function makeContainerData(overrides: Record<string, unknown> = {}) {
  return {
    Id: "abc123def456",
    Name: "/my-container",
    State: { Status: "running", Running: true, Pid: 1234 },
    Config: {
      Image: "node:18",
      Labels: { "devcontainer.local_folder": "/home/user/project" },
      Env: ["NODE_ENV=development"],
      WorkingDir: "/workspace",
    },
    Mounts: [],
    NetworkSettings: { Ports: {} },
    ...overrides,
  };
}

describe("RemoteAuthorityResolver", () => {
  let resolver: RemoteAuthorityResolver;

  beforeEach(() => {
    vi.clearAllMocks();
    resolver = new RemoteAuthorityResolver();
  });

  describe("resolve - attached-container scheme", () => {
    it("resolves a running container by ID", async () => {
      const containerId = "abc123def456";
      const authority = encodeAuthority(SCHEME_ATTACHED_CONTAINER, containerId);
      const containerData = makeContainerData({ Id: containerId });

      setupMockForInspect(containerData);

      const result = await resolver.resolve(authority);

      expect(result.type).toBe("success");
      if (result.type === "success") {
        expect(result.authority.host).toBe(containerId);
        expect(result.authority.port).toBe(0);
      }
    });

    it("returns error for a stopped container", async () => {
      const containerId = "stopped123";
      const authority = encodeAuthority(SCHEME_ATTACHED_CONTAINER, containerId);
      const containerData = makeContainerData({
        Id: containerId,
        State: { Status: "exited", Running: false, Pid: 0 },
      });

      setupMockForInspect(containerData);

      const result = await resolver.resolve(authority);

      expect(result.type).toBe("error");
      if (result.type === "error") {
        expect(result.message).toContain("not running");
        expect(result.message).toContain("exited");
      }
    });

    it("returns error when docker inspect fails", async () => {
      const containerId = "nonexistent";
      const authority = encodeAuthority(SCHEME_ATTACHED_CONTAINER, containerId);

      setupMockForInspect({}, 1);

      const result = await resolver.resolve(authority);

      expect(result.type).toBe("error");
      if (result.type === "error") {
        expect(result.message).toContain("Failed to inspect container");
      }
    });
  });

  describe("resolve - dev-container scheme", () => {
    it("resolves a dev container by workspace path", async () => {
      const workspacePath = "/home/user/project";
      const authority = encodeAuthority(SCHEME_DEV_CONTAINER, workspacePath);

      setupMockForPs("abc123def456");

      const result = await resolver.resolve(authority);

      expect(result.type).toBe("success");
      if (result.type === "success") {
        expect(result.authority.host).toBe("abc123def456");
        expect(result.authority.port).toBe(0);
      }
    });

    it("returns error when no container found for workspace", async () => {
      const workspacePath = "/nonexistent/path";
      const authority = encodeAuthority(SCHEME_DEV_CONTAINER, workspacePath);

      // docker ps returns empty
      mockExecFile.mockImplementation(
        (_cmd: any, _args: any, ...rest: any[]) => {
          const callback = typeof rest[0] === "function" ? rest[0] : rest[1];
          callback(null, "", "");
          return {} as any;
        },
      );

      const result = await resolver.resolve(authority);

      expect(result.type).toBe("error");
      if (result.type === "error") {
        expect(result.message).toContain("No dev container found");
        expect(result.message).toContain(workspacePath);
      }
    });
  });

  describe("resolve - error cases", () => {
    it("returns error for invalid authority format", async () => {
      const result = await resolver.resolve("invalid-no-plus");

      expect(result.type).toBe("error");
      if (result.type === "error") {
        expect(result.message).toContain("Failed to decode authority");
      }
    });

    it("returns error for unknown scheme", async () => {
      const authority = encodeAuthority("unknown-scheme", "some-id");

      const result = await resolver.resolve(authority);

      expect(result.type).toBe("error");
      if (result.type === "error") {
        expect(result.message).toContain("Unknown authority scheme");
        expect(result.message).toContain("unknown-scheme");
      }
    });

    it("returns error for empty hex in authority", async () => {
      const result = await resolver.resolve("dev-container+");

      expect(result.type).toBe("error");
      if (result.type === "error") {
        expect(result.message).toContain("Failed to decode authority");
      }
    });
  });

  describe("findContainerByLabel", () => {
    it("finds container by workspace label", async () => {
      mockExecFile.mockImplementation(
        (_cmd: any, _args: any, ...rest: any[]) => {
          const callback = typeof rest[0] === "function" ? rest[0] : rest[1];
          callback(null, "container123\n", "");
          return {} as any;
        },
      );

      const result = await resolver.findContainerByLabel("/home/user/project");
      expect(result).toBe("container123");
    });

    it("returns undefined when no container matches", async () => {
      mockExecFile.mockImplementation(
        (_cmd: any, _args: any, ...rest: any[]) => {
          const callback = typeof rest[0] === "function" ? rest[0] : rest[1];
          callback(null, "", "");
          return {} as any;
        },
      );

      const result = await resolver.findContainerByLabel("/no/match");
      expect(result).toBeUndefined();
    });

    it("returns undefined when docker ps fails", async () => {
      mockExecFile.mockImplementation(
        (_cmd: any, _args: any, ...rest: any[]) => {
          const callback = typeof rest[0] === "function" ? rest[0] : rest[1];
          callback(new Error("Docker not available"), "", "");
          return {} as any;
        },
      );

      const result = await resolver.findContainerByLabel("/some/path");
      expect(result).toBeUndefined();
    });

    it("returns first container when multiple match", async () => {
      mockExecFile.mockImplementation(
        (_cmd: any, _args: any, ...rest: any[]) => {
          const callback = typeof rest[0] === "function" ? rest[0] : rest[1];
          callback(null, "first123\nsecond456\n", "");
          return {} as any;
        },
      );

      const result = await resolver.findContainerByLabel("/some/path");
      expect(result).toBe("first123");
    });
  });

  describe("getCanonicalURI", () => {
    it("returns the URI unchanged", () => {
      const uri = {
        scheme: "vscode-remote",
        authority: "dev-container+abc123",
      } as any;
      expect(resolver.getCanonicalURI(uri)).toBe(uri);
    });
  });

  describe("custom docker path", () => {
    it("uses custom docker path for inspect", async () => {
      const customResolver = new RemoteAuthorityResolver({
        dockerPath: "/usr/local/bin/docker",
      });
      const containerId = "abc123";
      const authority = encodeAuthority(SCHEME_ATTACHED_CONTAINER, containerId);
      const containerData = makeContainerData({ Id: containerId });

      setupMockForInspect(containerData);

      await customResolver.resolve(authority);

      const calls = mockExecFile.mock.calls;
      expect(calls.some((call) => call[0] === "/usr/local/bin/docker")).toBe(
        true,
      );
    });
  });
});

// Mocks for the port-forwarding wiring test. hoisted so they're available
  // before the resolver module imports its dependencies.
  const {
    mockResolveConfigVars,
    mockForwardPort,
    mockRetarget,
    mockPortViewRegister,
  } = vi.hoisted(() => ({
    mockResolveConfigVars: vi.fn(),
    mockForwardPort: vi.fn().mockResolvedValue(undefined),
    mockRetarget: vi.fn().mockResolvedValue(undefined),
    mockPortViewRegister: vi.fn(),
  }));
  vi.mock("../../src/devcontainer/readResolvedConfig", () => ({
    resolveConfigVars: mockResolveConfigVars,
  }));
  vi.mock("../../src/ports/portForwarder", () => ({
    PortForwarder: vi.fn().mockImplementation(function () {
      return {
        forwardPort: mockForwardPort,
        retarget: mockRetarget,
        unforwardPort: vi.fn().mockResolvedValue(undefined),
        getForwardedPorts: vi.fn().mockReturnValue([]),
        onDidForwardPort: vi.fn(),
        onDidUnforwardPort: vi.fn(),
        dispose: vi.fn(),
      };
    }),
  }));
  vi.mock("../../src/ports/portView", () => ({
    PortViewProvider: {
      register: mockPortViewRegister.mockReturnValue({}),
    },
  }));

  import { PortForwarder as PortForwarderCtor } from "../../src/ports/portForwarder";

  /**
   * Builds a fake IServerManager that resolves `start` to a fixed ServerInfo with
   * the installPath the resolver uses to derive `nodePath`.
   */
  function makeMockServerManager(installPath: string): IServerManagerLike {
    return {
      ensureInstalled: vi.fn().mockResolvedValue({ installPath, port: 0 }),
      start: vi.fn().mockResolvedValue({
        commit: "abc123",
        arch: "x64",
        installPath,
        port: 40000,
        connectionToken: "tok",
      }),
      stop: vi.fn().mockResolvedValue(undefined),
      getStatus: vi.fn().mockResolvedValue(null),
      getCompatibleVersion: vi.fn().mockReturnValue("1.0.0"),
      getServerDataDir: vi.fn().mockReturnValue("/srv/data"),
      getInstallPath: vi.fn().mockResolvedValue(installPath),
    } as unknown as IServerManagerLike;
  }

  type IServerManagerLike = {
    ensureInstalled(containerId: string, remoteUser?: string): Promise<unknown>;
    start(
      containerId: string,
      remoteUser?: string,
      config?: Record<string, unknown>,
    ): Promise<{
      installPath: string;
      port: number;
      connectionToken?: string;
      commit: string;
      arch: string;
    }>;
    stop(containerId: string): Promise<void>;
    getStatus(containerId: string): Promise<unknown>;
    getCompatibleVersion(): string;
    getServerDataDir(installRoot: string): string;
  };

  describe("RemoteAuthorityResolver - port forwarding wiring", () => {
    const containerId = "art-container-id";
    const installPath = "/tmp/.x/bin/abc123";
    // Spec-valid forwardPorts: numbers and "host:port" strings. Object
    // entries ({ port, label }) are rejected by forwardPortsFromConfig;
    // labels belong in portsAttributes.
    const forwardPorts = [8080, 5432, "localhost:3000"];
    let resolver: RemoteAuthorityResolver;
    let mockContext: any;
    let mockServerManager: IServerManagerLike;
    let mockExecuteCommand: ReturnType<typeof vi.fn>;

    beforeEach(() => {
      vi.clearAllMocks();
      mockResolveConfigVars.mockResolvedValue({ forwardPorts });
      mockServerManager = makeMockServerManager(installPath);
      mockContext = {
        extensionPath: "/ext/path",
        subscriptions: [],
      };
      mockExecuteCommand = vi.fn();
      // Patch the shared vscode mock's executeCommand for this test so we can
      // observe the setContext calls. Restored via clearAllMocks + the mock
      // being a method on the shared object.
      (vscode as any).commands.executeCommand = mockExecuteCommand;
      resolver = new RemoteAuthorityResolver({
        serverManager: mockServerManager as any,
        context: mockContext as any,
      });
      // Stub the server-control relay path so it doesn't touch node:net or
      // node:child_process (not mocked here). The port-forwarding wiring under
      // test is independent of this path.
      (resolver as any).forwardContainerPort = vi
        .fn()
        .mockResolvedValue(40000);
    });

    it("forwards config-declared ports with source 'config' and sets artizo.connected", async () => {
      const containerData = makeContainerData({
        Id: containerId,
        Config: {
          Image: "node:18",
          Labels: {
            "artizo.config_file": "/work/cfg.json",
            "artizo.local_folder": "/work",
          },
        },
      });
      setupMockForInspect(containerData);

      const authority = encodeAuthority(SCHEME_ATTACHED_CONTAINER, containerId);
      const result = await resolver.resolve(authority);
      expect(result.type).toBe("success");

      // forwardPort must be called for 8080, 5432, and 3000 (parsed from
      // "localhost:3000") with source "config", no label.
      const forwardCalls = mockForwardPort.mock.calls.map((c) => c);
      expect(forwardCalls).toContainEqual([8080, 8080, undefined, "config"]);
      expect(forwardCalls).toContainEqual([5432, 5432, undefined, "config"]);
      expect(forwardCalls).toContainEqual([3000, 3000, undefined, "config"]);
      expect(forwardCalls).toHaveLength(3);
      // The view must become visible.
      expect(mockExecuteCommand).toHaveBeenCalledWith(
        "setContext",
        "artizo.connected",
        true,
      );
      // PortViewProvider.register must have been called once with the context + a forwarder.
      expect(mockPortViewRegister).toHaveBeenCalledTimes(1);
      expect(mockPortViewRegister).toHaveBeenCalledWith(mockContext, expect.any(Object));
    });

    it("reuses the same PortForwarder across re-attach via retarget()", async () => {
      const containerData = makeContainerData({
        Id: containerId,
        Config: {
          Image: "node:18",
          Labels: {
            "artizo.config_file": "/work/cfg.json",
            "artizo.local_folder": "/work",
          },
        },
      });
      setupMockForInspect(containerData);
      const authority = encodeAuthority(SCHEME_ATTACHED_CONTAINER, containerId);
      // First attach: creates a PortForwarder and registers the view.
      await resolver.resolve(authority);
      const firstCtorCallCount = (PortForwarderCtor as unknown as any).mock.calls.length;
      expect(firstCtorCallCount).toBeGreaterThanOrEqual(1);
      const firstForwarderInstance = (PortForwarderCtor as unknown as any).mock
        .results[firstCtorCallCount - 1].value;
      // Second attach (same container, possibly re-opened window): the forwarder
      // must be retargeted, not recreated.
      mockForwardPort.mockClear();
      await resolver.resolve(authority);
      const secondCtorCallCount = (PortForwarderCtor as unknown as any).mock.calls.length;
      expect(secondCtorCallCount).toBe(firstCtorCallCount); // no new constructor
      expect(mockRetarget).toHaveBeenCalledWith(containerId, `${installPath}/node`);
      // Re-forward config ports on the retargeted forwarder.
      const forwardCalls = mockForwardPort.mock.calls.map((c) => c);
      expect(forwardCalls).toContainEqual([8080, 8080, undefined, "config"]);
      expect(forwardCalls).toContainEqual([5432, 5432, undefined, "config"]);
      expect(forwardCalls).toContainEqual([3000, 3000, undefined, "config"]);
      // firstForwarderInstance is the one used by the resolver (stable reference).
      expect(mockPortViewRegister).toHaveBeenCalledWith(
        mockContext,
        firstForwarderInstance,
      );
    });

    it("registers the Ports view in a connected window where resolve() never ran", async () => {
      // The attached window is a fresh extension host: the resolver's own
      // wiring (inside resolveContainerById) never runs there, so activation
      // calls ensurePortsForAttachedWindow instead.
      (vscode.env as any).remoteAuthority = encodeAuthority(
        SCHEME_ATTACHED_CONTAINER,
        containerId,
      );
      setupMockForInspect(
        makeContainerData({
          Id: containerId,
          Config: {
            Image: "node:18",
            Labels: {
              "artizo.config_file": "/work/cfg.json",
              "artizo.local_folder": "/work",
            },
          },
        }),
      );

      await resolver.ensurePortsForAttachedWindow();

      // Created (not retargeted): this host never resolved the authority.
      expect(mockRetarget).not.toHaveBeenCalled();
      expect(mockPortViewRegister).toHaveBeenCalledTimes(1);
      expect(mockPortViewRegister).toHaveBeenCalledWith(
        mockContext,
        expect.any(Object),
      );
      expect(mockExecuteCommand).toHaveBeenCalledWith(
        "setContext",
        "artizo.connected",
        true,
      );
      // The forwarder from the resolving window died with that host, so the
      // configured ports are forwarded again here.
      const forwardCalls = mockForwardPort.mock.calls;
      expect(forwardCalls).toContainEqual([8080, 8080, undefined, "config"]);
      expect(forwardCalls).toContainEqual([5432, 5432, undefined, "config"]);
      expect(forwardCalls).toContainEqual([3000, 3000, undefined, "config"]);
    });

    it("ensurePortsForAttachedWindow is a no-op without a remote authority", async () => {
      (vscode.env as any).remoteAuthority = undefined;

      await resolver.ensurePortsForAttachedWindow();

      expect(mockPortViewRegister).not.toHaveBeenCalled();
    });

    it("skips object forwardPorts entries instead of forwarding them", async () => {
      // Spec: forwardPorts is numbers or "host:port" strings only. Object
      // entries (e.g. { port, label }) must be rejected, not normalized.
      mockResolveConfigVars.mockResolvedValue({
        forwardPorts: [8080, { port: 5432, label: "DB" }],
      });
      const containerData = makeContainerData({
        Id: containerId,
        Config: {
          Image: "node:18",
          Labels: {
            "artizo.config_file": "/work/cfg.json",
            "artizo.local_folder": "/work",
          },
        },
      });
      setupMockForInspect(containerData);
      const authority = encodeAuthority(SCHEME_ATTACHED_CONTAINER, containerId);
      const result = await resolver.resolve(authority);
      expect(result.type).toBe("success");

      const forwardCalls = mockForwardPort.mock.calls.map((c) => c);
      expect(forwardCalls).toContainEqual([8080, 8080, undefined, "config"]);
      // The object entry must not be forwarded under any label.
      expect(forwardCalls).toHaveLength(1);
      expect(forwardCalls.some((c) => c[2] === "DB")).toBe(false);
    });

    it("skips a string entry without a :port suffix", async () => {
      mockResolveConfigVars.mockResolvedValue({
        forwardPorts: [8080, "not-a-port"],
      });
      const containerData = makeContainerData({
        Id: containerId,
        Config: {
          Image: "node:18",
          Labels: {
            "artizo.config_file": "/work/cfg.json",
            "artizo.local_folder": "/work",
          },
        },
      });
      setupMockForInspect(containerData);
      const authority = encodeAuthority(SCHEME_ATTACHED_CONTAINER, containerId);
      const result = await resolver.resolve(authority);
      expect(result.type).toBe("success");

      const forwardCalls = mockForwardPort.mock.calls.map((c) => c);
      expect(forwardCalls).toEqual([[8080, 8080, undefined, "config"]]);
    });
  });

describe("registerAuthorityResolver", () => {
  let mockContext: any;
  let resolver: RemoteAuthorityResolver;

  beforeEach(() => {
    vi.clearAllMocks();
    resolver = new RemoteAuthorityResolver();
    mockContext = {
      subscriptions: [],
    };
  });

  it("registers via proposed API when available", async () => {
    const vscode = await import("vscode");
    const mockDisposable = { dispose: vi.fn() };
    (vscode as any).workspace = {
      registerRemoteAuthorityResolver: vi.fn().mockReturnValue(mockDisposable),
    };

    registerAuthorityResolver(mockContext, resolver);

    expect(
      (vscode as any).workspace.registerRemoteAuthorityResolver,
    ).toHaveBeenCalledTimes(2);
    expect(
      (vscode as any).workspace.registerRemoteAuthorityResolver,
    ).toHaveBeenCalledWith(SCHEME_DEV_CONTAINER, expect.any(Object));
    expect(
      (vscode as any).workspace.registerRemoteAuthorityResolver,
    ).toHaveBeenCalledWith(SCHEME_ATTACHED_CONTAINER, expect.any(Object));
    expect(mockContext.subscriptions).toHaveLength(2);
  });
});

describe("RemoteAuthorityResolver - State 4 proxy path", () => {
  let resolver: RemoteAuthorityResolver;

  beforeEach(() => {
    vi.clearAllMocks();
    resolver = new RemoteAuthorityResolver();
    mockStartManagedSshTunnel.mockResolvedValue({
      localPort: 54321,
      isAlive: () => true,
      stop: mockTunnelStop,
    });
    // Reset the global vscode mock's getRemoteExecServer to return undefined.
    (vscode.workspace as any).getRemoteExecServer = vi.fn().mockResolvedValue(undefined);
    mockStartExecServerBridge.mockResolvedValue({
      localPort: 54321,
      isAlive: () => true,
      stop: vi.fn(),
    });
  });

  /** Encode a JSON payload as a bare `artizo-container+<hex>` authority. */
  function proxyAuthority(payload: Record<string, unknown>): string {
    return encodeAuthority(SCHEME_DEV_CONTAINER, JSON.stringify(payload));
  }

  it("resolves a proxy payload by starting an ssh -L tunnel", async () => {
    const authority = proxyAuthority({
      proxy: true,
      sshHost: "34.136.190.14",
      sshUser: "dev",
      relayPort: 9888,
      connectionToken: "token-abc",
      workspacePath: "/workspaces",
      sshAuthority: "ssh-remote+test",
    });

    const result = await resolver.resolve(authority);

    expect(result.type).toBe("success");
    if (result.type !== "success") return;
    expect(result.authority.host).toBe("127.0.0.1");
    expect(result.authority.port).toBe(54321);
    expect(result.authority.connectionToken).toBe("token-abc");

    // Tunnel was started with the relay port and SSH target from the payload.
    expect(mockStartManagedSshTunnel).toHaveBeenCalledWith({
      sshHost: "34.136.190.14",
      sshUser: "dev",
      sshPort: 22,
      remotePort: 9888,
      askpass: undefined,
    });
  });

  it("works with attached-container scheme too", async () => {
    const authority = encodeAuthority(
      SCHEME_ATTACHED_CONTAINER,
      JSON.stringify({
        proxy: true,
        sshHost: "1.2.3.4",
        sshUser: "u",
        relayPort: 1,
        connectionToken: "t",
        workspacePath: "/w",
        sshAuthority: "ssh-remote+test2",
      }),
    );

    const result = await resolver.resolve(authority);
    expect(result.type).toBe("success");
  });

  it("returns error when the ssh tunnel fails to start", async () => {
    mockStartManagedSshTunnel.mockRejectedValue(
      new Error("connection refused"),
    );
    const authority = proxyAuthority({
      proxy: true,
      sshHost: "h",
      sshUser: "u",
      relayPort: 9,
      connectionToken: "t",
      workspacePath: "/w",
      sshAuthority: "ssh-remote+errortest",
    });

    const result = await resolver.resolve(authority);
    expect(result.type).toBe("error");
    if (result.type === "error") {
      expect(result.message).toContain("Artizo SSH tunnel failed");
      expect(result.message).toContain("connection refused");
    }
  });

  it("uses ExecServer bridge when getRemoteExecServer returns an execServer", async () => {
    const mockExecServer = { tcpConnect: vi.fn() };
    (vscode.workspace as any).getRemoteExecServer = vi.fn().mockResolvedValue(mockExecServer);
    mockStartExecServerBridge.mockResolvedValueOnce({
      localPort: 99999,
      isAlive: () => true,
      stop: vi.fn(),
    });
    const authority = proxyAuthority({
      proxy: true,
      sshHost: "h",
      sshUser: "u",
      relayPort: 42,
      connectionToken: "tok",
      workspacePath: "/w",
      sshAuthority: "ssh-remote+exec-test",
    });

    const result = await resolver.resolve(authority);

    expect(result.type).toBe("success");
    if (result.type !== "success") return;
    expect(result.authority.port).toBe(99999);
    expect((vscode.workspace as any).getRemoteExecServer).toHaveBeenCalledWith("ssh-remote+exec-test");
    expect(mockStartExecServerBridge).toHaveBeenCalledWith(
      mockExecServer,
      "127.0.0.1",
      42,
    );
    // ssh tunnel should NOT have been used.
    expect(mockStartManagedSshTunnel).not.toHaveBeenCalled();
  });

  it("falls through to Docker lookup when proxy field is absent", async () => {
    // Same JSON shape but no `proxy: true` - must not be treated as proxy.
    const authority = proxyAuthority({
      sshHost: "h",
      sshUser: "u",
      relayPort: 9,
      connectionToken: "t",
      workspacePath: "/w",
    });

    // No docker mock -> findContainerByLabel returns undefined -> error.
    mockExecFile.mockImplementation((_cmd: any, _args: any, ...rest: any[]) => {
      const cb = typeof rest[0] === "function" ? rest[0] : rest[1];
      cb(null, "", "");
      return {} as any;
    });

    const result = await resolver.resolve(authority);
    expect(result.type).toBe("error");
    expect(mockStartManagedSshTunnel).not.toHaveBeenCalled();
  });

  it("falls through when payload is not JSON", async () => {
    // Plain workspace path, no leading `{`.
    const authority = encodeAuthority(SCHEME_DEV_CONTAINER, "/home/user/proj");
    mockExecFile.mockImplementation((_cmd: any, _args: any, ...rest: any[]) => {
      const cb = typeof rest[0] === "function" ? rest[0] : rest[1];
      cb(null, "", "");
      return {} as any;
    });

    const result = await resolver.resolve(authority);
    expect(result.type).toBe("error");
    expect(mockStartManagedSshTunnel).not.toHaveBeenCalled();
  });

  it("dispose() tears down all spawned tunnels", async () => {
    const authority = proxyAuthority({
      proxy: true,
      sshHost: "h",
      sshUser: "u",
      relayPort: 9,
      connectionToken: "t",
      workspacePath: "/w",
    });
    await resolver.resolve(authority);
    resolver.dispose();
    expect(mockTunnelStop).toHaveBeenCalledTimes(1);
  });
});
