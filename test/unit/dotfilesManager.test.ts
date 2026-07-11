/*
 * Copyright (c) 2026 Aergic Labs, LLC
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  DotfilesManager,
  isSafeRepoUrl,
} from "../../src/dotfiles/dotfilesManager";
import type { DotfilesConfig } from "../../src/dotfiles/dotfilesManager";

vi.mock("../../src/utils/dockerUtils", () => ({
  dockerExec: vi.fn(),
}));

function createMockHost() {
  return {
    dockerExec: vi
      .fn()
      .mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" }),
    dockerPath: "docker",
  };
}

let mockHost = createMockHost();

describe("DotfilesManager", () => {
  let manager: DotfilesManager;

  beforeEach(() => {
    vi.clearAllMocks();
    mockHost = createMockHost();
    manager = new DotfilesManager({ host: mockHost as any });
  });

  describe("constructor", () => {
    it("routes dockerExec through the host", async () => {
      const customHost = createMockHost();
      const defaultManager = new DotfilesManager({ host: customHost as any });
      customHost.dockerExec.mockResolvedValue({
        exitCode: 0,
        stdout: "",
        stderr: "",
      });

      await defaultManager.install("container-1", {
        repository: "https://github.com/user/dotfiles.git",
      });

      expect(customHost.dockerExec).toHaveBeenCalledWith(
        "container-1",
        expect.any(Array),
      );
    });
  });

  describe("install", () => {
    it("returns success without cloning when repository is empty", async () => {
      const config: DotfilesConfig = { repository: "" };
      const result = await manager.install("container-123", config);

      expect(result.success).toBe(true);
      expect(result.cloned).toBe(false);
      expect(result.installed).toBe(false);
      expect(mockHost.dockerExec).not.toHaveBeenCalled();
    });

    it("clones repository to default target path", async () => {
      mockHost.dockerExec.mockResolvedValue({
        exitCode: 0,
        stdout: "",
        stderr: "",
      });

      const config: DotfilesConfig = {
        repository: "https://github.com/user/dotfiles.git",
      };
      const result = await manager.install("container-123", config);

      expect(result.success).toBe(true);
      expect(result.cloned).toBe(true);

      // Verify clone uses ~/dotfiles as default target
      expect(mockHost.dockerExec).toHaveBeenCalledWith("container-123", [
        "rm",
        "-rf",
        "--",
        "~/dotfiles",
      ]);
    });

    it("clones repository to custom target path", async () => {
      mockHost.dockerExec.mockResolvedValue({
        exitCode: 0,
        stdout: "",
        stderr: "",
      });

      const config: DotfilesConfig = {
        repository: "https://github.com/user/dotfiles.git",
        targetPath: "~/.dotfiles",
      };
      await manager.install("container-123", config);

      expect(mockHost.dockerExec).toHaveBeenCalledWith("container-123", [
        "rm",
        "-rf",
        "--",
        "~/.dotfiles",
      ]);
    });

    it("runs install command after cloning", async () => {
      mockHost.dockerExec.mockResolvedValue({
        exitCode: 0,
        stdout: "",
        stderr: "",
      });

      const config: DotfilesConfig = {
        repository: "https://github.com/user/dotfiles.git",
        installCommand: "./install.sh",
      };
      const result = await manager.install("container-123", config);

      expect(result.success).toBe(true);
      expect(result.cloned).toBe(true);
      expect(result.installed).toBe(true);

      // Verify install command was called with workdir
      expect(mockHost.dockerExec).toHaveBeenCalledWith(
        "container-123",
        ["sh", "-c", "./install.sh"],
        expect.objectContaining({ workdir: "~/dotfiles" }),
      );
    });

    it("performs shallow clone with depth 1 and removes existing target", async () => {
      mockHost.dockerExec.mockResolvedValue({
        exitCode: 0,
        stdout: "",
        stderr: "",
      });

      const config: DotfilesConfig = {
        repository: "https://github.com/user/dotfiles.git",
        targetPath: "/home/user/dots",
      };
      await manager.install("container-123", config);

      // First call: rm -rf -- <target>
      expect(mockHost.dockerExec).toHaveBeenNthCalledWith(1, "container-123", [
        "rm",
        "-rf",
        "--",
        "/home/user/dots",
      ]);
      // Second call: git clone with --depth 1 and -- guard
      expect(mockHost.dockerExec).toHaveBeenNthCalledWith(2, "container-123", [
        "git",
        "clone",
        "--depth",
        "1",
        "--",
        "https://github.com/user/dotfiles.git",
        "/home/user/dots",
      ]);
    });

    it("runs install command in the target directory", async () => {
      mockHost.dockerExec.mockResolvedValue({
        exitCode: 0,
        stdout: "",
        stderr: "",
      });

      const config: DotfilesConfig = {
        repository: "https://github.com/user/dotfiles.git",
        installCommand: "make install",
        targetPath: "/opt/dotfiles",
      };
      await manager.install("container-123", config);

      // Third call is the install command with workdir (rm=0, clone=1, install=2)
      const installCall = mockHost.dockerExec.mock.calls[2];
      expect(installCall[1]).toEqual(["sh", "-c", "make install"]);
      expect(installCall[2]).toMatchObject({ workdir: "/opt/dotfiles" });
    });

    it("returns error when clone fails", async () => {
      mockHost.dockerExec.mockResolvedValue({
        exitCode: 128,
        stdout: "",
        stderr: "fatal: repository not found",
      });

      const config: DotfilesConfig = {
        repository: "https://github.com/user/nonexistent.git",
      };
      const result = await manager.install("container-123", config);

      expect(result.success).toBe(false);
      expect(result.cloned).toBe(false);
      expect(result.error).toContain("Failed to clone dotfiles repository");
    });

    it("returns error when install command fails", async () => {
      let callCount = 0;
      mockHost.dockerExec.mockImplementation(async () => {
        callCount++;
        if (callCount <= 2) {
          // rm + clone both succeed
          return { exitCode: 0, stdout: "", stderr: "" };
        }
        // Install fails
        return { exitCode: 1, stdout: "", stderr: "Permission denied" };
      });

      const config: DotfilesConfig = {
        repository: "https://github.com/user/dotfiles.git",
        installCommand: "./install.sh",
      };
      const result = await manager.install("container-123", config);

      expect(result.success).toBe(false);
      expect(result.cloned).toBe(true);
      expect(result.installed).toBe(false);
      expect(result.error).toContain("Dotfiles install command failed");
    });

    it("tries default install scripts when no install command is configured", async () => {
      let callCount = 0;
      mockHost.dockerExec.mockImplementation(
        async (_containerId: string, cmd: string[]) => {
          callCount++;
          if (callCount <= 2) {
            // rm + clone both succeed
            return { exitCode: 0, stdout: "", stderr: "" };
          }
          // Check for install.sh; found and executable (two calls: test -f, test -x)
          const cmdStr = Array.isArray(cmd) ? cmd.join(" ") : "";
          if (cmdStr.includes("install.sh")) {
            return { exitCode: 0, stdout: "", stderr: "" };
          }
          if (cmdStr.includes("./install.sh")) {
            return { exitCode: 0, stdout: "", stderr: "" };
          }
          return { exitCode: 1, stdout: "", stderr: "" };
        },
      );

      const config: DotfilesConfig = {
        repository: "https://github.com/user/dotfiles.git",
      };
      const result = await manager.install("container-123", config);

      expect(result.success).toBe(true);
      expect(result.cloned).toBe(true);
      expect(result.installed).toBe(true);
    });

    it("skips non-executable scripts", async () => {
      let callCount = 0;
      mockHost.dockerExec.mockImplementation(
        async (_containerId: string, cmd: string[]) => {
          callCount++;
          if (callCount <= 2) {
            // rm + clone both succeed
            return { exitCode: 0, stdout: "", stderr: "" };
          }
          const cmdStr = Array.isArray(cmd) ? cmd.join(" ") : "";
          // install.sh exists but is NOT executable
          if (cmdStr.includes("test -f") && cmdStr.includes("install.sh")) {
            return { exitCode: 0, stdout: "", stderr: "" };
          }
          if (cmdStr.includes("test -x") && cmdStr.includes("install.sh")) {
            return { exitCode: 1, stdout: "", stderr: "" };
          }
          // All other scripts don't exist
          return { exitCode: 1, stdout: "", stderr: "" };
        },
      );

      const config: DotfilesConfig = {
        repository: "https://github.com/user/dotfiles.git",
      };
      const result = await manager.install("container-123", config);

      expect(result.success).toBe(true);
      expect(result.cloned).toBe(true);
      expect(result.installed).toBe(false);
    });

    it("handles no default install scripts found gracefully", async () => {
      let callCount = 0;
      mockHost.dockerExec.mockImplementation(async () => {
        callCount++;
        if (callCount <= 2) {
          // rm + clone both succeed
          return { exitCode: 0, stdout: "", stderr: "" };
        }
        // All script checks fail
        return { exitCode: 1, stdout: "", stderr: "" };
      });

      const config: DotfilesConfig = {
        repository: "https://github.com/user/dotfiles.git",
      };
      const result = await manager.install("container-123", config);

      expect(result.success).toBe(true);
      expect(result.cloned).toBe(true);
      expect(result.installed).toBe(false);
    });

    it("does not throw on clone failure; returns error info instead", async () => {
      mockHost.dockerExec.mockResolvedValue({
        exitCode: 1,
        stdout: "",
        stderr: "network timeout",
      });

      const config: DotfilesConfig = {
        repository: "https://github.com/user/dotfiles.git",
      };

      // Should not throw
      const result = await manager.install("container-123", config);
      expect(result.success).toBe(false);
      expect(result.error).toContain("network timeout");
    });

    it("includes stderr in error message on clone failure", async () => {
      mockHost.dockerExec.mockResolvedValue({
        exitCode: 128,
        stdout: "",
        stderr: "fatal: could not read from remote repository",
      });

      const config: DotfilesConfig = {
        repository: "git@github.com:user/private-dotfiles.git",
      };
      const result = await manager.install("container-123", config);

      expect(result.error).toContain(
        "fatal: could not read from remote repository",
      );
    });
  });
});

describe("isSafeRepoUrl", () => {
  it("accepts normal https/ssh/git URLs", () => {
    expect(isSafeRepoUrl("https://github.com/user/dotfiles.git")).toBe(true);
    expect(isSafeRepoUrl("ssh://git@github.com/user/dotfiles.git")).toBe(true);
    expect(isSafeRepoUrl("git://github.com/user/dotfiles.git")).toBe(true);
    expect(isSafeRepoUrl("git@github.com:user/dotfiles.git")).toBe(true);
  });

  it("rejects git remote-helper transports that run commands", () => {
    expect(isSafeRepoUrl("ext::sh -c 'touch /tmp/pwned'")).toBe(false);
    expect(isSafeRepoUrl("fd::17")).toBe(false);
  });

  it("rejects values that would be parsed as an option", () => {
    expect(isSafeRepoUrl("--upload-pack=touch /tmp/pwned")).toBe(false);
    expect(isSafeRepoUrl("-oProxyCommand=evil")).toBe(false);
  });

  it("rejects empty values", () => {
    expect(isSafeRepoUrl("")).toBe(false);
  });
});
