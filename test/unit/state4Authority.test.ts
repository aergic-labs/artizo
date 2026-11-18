/*
 * Copyright (c) 2026 Aergic Labs, LLC
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock vscode (required by the logger + host/state import chain).
vi.mock("vscode", () => ({
  window: {
    createOutputChannel: vi.fn(() => ({
      appendLine: vi.fn(),
      show: vi.fn(),
      dispose: vi.fn(),
    })),
  },
  workspace: {
    getConfiguration: vi.fn(() => ({ get: vi.fn() })),
  },
  ExtensionKind: { UI: 1, Workspace: 2 },
}));

const { mockStartRelayDaemon, mockDecodeSshAuthority } = vi.hoisted(() => ({
  mockStartRelayDaemon: vi.fn(),
  mockDecodeSshAuthority: vi.fn(),
}));

vi.mock("../../src/remote/containerProxy", () => ({
  startRelayDaemon: mockStartRelayDaemon,
  decodeSshAuthority: mockDecodeSshAuthority,
}));

import { buildContainerAuthority } from "../../src/remote/state4Authority";
import { ExecutionTier } from "../../src/host/state";
import { decodeAuthority } from "../../src/utils/uriUtils";

function makeUi() {
  return { showBuildLog: vi.fn() } as any;
}

function decodePayload(authority: string): Record<string, unknown> {
  const { id } = decodeAuthority(authority);
  return JSON.parse(id) as Record<string, unknown>;
}

const baseParams = {
  scheme: "artizo-container" as const,
  id: "abc123",
  tier: ExecutionTier.RemoteSSH,
  owner: "workspace" as const,
  remoteAuthority: "ssh-remote+deadbeef",
  containerId: "abc123full",
  containerPort: 38517,
  installPath: "/tmp/.trae-server",
  connectionToken: "token-xyz",
  workspaceFolder: "/home/ubuntu/foo",
  workspacePath: "/workspaces/foo",
  dockerPath: "docker",
  ui: makeUi(),
};

describe("buildContainerAuthority", () => {
  beforeEach(() => {
    mockStartRelayDaemon.mockReset();
    mockDecodeSshAuthority.mockReset();
    mockDecodeSshAuthority.mockReturnValue({
      sshHost: "34.136.190.14",
      sshUser: "dev",
      sshPort: 22,
    });
    mockStartRelayDaemon.mockResolvedValue({
      relayPort: 9888,
      pidFile: "/tmp/artizo-relay.pid",
      pid: 123,
    });
  });

  it("encodes only stable fields in the State 4 payload", async () => {
    const authority = await buildContainerAuthority(baseParams);
    const payload = decodePayload(authority);

    expect(payload.proxy).toBe(true);
    expect(payload.sshHost).toBe("34.136.190.14");
    expect(payload.sshUser).toBe("dev");
    expect(payload.sshPort).toBe(22);
    expect(payload.workspacePath).toBe("/workspaces/foo");
    expect(payload.hostWorkspacePath).toBe("/home/ubuntu/foo");
    expect(payload.sshAuthority).toBe("ssh-remote+deadbeef");

    // Volatile fields must not be encoded: they change on every reopen and
    // would reset workspace trust + per-window state (issue #20).
    expect(payload).not.toHaveProperty("relayPort");
    expect(payload).not.toHaveProperty("connectionToken");
    expect(payload).not.toHaveProperty("containerId");
    expect(payload).not.toHaveProperty("containerPort");
    expect(payload).not.toHaveProperty("installPath");
    expect(payload).not.toHaveProperty("configFile");
  });

  it("includes configFile when the caller supplies it", async () => {
    const authority = await buildContainerAuthority({
      ...baseParams,
      configFile: "/home/ubuntu/foo/.devcontainer/devcontainer.json",
    });
    const payload = decodePayload(authority);
    expect(payload.configFile).toBe(
      "/home/ubuntu/foo/.devcontainer/devcontainer.json",
    );
  });

  it("starts the relay daemon with the container info", async () => {
    await buildContainerAuthority(baseParams);
    expect(mockStartRelayDaemon).toHaveBeenCalledWith({
      containerId: "abc123full",
      containerPort: 38517,
      nodePath: "/tmp/.trae-server/node",
      dockerPath: "docker",
    });
  });

  it("returns a plain authority for non-State-4 tiers", async () => {
    const authority = await buildContainerAuthority({
      ...baseParams,
      tier: ExecutionTier.LocalHost,
    });
    expect(mockStartRelayDaemon).not.toHaveBeenCalled();
    expect(decodeAuthority(authority).id).toBe("abc123");
  });

  it("throws when the SSH authority cannot be decoded", async () => {
    mockDecodeSshAuthority.mockReturnValue(undefined);
    await expect(buildContainerAuthority(baseParams)).rejects.toThrow(
      "could not decode SSH authority",
    );
    expect(mockStartRelayDaemon).not.toHaveBeenCalled();
  });

  it("throws when the connection token is missing", async () => {
    await expect(
      buildContainerAuthority({ ...baseParams, connectionToken: undefined }),
    ).rejects.toThrow("did not provide a connection token");
    expect(mockStartRelayDaemon).not.toHaveBeenCalled();
  });
});
