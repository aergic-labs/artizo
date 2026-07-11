/*
 * Copyright (c) 2026 Aergic Labs, LLC
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, it, expect, vi } from "vitest";
import * as vscode from "vscode";

vi.mock("../../src/host/state", () => ({
  isInDevContainerWindow: vi.fn(),
  isAttachedContainerWindow: vi.fn(),
  getTier: vi.fn(),
  ExecutionTier: {
    LocalHost: "LocalHost",
    LocalDevContainer: "LocalDevContainer",
    RemoteSSH: "RemoteSSH",
    RemoteSSHDevContainer: "RemoteSSHDevContainer",
    UnknownRemote: "UnknownRemote",
  },
}));

import {
  isInDevContainerWindow,
  isAttachedContainerWindow,
  getTier,
  ExecutionTier,
} from "../../src/host/state";
import { computeCommands } from "../../src/sidebar/commandRegistry";

function setEnvKind(kind: "host" | "managed" | "foreign"): void {
  // host and foreign both mean "not in devcontainer" under the new model
  vi.mocked(isInDevContainerWindow).mockReturnValue(kind === "managed");
  vi.mocked(isAttachedContainerWindow).mockReturnValue(false);
  vi.mocked(getTier).mockReturnValue({
    tier:
      kind === "managed"
        ? ExecutionTier.LocalDevContainer
        : ExecutionTier.LocalHost,
    owner: "workspace",
    remoteName: undefined,
    remoteAuthority: undefined,
    extensionKind: undefined,
    parentRemote: undefined,
  });
}

describe("computeCommands", () => {
  describe("host, workspace, has config", () => {
    setEnvKind("host");
    const commands = computeCommands(true, true);

    it("includes reopen and rebuild commands", () => {
      const ids = commands.map((c) => c.id);
      expect(ids).toContain("artizo.reopenInContainer");
      expect(ids).toContain("artizo.openFolderInContainer");
    });

    it("groups rebuild variants into a submenu", () => {
      const rebuild = commands.find((c) => c.label === "Rebuild Container");
      expect(rebuild).toBeDefined();
      expect(rebuild!.children).toBeDefined();
      const childIds = rebuild!.children!.map((c) => c.id);
      expect(childIds).toContain("artizo.rebuildContainer");
      expect(childIds).toContain("artizo.rebuildContainerNoCache");
      expect(childIds).toContain("artizo.rebuildAndReopenInContainer");
    });

    it("does not include managed-only or removed commands", () => {
      const ids = commands.map((c) => c.id);
      expect(ids).not.toContain("artizo.reopenInHost");
      expect(ids).not.toContain("artizo.closeRemoteConnection");
      expect(ids).not.toContain("artizo.addConfiguration");
      expect(ids).not.toContain("artizo.configureDevContainer");
      expect(ids).not.toContain("artizo.openDevContainerFile");
    });

    it("always includes Show Log", () => {
      const ids = commands.map((c) => c.id);
      expect(ids).toContain("artizo.revealOutputLog");
    });
  });

  describe("host, no workspace", () => {
    setEnvKind("host");
    const commands = computeCommands(false, false);

    it("includes open folder command", () => {
      const ids = commands.map((c) => c.id);
      expect(ids).toContain("artizo.openFolderInContainer");
    });
  });

  describe("host, workspace, no config", () => {
    setEnvKind("host");
    const commands = computeCommands(true, false);

    it("does not include config-required commands", () => {
      const ids = commands.map((c) => c.id);
      expect(ids).not.toContain("artizo.reopenInContainer");
    });

    it("labels open-folder as 'different' when workspace is open", () => {
      const cmd = commands.find((c) => c.id === "artizo.openFolderInContainer");
      expect(cmd).toBeDefined();
      expect(cmd!.label).toBe("Open Different Folder in Container");
    });
  });

  describe("managed (artizo-container)", () => {
    setEnvKind("managed");
    const commands = computeCommands(true, true);

    it("includes managed-only commands", () => {
      const ids = commands.map((c) => c.id);
      expect(ids).toContain("artizo.reopenInHost");
    });

    it("does not include host-only commands", () => {
      const ids = commands.map((c) => c.id);
      expect(ids).not.toContain("artizo.reopenInContainer");
      expect(ids).not.toContain("artizo.cloneInVolume");
      expect(ids).not.toContain("artizo.openFolderInContainer");
    });
  });

  describe("managed (attached-container)", () => {
    setEnvKind("managed");
    vi.mocked(isAttachedContainerWindow).mockReturnValue(true);
    const commands = computeCommands(true, true);

    it("does not include Return to Host (no host path for attached)", () => {
      const ids = commands.map((c) => c.id);
      expect(ids).not.toContain("artizo.reopenInHost");
    });
  });

  describe("foreign (ssh-remote)", () => {
    setEnvKind("foreign");
    vi.mocked(getTier).mockReturnValue({
      tier: ExecutionTier.RemoteSSH,
      owner: "workspace",
      remoteName: "ssh-remote",
      remoteAuthority: "ssh-remote+test",
      extensionKind: undefined,
      parentRemote: undefined,
    });
    const commands = computeCommands(true, true);

    it("includes Return to Host (SSH host case)", () => {
      const ids = commands.map((c) => c.id);
      expect(ids).toContain("artizo.reopenInHost");
    });

    it("does not include closeRemoteConnection (removed)", () => {
      const ids = commands.map((c) => c.id);
      expect(ids).not.toContain("artizo.closeRemoteConnection");
    });

    it("includes host commands (foreign acts like host)", () => {
      const ids = commands.map((c) => c.id);
      expect(ids).toContain("artizo.reopenInContainer");
    });
  });

  describe("Rebuild submenu does not duplicate rebuild entries", () => {
    it("does not list rebuild variants alongside the submenu", () => {
      setEnvKind("host");
      const commands = computeCommands(true, true);
      const ids = commands.map((c) => c.id);
      // rebuildContainerNoCache should only appear inside children, not at top level
      expect(ids).not.toContain("artizo.rebuildContainerNoCache");
      expect(ids).not.toContain("artizo.rebuildAndReopenInContainer");
    });
  });
});
