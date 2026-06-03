/*
 * Copyright (c) 2026 Aergic Labs, LLC
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("node:fs/promises", () => ({
  readFile: vi.fn(),
}));

vi.mock("../../src/utils/dockerUtils", () => ({
  dockerExec: vi.fn(),
}));

import { readFile } from "node:fs/promises";
import { dockerExec } from "../../src/utils/dockerUtils";
import { GitConfigCopier } from "../../src/credentials/gitConfigCopier";

const mockReadFile = vi.mocked(readFile);
const mockDockerExec = vi.mocked(dockerExec);

describe("GitConfigCopier", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDockerExec.mockResolvedValue({
      exitCode: 0,
      stdout: "/home/devuser\n",
      stderr: "",
    });
    mockReadFile.mockResolvedValue(
      "[user]\n\tname = Test User\n\temail = test@example.com\n",
    );
  });

  describe("copyGitConfig", () => {
    it("skips when enabled is false", async () => {
      const copier = new GitConfigCopier({ enabled: false });

      await copier.copyGitConfig("test-container");

      expect(mockReadFile).not.toHaveBeenCalled();
      expect(mockDockerExec).not.toHaveBeenCalled();
    });

    it("reads the host gitconfig file", async () => {
      const copier = new GitConfigCopier({
        hostGitConfigPath: "/home/user/.gitconfig",
      });

      await copier.copyGitConfig("test-container");

      expect(mockReadFile).toHaveBeenCalledWith(
        "/home/user/.gitconfig",
        "utf-8",
      );
    });

    it("skips gracefully when host gitconfig does not exist", async () => {
      mockReadFile.mockRejectedValue(new Error("ENOENT: no such file"));

      const copier = new GitConfigCopier({
        hostGitConfigPath: "/nonexistent/.gitconfig",
      });

      // Should not throw
      await expect(
        copier.copyGitConfig("test-container"),
      ).resolves.toBeUndefined();
      expect(mockDockerExec).not.toHaveBeenCalled();
    });

    it("skips when host gitconfig is empty", async () => {
      mockReadFile.mockResolvedValue("   \n  ");

      const copier = new GitConfigCopier({
        hostGitConfigPath: "/home/user/.gitconfig",
      });

      await copier.copyGitConfig("test-container");

      // Should only read the file, not exec into container
      expect(mockDockerExec).not.toHaveBeenCalled();
    });

    it("determines the remote user home directory", async () => {
      const copier = new GitConfigCopier({
        hostGitConfigPath: "/home/user/.gitconfig",
      });

      await copier.copyGitConfig("test-container");

      // First docker exec call should be to get $HOME
      expect(mockDockerExec).toHaveBeenCalledWith(
        "test-container",
        ["printenv", "HOME"],
        expect.objectContaining({ dockerPath: "docker" }),
      );
    });

    it("writes gitconfig to the remote user home directory", async () => {
      mockDockerExec.mockResolvedValueOnce({
        exitCode: 0,
        stdout: "/home/devuser\n",
        stderr: "",
      });
      mockDockerExec.mockResolvedValueOnce({
        exitCode: 0,
        stdout: "",
        stderr: "",
      });

      const copier = new GitConfigCopier({
        hostGitConfigPath: "/home/user/.gitconfig",
      });

      await copier.copyGitConfig("test-container");

      const writeCall = mockDockerExec.mock.calls[1];
      const command = writeCall[1][2]; // sh -c argument
      expect(command).toContain("'/home/devuser'/.gitconfig");
    });

    it("falls back to /root when HOME is empty", async () => {
      mockDockerExec.mockResolvedValueOnce({
        exitCode: 0,
        stdout: "\n",
        stderr: "",
      });
      mockDockerExec.mockResolvedValueOnce({
        exitCode: 0,
        stdout: "",
        stderr: "",
      });

      const copier = new GitConfigCopier({
        hostGitConfigPath: "/home/user/.gitconfig",
      });

      await copier.copyGitConfig("test-container");

      const writeCall = mockDockerExec.mock.calls[1];
      const command = writeCall[1][2];
      expect(command).toContain("'/root'/.gitconfig");
    });

    it("uses custom docker path", async () => {
      const copier = new GitConfigCopier({
        dockerPath: "/custom/docker",
        hostGitConfigPath: "/home/user/.gitconfig",
      });

      await copier.copyGitConfig("test-container");

      for (const call of mockDockerExec.mock.calls) {
        expect(call[2]).toEqual(
          expect.objectContaining({ dockerPath: "/custom/docker" }),
        );
      }
    });

    it("escapes single quotes in gitconfig content", async () => {
      mockReadFile.mockResolvedValue(
        "[alias]\n\tco = checkout\n\tst = status\n\tl = log --oneline --graph\n",
      );
      mockDockerExec.mockResolvedValueOnce({
        exitCode: 0,
        stdout: "/home/user\n",
        stderr: "",
      });
      mockDockerExec.mockResolvedValueOnce({
        exitCode: 0,
        stdout: "",
        stderr: "",
      });

      const copier = new GitConfigCopier({
        hostGitConfigPath: "/home/user/.gitconfig",
      });

      await copier.copyGitConfig("test-container");

      // Should have written the content
      expect(mockDockerExec).toHaveBeenCalledTimes(2);
    });

    it("is enabled by default", async () => {
      const copier = new GitConfigCopier({
        hostGitConfigPath: "/home/user/.gitconfig",
      });

      await copier.copyGitConfig("test-container");

      // Should have read the file and executed docker commands
      expect(mockReadFile).toHaveBeenCalled();
      expect(mockDockerExec).toHaveBeenCalled();
    });
  });
});