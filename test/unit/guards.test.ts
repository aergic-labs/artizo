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
}));

vi.mock("../../src/utils/uriUtils", () => ({
  getLocalWorkspaceFolder: vi.fn(),
}));

vi.mock("../../src/utils/dockerUtils.js", () => ({
  execFilePromise: mockExecFilePromise,
}));

import * as vscode from "vscode";
import { getLocalWorkspaceFolder as uriUtilsGetWs } from "../../src/utils/uriUtils";
import {
  guardLocalContext,
  checkDockerAvailable,
  getLocalWorkspaceFolder,
} from "../../src/host/guards";

describe("guards", () => {
  describe("guardLocalContext", () => {
    it("does not throw when not in a remote", () => {
      (vscode.env as any).remoteName = undefined;
      expect(() => guardLocalContext()).not.toThrow();
    });

    it("throws when in a remote context", () => {
      (vscode.env as any).remoteName = "artizo-container";
      expect(() => guardLocalContext()).toThrow(
        /Dev container commands must run from a local window/,
      );
    });

    it("includes the remote name in the error message", () => {
      (vscode.env as any).remoteName = "attached-container";
      expect(() => guardLocalContext()).toThrow(/attached-container/);
    });

    it("throws for any non-empty remote name", () => {
      (vscode.env as any).remoteName = "ssh-remote+host";
      expect(() => guardLocalContext()).toThrow(/ssh-remote\+host/);
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

  describe("getLocalWorkspaceFolder", () => {
    it("returns the workspace folder from uriUtils", () => {
      vi.mocked(uriUtilsGetWs).mockReturnValue("/my/project");
      expect(getLocalWorkspaceFolder()).toBe("/my/project");
    });

    it("returns undefined when no workspace", () => {
      vi.mocked(uriUtilsGetWs).mockReturnValue(undefined);
      expect(getLocalWorkspaceFolder()).toBeUndefined();
    });
  });
});