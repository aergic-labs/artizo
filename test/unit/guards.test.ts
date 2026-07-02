/*
 * Copyright (c) 2026 Aergic Labs, LLC
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockExecFilePromise } = vi.hoisted(() => ({
  mockExecFilePromise: vi.fn(),
}));

vi.mock("vscode", () => ({
  env: { remoteName: undefined },
  ExtensionKind: { UI: 1, Workspace: 2 },
}));

vi.mock("../../src/utils/uriUtils", () => ({
  getHostWorkspaceFolder: vi.fn(),
}));

vi.mock("../../src/utils/dockerUtils.js", () => ({
  execFilePromise: mockExecFilePromise,
}));

import * as vscode from "vscode";
import { getHostWorkspaceFolder as uriUtilsGetWs } from "../../src/utils/uriUtils";
import {
  guardHostContext,
  checkDockerAvailable,
  getHostWorkspaceFolder,
} from "../../src/host/guards";

describe("guards", () => {
  describe("guardHostContext", () => {
    it("does not throw when not in a managed container (host)", () => {
      (vscode.env as any).remoteName = undefined;
      expect(() => guardHostContext()).not.toThrow();
    });

    it("does not throw when in a foreign remote (ssh-remote)", () => {
      (vscode.env as any).remoteName = "ssh-remote+host";
      expect(() => guardHostContext()).not.toThrow();
    });

    it("throws when in a managed container (artizo-container)", () => {
      (vscode.env as any).remoteName = "artizo-container";
      expect(() => guardHostContext()).toThrow(
        /Dev container commands must run from a host window/,
      );
    });

    it("throws when in a managed container (attached-container)", () => {
      (vscode.env as any).remoteName = "attached-container";
      expect(() => guardHostContext()).toThrow(
        /Dev container commands must run from a host window/,
      );
    });
  });

  describe("checkDockerAvailable", () => {
    beforeEach(() => {
      mockExecFilePromise.mockReset();
    });

    it("resolves when docker version exits 0", async () => {
      mockExecFilePromise.mockResolvedValue({
        exitCode: 0,
        stdout: "Docker version 24.0.0",
        stderr: "",
      });
      await expect(checkDockerAvailable("docker")).resolves.toBeUndefined();
      expect(mockExecFilePromise).toHaveBeenCalledWith("docker", ["version"]);
    });

    it("throws when docker version has non-zero exit code", async () => {
      mockExecFilePromise.mockResolvedValue({
        exitCode: 1,
        stdout: "",
        stderr: "docker not found",
      });
      await expect(checkDockerAvailable("docker")).rejects.toThrow(
        /Docker is not available/,
      );
    });

    it("throws when docker version promise rejects", async () => {
      mockExecFilePromise.mockRejectedValue(new Error("ENOENT"));
      await expect(checkDockerAvailable("/custom/docker")).rejects.toThrow(
        "ENOENT",
      );
    });

    it("passes the custom docker path", async () => {
      mockExecFilePromise.mockResolvedValue({
        exitCode: 0,
        stdout: "",
        stderr: "",
      });
      await checkDockerAvailable("/usr/local/bin/docker");
      expect(mockExecFilePromise).toHaveBeenCalledWith(
        "/usr/local/bin/docker",
        ["version"],
      );
    });
  });

  describe("getHostWorkspaceFolder", () => {
    it("returns the workspace folder from uriUtils", () => {
      vi.mocked(uriUtilsGetWs).mockReturnValue("/my/project");
      expect(getHostWorkspaceFolder()).toBe("/my/project");
    });

    it("returns undefined when no workspace", () => {
      vi.mocked(uriUtilsGetWs).mockReturnValue(undefined);
      expect(getHostWorkspaceFolder()).toBeUndefined();
    });
  });
});
