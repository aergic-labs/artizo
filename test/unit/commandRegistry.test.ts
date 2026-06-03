/*
 * Copyright (c) 2026 Aergic Labs, LLC
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, it, expect } from "vitest";
import { computeCommands } from "../../src/sidebar/commandRegistry";

describe("computeCommands", () => {
  describe("local, workspace, has config", () => {
    const commands = computeCommands(undefined, true, true);

    it("includes reopen, rebuild, open config commands", () => {
      const ids = commands.map((c) => c.id);
      expect(ids).toContain("artizo.reopenInContainer");
      expect(ids).toContain("artizo.configureDevContainer");
      expect(ids).toContain("artizo.openDevContainerFile");
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

    it("does not include remote-only commands", () => {
      const ids = commands.map((c) => c.id);
      expect(ids).not.toContain("artizo.reopenLocally");
      expect(ids).not.toContain("workbench.action.remote.close");
      expect(ids).not.toContain("artizo.addConfiguration");
    });

    it("always includes Show Log", () => {
      const ids = commands.map((c) => c.id);
      expect(ids).toContain("artizo.revealLogTerminal");
    });
  });

  describe("local, no workspace", () => {
    const commands = computeCommands(undefined, false, false);

    it("includes open folder and attach commands", () => {
      const ids = commands.map((c) => c.id);
      expect(ids).toContain("artizo.openFolderInContainer");
      expect(ids).toContain("artizo.attachToRunningContainer");
      expect(ids).toContain("artizo.cloneInVolume");
    });

    it("does not include workspace-required commands", () => {
      const ids = commands.map((c) => c.id);
      expect(ids).not.toContain("artizo.reopenInContainer");
      expect(ids).not.toContain("artizo.configureDevContainer");
    });
  });

  describe("local, workspace, no config", () => {
    const commands = computeCommands(undefined, true, false);

    it("includes add configuration command", () => {
      const ids = commands.map((c) => c.id);
      expect(ids).toContain("artizo.addConfiguration");
    });

    it("does not include config-required commands", () => {
      const ids = commands.map((c) => c.id);
      expect(ids).not.toContain("artizo.reopenInContainer");
      expect(ids).not.toContain("artizo.openDevContainerFile");
    });
  });

  describe("artizo-container remote", () => {
    const commands = computeCommands("artizo-container", true, true);

    it("includes remote-only commands", () => {
      const ids = commands.map((c) => c.id);
      expect(ids).toContain("artizo.reopenLocally");
      expect(ids).toContain("workbench.action.remote.close");
    });

    it("does not include local-only commands", () => {
      const ids = commands.map((c) => c.id);
      expect(ids).not.toContain("artizo.reopenInContainer");
      expect(ids).not.toContain("artizo.cloneInVolume");
      expect(ids).not.toContain("artizo.attachToRunningContainer");
    });
  });

  describe("attached-container remote", () => {
    const commands = computeCommands("attached-container", true, true);

    it("includes remote-only commands", () => {
      const ids = commands.map((c) => c.id);
      expect(ids).toContain("artizo.reopenLocally");
      expect(ids).toContain("workbench.action.remote.close");
    });
  });

  describe("non-artizo remote (ssh-remote)", () => {
    const commands = computeCommands("ssh-remote+hostname", true, true);

    it("does not include artizo remote commands", () => {
      const ids = commands.map((c) => c.id);
      expect(ids).not.toContain("artizo.reopenLocally");
      expect(ids).not.toContain("workbench.action.remote.close");
    });

    it("does not include local-only commands", () => {
      const ids = commands.map((c) => c.id);
      expect(ids).not.toContain("artizo.reopenInContainer");
      expect(ids).not.toContain("artizo.cloneInVolume");
    });
  });

  describe("Rebuild submenu does not duplicate rebuild entries", () => {
    it("does not list rebuild variants alongside the submenu", () => {
      const commands = computeCommands(undefined, true, true);
      const ids = commands.map((c) => c.id);
      // rebuildContainerNoCache should only appear inside children, not at top level
      expect(ids).not.toContain("artizo.rebuildContainerNoCache");
      expect(ids).not.toContain("artizo.rebuildAndReopenInContainer");
    });
  });
});