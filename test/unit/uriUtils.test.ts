/*
 * Copyright (c) 2026 Aergic Labs, LLC
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, it, expect, vi, afterEach } from "vitest";

vi.mock("vscode", () => ({
  window: {
    createTerminal: vi
      .fn()
      .mockReturnValue({ show: vi.fn(), dispose: vi.fn() }),
    withProgress: vi.fn(),
  },
  commands: { executeCommand: vi.fn() },
  EventEmitter: vi.fn().mockImplementation(() => ({
    event: vi.fn(),
    fire: vi.fn(),
    dispose: vi.fn(),
  })),
  ProgressLocation: { Notification: 15 },
  env: { remoteAuthority: undefined as string | undefined },
  Uri: { parse: (s: string) => ({ toString: () => s }) },
  workspace: {
    workspaceFolders: [{ uri: { fsPath: "/test/workspace", authority: "" } }],
  },
}));

import * as vscode from "vscode";
import {
  encodeAuthority,
  decodeAuthority,
  encodeChainedAuthority,
  buildRemoteAuthority,
  getHostWorkspaceFolder,
} from "../../src/utils/uriUtils";

describe("uriUtils", () => {
  describe("encodeAuthority", () => {
    it("encodes a simple string", () => {
      const result = encodeAuthority("dev-container", "hello");
      expect(result).toBe("dev-container+68656c6c6f");
    });

    it("encodes a path with slashes", () => {
      const result = encodeAuthority("dev-container", "/home/user/project");
      expect(result).toMatch(/^dev-container\+[0-9a-f]+$/);
    });
  });

  describe("decodeAuthority", () => {
    it("decodes a valid authority", () => {
      const result = decodeAuthority("dev-container+68656c6c6f");
      expect(result).toEqual({ scheme: "dev-container", id: "hello" });
    });

    it("throws on missing separator", () => {
      expect(() => decodeAuthority("devcontainer68656c6c6f")).toThrow(
        "missing '+' separator",
      );
    });

    it("throws on empty identifier", () => {
      expect(() => decodeAuthority("dev-container+")).toThrow(
        "empty identifier",
      );
    });

    it("throws on non-hex characters", () => {
      expect(() => decodeAuthority("dev-container+xyz123")).toThrow(
        "non-hex characters",
      );
    });

    it("throws on odd-length hex", () => {
      expect(() => decodeAuthority("dev-container+abc")).toThrow(
        "odd-length hex",
      );
    });

    it("strips a chained @ssh-remote parent and decodes the outer segment", () => {
      const outer = encodeAuthority("artizo-container", "/host/path");
      const chained = `${outer}@ssh-remote+7b2268`;
      expect(decodeAuthority(chained)).toEqual({
        scheme: "artizo-container",
        id: "/host/path",
      });
    });
  });

  describe("encodeChainedAuthority", () => {
    it("produces scheme+hex@parentAuthority", () => {
      const result = encodeChainedAuthority(
        "artizo-container",
        "/host/path",
        "ssh-remote+7b2268",
      );
      const outer = encodeAuthority("artizo-container", "/host/path");
      expect(result).toBe(`${outer}@ssh-remote+7b2268`);
    });
  });

  describe("buildRemoteAuthority", () => {
    afterEach(() => {
      (vscode.env as { remoteAuthority?: string }).remoteAuthority = undefined;
    });

    it("returns a bare authority on LocalHost (no remoteAuthority)", () => {
      (vscode.env as { remoteAuthority?: string }).remoteAuthority = undefined;
      expect(buildRemoteAuthority("artizo-container", "/host/path")).toBe(
        encodeAuthority("artizo-container", "/host/path"),
      );
    });

    it("returns a bare authority even when remoteAuthority is an SSH remote", () => {
      // Chaining (`@ssh-remote+<hex>`) is intentionally disabled: VS Code
      // core calls `resolveExecServer` on the vendor SSH resolver for
      // non-last authorities, and third-party SSH extensions don't
      // implement it, so the chain throws before our resolver runs.
      // See `buildRemoteAuthority` doc comment for the full rationale.
      (vscode.env as { remoteAuthority?: string }).remoteAuthority =
        "ssh-remote+7b22686f7374";
      expect(buildRemoteAuthority("artizo-container", "/host/path")).toBe(
        encodeAuthority("artizo-container", "/host/path"),
      );
    });

    it("returns a bare authority for non-SSH remotes (e.g. wsl)", () => {
      (vscode.env as { remoteAuthority?: string }).remoteAuthority =
        "wsl+ubuntu";
      expect(buildRemoteAuthority("artizo-container", "/host/path")).toBe(
        encodeAuthority("artizo-container", "/host/path"),
      );
    });
  });

  describe("getHostWorkspaceFolder", () => {
    it("returns undefined when no workspace folders", () => {
      (vscode.workspace as any).workspaceFolders = undefined;
      expect(getHostWorkspaceFolder()).toBeUndefined();
      (vscode.workspace as any).workspaceFolders = [];
      expect(getHostWorkspaceFolder()).toBeUndefined();
    });

    it("returns fsPath when authority is empty (host)", () => {
      (vscode.workspace as any).workspaceFolders = [
        { uri: { fsPath: "/home/user/project", authority: "" } },
      ];
      expect(getHostWorkspaceFolder()).toBe("/home/user/project");
    });

    it("returns fsPath for foreign authority (ssh-remote)", () => {
      (vscode.workspace as any).workspaceFolders = [
        { uri: { fsPath: "/remote/path", authority: "ssh-remote+host" } },
      ];
      expect(getHostWorkspaceFolder()).toBe("/remote/path");
    });

    it("decodes authority for artizo-container", () => {
      const encoded = encodeAuthority("artizo-container", "/host/path");
      (vscode.workspace as any).workspaceFolders = [
        { uri: { fsPath: "/container/path", authority: encoded } },
      ];
      expect(getHostWorkspaceFolder()).toBe("/host/path");
    });

    it("decodes authority for attached-container", () => {
      const encoded = encodeAuthority("attached-container", "/another/host");
      (vscode.workspace as any).workspaceFolders = [
        { uri: { fsPath: "/container/path", authority: encoded } },
      ];
      expect(getHostWorkspaceFolder()).toBe("/another/host");
    });
  });
});
