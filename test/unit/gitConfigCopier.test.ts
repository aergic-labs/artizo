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
import { GitConfigCopier } from "../../src/credentials/gitConfigCopier";

const mockReadFile = vi.mocked(readFile);

function createMockHost() {
  return {
    dockerExec: vi
      .fn()
      .mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" }),
    dockerPath: "docker",
  };
}

describe("GitConfigCopier", () => {
  let mockHost: ReturnType<typeof createMockHost>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockHost = createMockHost();
    mockHost.dockerExec.mockResolvedValue({
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
      const copier = new GitConfigCopier({
        enabled: false,
        host: mockHost as any,
      });

      await copier.copyGitConfig("test-container");

      expect(mockReadFile).not.toHaveBeenCalled();
      expect(mockHost.dockerExec).not.toHaveBeenCalled();
    });

    it("reads the host gitconfig file", async () => {
      const copier = new GitConfigCopier({
        hostGitConfigPath: "/home/user/.gitconfig",
        host: mockHost as any,
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
        host: mockHost as any,
      });

      // Should not throw
      await expect(
        copier.copyGitConfig("test-container"),
      ).resolves.toBeUndefined();
      expect(mockHost.dockerExec).not.toHaveBeenCalled();
    });

    it("skips when host gitconfig is empty", async () => {
      mockReadFile.mockResolvedValue("   \n  ");

      const copier = new GitConfigCopier({
        hostGitConfigPath: "/home/user/.gitconfig",
        host: mockHost as any,
      });

      await copier.copyGitConfig("test-container");

      // Should only read the file, not exec into container
      expect(mockHost.dockerExec).not.toHaveBeenCalled();
    });

    it("determines the remote user home directory", async () => {
      const copier = new GitConfigCopier({
        hostGitConfigPath: "/home/user/.gitconfig",
        host: mockHost as any,
      });

      await copier.copyGitConfig("test-container");

      // First docker exec call should be to get $HOME
      expect(mockHost.dockerExec).toHaveBeenCalledWith("test-container", [
        "printenv",
        "HOME",
      ]);
    });

    it("writes gitconfig to the remote user home directory", async () => {
      mockHost.dockerExec.mockResolvedValueOnce({
        exitCode: 0,
        stdout: "/home/devuser\n",
        stderr: "",
      });
      mockHost.dockerExec.mockResolvedValueOnce({
        exitCode: 0,
        stdout: "",
        stderr: "",
      });

      const copier = new GitConfigCopier({
        hostGitConfigPath: "/home/user/.gitconfig",
        host: mockHost as any,
      });

      await copier.copyGitConfig("test-container");

      const writeCall = mockHost.dockerExec.mock.calls[1];
      const command = writeCall[1][2]; // sh -c argument
      expect(command).toContain("'/home/devuser'/.gitconfig");
    });

    it("falls back to /root when HOME is empty", async () => {
      mockHost.dockerExec.mockResolvedValueOnce({
        exitCode: 0,
        stdout: "\n",
        stderr: "",
      });
      mockHost.dockerExec.mockResolvedValueOnce({
        exitCode: 0,
        stdout: "",
        stderr: "",
      });

      const copier = new GitConfigCopier({
        hostGitConfigPath: "/home/user/.gitconfig",
        host: mockHost as any,
      });

      await copier.copyGitConfig("test-container");

      const writeCall = mockHost.dockerExec.mock.calls[1];
      const command = writeCall[1][2];
      expect(command).toContain("'/root'/.gitconfig");
    });

    it("routes dockerExec through the host", async () => {
      const copier = new GitConfigCopier({
        hostGitConfigPath: "/home/user/.gitconfig",
        host: mockHost as any,
      });

      await copier.copyGitConfig("test-container");

      for (const call of mockHost.dockerExec.mock.calls) {
        expect(call[0]).toBe("test-container");
      }
    });

    it("escapes single quotes in gitconfig content", async () => {
      mockReadFile.mockResolvedValue(
        "[alias]\n\tco = checkout\n\tst = status\n\tl = log --oneline --graph\n",
      );
      mockHost.dockerExec.mockResolvedValueOnce({
        exitCode: 0,
        stdout: "/home/user\n",
        stderr: "",
      });
      mockHost.dockerExec.mockResolvedValueOnce({
        exitCode: 0,
        stdout: "",
        stderr: "",
      });

      const copier = new GitConfigCopier({
        hostGitConfigPath: "/home/user/.gitconfig",
        host: mockHost as any,
      });

      await copier.copyGitConfig("test-container");

      // Should have written the content
      expect(mockHost.dockerExec).toHaveBeenCalledTimes(2);
    });

    it("is enabled by default", async () => {
      const copier = new GitConfigCopier({
        hostGitConfigPath: "/home/user/.gitconfig",
        host: mockHost as any,
      });

      await copier.copyGitConfig("test-container");

      // Should have read the file and executed docker commands
      expect(mockReadFile).toHaveBeenCalled();
      expect(mockHost.dockerExec).toHaveBeenCalled();
    });
  });
});
