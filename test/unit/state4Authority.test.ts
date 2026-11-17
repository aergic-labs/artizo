/*
 * Copyright (c) 2026 Aergic Labs, LLC
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("vscode", () => ({
  workspace: {
    getConfiguration: vi.fn().mockReturnValue({ get: vi.fn() }),
  },
}));

const { mockStartRelayDaemon, mockDecodeSshAuthority } = vi.hoisted(() => ({
  mockStartRelayDaemon: vi.fn(),
  mockDecodeSshAuthority: vi.fn(),
}));

vi.mock("../../src/remote/containerProxy", async () => {
  const actual = await vi.importActual<
    typeof import("../../src/remote/containerProxy")
  >("../../src/remote/containerProxy");
  return {
    ...actual,
    decodeSshAuthority: mockDecodeSshAuthority,
    startRelayDaemon: mockStartRelayDaemon,
  };
});

import {
  buildContainerAuthority,
  startRelayForContainer,
} from "../../src/remote/state4Authority";
import { ExecutionTier } from "../../src/host/state";
import type { ExecServer } from "../../src/remote/execServerBridge";
import type { ProductInfo } from "../../src/remote/productInfo";
import type { StableWorkspaceIdentity } from "../../src/remote/containerProxy";
import type { WorkflowUI } from "../../src/workflows/types";

const SSH = { sshHost: "34.136.190.14", sshUser: "dev", sshPort: 22 };
const PRODUCT = {
  serverDataFolderName: ".kiro-server",
  commit: "abc123",
} as ProductInfo;

function makeUI(): WorkflowUI {
  return { showBuildLog: vi.fn() } as unknown as WorkflowUI;
}

function makeExecServer(home = "/home/dev"): ExecServer {
  return {
    tcpConnect: vi.fn(),
    env: async () => ({ env: { HOME: home }, osPlatform: "linux" }),
  } as unknown as ExecServer;
}

function decodePayload(authority: string): Record<string, unknown> {
  const outer = authority.split("@")[0];
  const hex = outer.substring(outer.indexOf("+") + 1);
  return JSON.parse(Buffer.from(hex, "hex").toString("utf-8"));
}

beforeEach(() => {
  mockStartRelayDaemon.mockReset();
  mockDecodeSshAuthority.mockReset();
  mockStartRelayDaemon.mockResolvedValue({
    port: 54321,
    metaFile: "/tmp/.artizo/relays/x.meta.json",
    pidFile: "/tmp/.artizo/relays/x.pid",
    pid: 4242,
  });
  mockDecodeSshAuthority.mockReturnValue(SSH);
});

describe("buildContainerAuthority — local tier", () => {
  it("emits a bare authority and never starts a relay", async () => {
    const authority = await buildContainerAuthority({
      scheme: "artizo-container",
      id: "/home/me/proj",
      tier: ExecutionTier.LocalHost,
      owner: "ui",
      remoteAuthority: undefined,
      containerId: "abc",
      containerPort: 1234,
      installPath: "/tmp/server",
      connectionToken: "t",
      workspaceFolder: "/home/me/proj",
      workspacePath: "/workspaces/proj",
      dockerPath: "docker",
      ui: makeUI(),
    });

    expect(authority).not.toContain("@");
    const hex = authority.substring(authority.indexOf("+") + 1);
    expect(Buffer.from(hex, "hex").toString("utf-8")).toBe("/home/me/proj");
    expect(mockStartRelayDaemon).not.toHaveBeenCalled();
  });
});

describe("buildContainerAuthority — devcontainer over SSH", () => {
  const base = {
    scheme: "artizo-container" as const,
    id: "/home/dev/proj",
    tier: ExecutionTier.RemoteSSH,
    owner: "ui" as const,
    remoteAuthority: "ssh-remote+abc123",
    workspaceFolder: "/home/dev/proj",
    workspacePath: "/workspaces/proj",
    dockerPath: "docker",
  };

  it("chains the parent authority and carries only stable fields", async () => {
    const authority = await buildContainerAuthority({
      ...base,
      containerId: "container123",
      containerPort: 38517,
      installPath: "/tmp/.kiro-server",
      connectionToken: "token",
      ui: makeUI(),
      execServer: makeExecServer(),
      productInfo: PRODUCT,
    });

    expect(authority.endsWith("@ssh-remote+abc123")).toBe(true);
    expect(decodePayload(authority)).toEqual({
      proxy: true,
      sshHost: SSH.sshHost,
      sshUser: SSH.sshUser,
      sshPort: SSH.sshPort,
      hostWorkspacePath: "/home/dev/proj",
      workspacePath: "/workspaces/proj",
    });
    expect(mockStartRelayDaemon).toHaveBeenCalledTimes(1);
  });

  it("throws when the SSH authority cannot be decoded", async () => {
    mockDecodeSshAuthority.mockReturnValue(undefined);

    await expect(
      buildContainerAuthority({
        ...base,
        containerId: "abc",
        containerPort: 1,
        installPath: "/tmp/server",
        connectionToken: undefined,
        ui: makeUI(),
        execServer: makeExecServer(),
        productInfo: PRODUCT,
      }),
    ).rejects.toThrow(/could not decode SSH authority/i);
  });

  it("throws when the relay must start but the ExecServer is missing", async () => {
    await expect(
      buildContainerAuthority({
        ...base,
        containerId: "abc",
        containerPort: 1,
        installPath: "/tmp/server",
        connectionToken: undefined,
        ui: makeUI(),
      }),
    ).rejects.toThrow(/requires an ExecServer/i);
  });

  it("throws when the relay must start without container details", async () => {
    await expect(
      buildContainerAuthority({
        ...base,
        connectionToken: undefined,
        ui: makeUI(),
        execServer: makeExecServer(),
        productInfo: PRODUCT,
      }),
    ).rejects.toThrow(/container's id, port and install path/i);
  });
});

describe("startRelayForContainer", () => {
  const identity: StableWorkspaceIdentity = {
    sshHost: SSH.sshHost,
    sshUser: SSH.sshUser,
    sshPort: SSH.sshPort,
    hostWorkspacePath: "/home/dev/proj",
    workspacePath: "/workspaces/proj",
  };

  it("derives the host node path and container node path", async () => {
    const port = await startRelayForContainer({
      execServer: makeExecServer("/home/dev"),
      productInfo: PRODUCT,
      identity,
      containerId: "container123",
      containerPort: 38517,
      installPath: "/tmp/.kiro-server",
      dockerPath: "docker",
      ui: makeUI(),
    });

    expect(port).toBe(54321);
    expect(mockStartRelayDaemon).toHaveBeenCalledWith({
      execServer: expect.anything(),
      hostNodePath: "/home/dev/.kiro-server/bin/abc123/node",
      logFile: "/home/dev/.artizo/logs/relay.log",
      containerId: "container123",
      containerPort: 38517,
      nodePath: "/tmp/.kiro-server/node",
      dockerPath: "docker",
      identity,
    });
  });

  it("throws when the ExecServer does not report HOME", async () => {
    await expect(
      startRelayForContainer({
        execServer: makeExecServer(""),
        productInfo: PRODUCT,
        identity,
        containerId: "container123",
        containerPort: 38517,
        installPath: "/tmp/.kiro-server",
        dockerPath: "docker",
        ui: makeUI(),
      }),
    ).rejects.toThrow(/did not report HOME/i);
  });
});