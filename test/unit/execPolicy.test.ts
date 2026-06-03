/*
 * Copyright (c) 2026 Aergic Labs, LLC
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockExecFilePromise } = vi.hoisted(() => ({
  mockExecFilePromise: vi.fn(),
}));

vi.mock("vscode", () => ({
  workspace: {
    getConfiguration: vi.fn().mockReturnValue({
      get: vi.fn().mockReturnValue("docker"),
    }),
  },
}));

vi.mock("../../src/utils/dockerUtils.js", () => ({
  execFilePromise: mockExecFilePromise,
}));

import {
  configureDockerPath,
  dockerExecPolicy,
} from "../../src/docker/execPolicy";

describe("execPolicy", () => {
  beforeEach(() => {
    mockExecFilePromise.mockReset();
    // Reset internal state by re-configuring to undefined
    configureDockerPath(undefined as any);
  });

  describe("configureDockerPath", () => {
    it("stores the docker path for later use", async () => {
      configureDockerPath("/custom/docker");
      mockExecFilePromise.mockResolvedValue({
        exitCode: 0,
        stdout: "",
        stderr: "",
      });

      await dockerExecPolicy(["ps"]);

      expect(mockExecFilePromise).toHaveBeenCalledWith("/custom/docker", [
        "ps",
      ]);
    });
  });

  describe("dockerExecPolicy", () => {
    it("uses the configured docker path when set", async () => {
      configureDockerPath("/usr/bin/docker");
      mockExecFilePromise.mockResolvedValue({
        exitCode: 0,
        stdout: "containers",
        stderr: "",
      });

      const result = await dockerExecPolicy(["ps", "-a"]);

      expect(result).toEqual({ exitCode: 0, stdout: "containers", stderr: "" });
      expect(mockExecFilePromise).toHaveBeenCalledWith("/usr/bin/docker", [
        "ps",
        "-a",
      ]);
    });

    it("falls back to VS Code settings when not configured", async () => {
      // configureDockerPath was reset to undefined in beforeEach
      mockExecFilePromise.mockResolvedValue({
        exitCode: 0,
        stdout: "",
        stderr: "",
      });

      await dockerExecPolicy(["version"]);

      expect(mockExecFilePromise).toHaveBeenCalledWith("docker", ["version"]);
    });

    it("returns the exec result directly", async () => {
      configureDockerPath("docker");
      mockExecFilePromise.mockResolvedValue({
        exitCode: 1,
        stdout: "",
        stderr: "error",
      });

      const result = await dockerExecPolicy(["bad-command"]);

      expect(result).toEqual({ exitCode: 1, stdout: "", stderr: "error" });
    });

    it("propagates rejections from the underlying exec", async () => {
      configureDockerPath("docker");
      mockExecFilePromise.mockRejectedValue(new Error("spawn ENOENT"));

      await expect(dockerExecPolicy(["ps"])).rejects.toThrow("spawn ENOENT");
    });

    it("can be reconfigured mid-session", async () => {
      configureDockerPath("/first/docker");
      configureDockerPath("/second/docker");
      mockExecFilePromise.mockResolvedValue({
        exitCode: 0,
        stdout: "",
        stderr: "",
      });

      await dockerExecPolicy(["ps"]);

      expect(mockExecFilePromise).toHaveBeenCalledWith("/second/docker", [
        "ps",
      ]);
    });
  });
});