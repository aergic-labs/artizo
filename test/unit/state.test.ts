/*
 * Copyright (c) 2026 Aergic Labs, LLC
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("vscode", () => ({
  env: {
    remoteName: undefined as string | undefined,
    remoteAuthority: undefined as string | undefined,
  },
  ExtensionKind: { UI: 1, Workspace: 2 },
  window: {
    createOutputChannel: vi.fn(() => ({
      appendLine: vi.fn(),
      show: vi.fn(),
      dispose: vi.fn(),
    })),
  },
}));

import * as vscode from "vscode";
import {
  detectTier,
  isDevContainerTier,
  ExecutionTier,
} from "../../src/host/state";

const WS = vscode.ExtensionKind.Workspace;
const UI = vscode.ExtensionKind.UI;

/** Build a bare `<scheme>+<hex>` authority from an id string. */
function authority(scheme: string, id: string): string {
  return `${scheme}+${Buffer.from(id, "utf-8").toString("hex")}`;
}

beforeEach(() => {
  (vscode.env as any).remoteName = undefined;
  (vscode.env as any).remoteAuthority = undefined;
});

describe("detectTier", () => {
  it("reports LocalHost (workspace-side) when there is no remote", () => {
    const t = detectTier(WS);
    expect(t.tier).toBe(ExecutionTier.LocalHost);
    expect(t.owner).toBe("workspace");
    expect(t.parentRemote).toBeUndefined();
  });

  it("reports ui owner for LocalHost UI-side", () => {
    expect(detectTier(UI).owner).toBe("ui");
  });

  it("reports RemoteSSH (workspace owner) on an ssh-remote", () => {
    (vscode.env as any).remoteName = "ssh-remote";
    const t = detectTier(WS);
    expect(t.tier).toBe(ExecutionTier.RemoteSSH);
    expect(t.owner).toBe("workspace");
  });

  it("reports UnknownRemote (none) for unsupported remotes", () => {
    (vscode.env as any).remoteName = "wsl";
    const t = detectTier(WS);
    expect(t.tier).toBe(ExecutionTier.UnknownRemote);
    expect(t.owner).toBe("none");
  });

  it("reports LocalDevContainer for a host-path devcontainer authority", () => {
    (vscode.env as any).remoteName = "artizo-container";
    (vscode.env as any).remoteAuthority = authority(
      "artizo-container",
      "/home/me/project",
    );
    const t = detectTier(UI);
    expect(t.tier).toBe(ExecutionTier.LocalDevContainer);
    expect(t.parentRemote).toBe("host");
    expect(t.owner).toBe("ui");
  });

  it("reports LocalDevContainer for an attached container id", () => {
    (vscode.env as any).remoteName = "attached-container";
    (vscode.env as any).remoteAuthority = authority(
      "attached-container",
      "a".repeat(64),
    );
    const t = detectTier(UI);
    expect(t.tier).toBe(ExecutionTier.LocalDevContainer);
    expect(t.parentRemote).toBe("host");
  });

  it("reports RemoteSSHDevContainer when the authority carries a proxy payload", () => {
    const payload = JSON.stringify({
      proxy: true,
      sshHost: "1.2.3.4",
      relayPort: 9999,
    });
    (vscode.env as any).remoteName = "artizo-container";
    (vscode.env as any).remoteAuthority = authority("artizo-container", payload);
    const t = detectTier(UI);
    expect(t.tier).toBe(ExecutionTier.RemoteSSHDevContainer);
    expect(t.parentRemote).toBe("ssh-remote");
  });

  it("detects a proxy payload on the attached-container scheme too", () => {
    const payload = JSON.stringify({ proxy: true, sshHost: "1.2.3.4" });
    (vscode.env as any).remoteName = "attached-container";
    (vscode.env as any).remoteAuthority = authority(
      "attached-container",
      payload,
    );
    expect(detectTier(UI).tier).toBe(ExecutionTier.RemoteSSHDevContainer);
  });

  it("treats a malformed authority as a local devcontainer", () => {
    (vscode.env as any).remoteName = "artizo-container";
    (vscode.env as any).remoteAuthority = "artizo-container+zzzz";
    const t = detectTier(UI);
    expect(t.tier).toBe(ExecutionTier.LocalDevContainer);
    expect(t.parentRemote).toBe("host");
  });

  it("treats a non-proxy JSON payload as a local devcontainer", () => {
    const payload = JSON.stringify({ something: "else" });
    (vscode.env as any).remoteName = "artizo-container";
    (vscode.env as any).remoteAuthority = authority("artizo-container", payload);
    expect(detectTier(UI).tier).toBe(ExecutionTier.LocalDevContainer);
  });
});

describe("isDevContainerTier", () => {
  it("is true for both devcontainer tiers", () => {
    expect(isDevContainerTier(ExecutionTier.LocalDevContainer)).toBe(true);
    expect(isDevContainerTier(ExecutionTier.RemoteSSHDevContainer)).toBe(true);
  });

  it("is false for non-devcontainer tiers", () => {
    expect(isDevContainerTier(ExecutionTier.LocalHost)).toBe(false);
    expect(isDevContainerTier(ExecutionTier.RemoteSSH)).toBe(false);
    expect(isDevContainerTier(ExecutionTier.UnknownRemote)).toBe(false);
  });
});
