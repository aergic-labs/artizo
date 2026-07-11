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

    // No docker mock → findContainerByLabel returns undefined → error.
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
