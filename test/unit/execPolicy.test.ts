/*
 * Copyright (c) 2026 Aergic Labs, LLC
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockExecFilePromise, mockConfigGet } = vi.hoisted(() => ({
  mockExecFilePromise: vi.fn(),
  mockConfigGet: vi.fn(),
}));

vi.mock("vscode", () => ({
  workspace: {
    getConfiguration: vi.fn().mockReturnValue({
      get: mockConfigGet,
    }),
  },
}));

vi.mock("../../src/utils/dockerUtils.js", () => ({
  execFilePromise: mockExecFilePromise,
}));

import {
  configureRuntimeKind,
  dockerExecPolicy,
  getDockerPath,
  isWslcRuntime,
  listJsonFormat,
  resolveRuntime,
} from "../../src/docker/execPolicy";

describe("execPolicy", () => {
  beforeEach(() => {
    mockExecFilePromise.mockReset();
    mockConfigGet.mockReset();
    mockConfigGet.mockReturnValue("docker");
    configureRuntimeKind("docker");
  });

  describe("getDockerPath", () => {
    it("reads artizo.dockerPath when runtime is docker", () => {
      mockConfigGet.mockImplementation((key: string, fallback: string) =>
        key === "dockerPath" ? "/usr/bin/docker" : fallback,
      );
      expect(getDockerPath()).toBe("/usr/bin/docker");
    });

    it("reads artizo.wslcPath when runtime is wslc", () => {
      configureRuntimeKind("wslc");
      mockConfigGet.mockImplementation((key: string, fallback: string) =>
        key === "wslcPath" ? "/usr/bin/wslc" : fallback,
      );
      expect(getDockerPath()).toBe("/usr/bin/wslc");
    });

    it("falls back to 'docker' when dockerPath setting is absent", () => {
      mockConfigGet.mockImplementation((_k: string, fallback: string) => fallback);
      expect(getDockerPath()).toBe("docker");
    });
  });

  describe("listJsonFormat", () => {
    it("returns Go template for docker", () => {
      configureRuntimeKind("docker");
      expect(listJsonFormat()).toBe("{{json .}}");
    });

    it("returns 'json' for wslc", () => {
      configureRuntimeKind("wslc");
      expect(listJsonFormat()).toBe("json");
    });
  });

  describe("isWslcRuntime", () => {
    it("tracks configureRuntimeKind", () => {
      configureRuntimeKind("docker");
      expect(isWslcRuntime()).toBe(false);
      configureRuntimeKind("wslc");
      expect(isWslcRuntime()).toBe(true);
    });
  });

  describe("dockerExecPolicy", () => {
    it("calls execFilePromise with getDockerPath()", async () => {
      mockConfigGet.mockImplementation((key: string, fallback: string) =>
        key === "dockerPath" ? "/custom/docker" : fallback,
      );
      mockExecFilePromise.mockResolvedValue({
        exitCode: 0,
        stdout: "containers",
        stderr: "",
      });

      const result = await dockerExecPolicy(["ps", "-a"]);

      expect(mockExecFilePromise).toHaveBeenCalledWith("/custom/docker", [
        "ps",
        "-a",
      ]);
      expect(result).toEqual({ exitCode: 0, stdout: "containers", stderr: "" });
    });

    it("returns the exec result directly", async () => {
      mockExecFilePromise.mockResolvedValue({
        exitCode: 1,
        stdout: "",
        stderr: "error",
      });

      const result = await dockerExecPolicy(["bad-command"]);

      expect(result).toEqual({ exitCode: 1, stdout: "", stderr: "error" });
    });

    it("propagates rejections from the underlying exec", async () => {
      mockExecFilePromise.mockRejectedValue(new Error("spawn ENOENT"));

      await expect(dockerExecPolicy(["ps"])).rejects.toThrow("spawn ENOENT");
    });

    it("honors a live setting change between calls", async () => {
      mockConfigGet.mockImplementation((key: string, fallback: string) =>
        key === "dockerPath" ? "/first/docker" : fallback,
      );
      mockExecFilePromise.mockResolvedValue({
        exitCode: 0,
        stdout: "",
        stderr: "",
      });

      await dockerExecPolicy(["ps"]);
      expect(mockExecFilePromise).toHaveBeenLastCalledWith("/first/docker", ["ps"]);

      mockConfigGet.mockImplementation((key: string, fallback: string) =>
        key === "dockerPath" ? "/second/docker" : fallback,
      );
      await dockerExecPolicy(["ps"]);
      expect(mockExecFilePromise).toHaveBeenLastCalledWith("/second/docker", ["ps"]);
    });
  });

  describe("resolveRuntime", () => {
    it("returns wslc when useWslc on Windows and wslc probe succeeds", async () => {
      mockExecFilePromise.mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" });
      const r = await resolveRuntime({
        platform: "win32",
        dockerPath: "docker",
        wslcPath: "wslc",
        useWslc: true,
      });
      expect(r).toEqual({ path: "wslc", kind: "wslc" });
    });

    it("falls through to docker when wslc probe fails", async () => {
      mockExecFilePromise.mockResolvedValue({ exitCode: 1, stdout: "", stderr: "" });
      const r = await resolveRuntime({
        platform: "win32",
        dockerPath: "docker",
        wslcPath: "wslc",
        useWslc: true,
      });
      expect(r).toEqual({ path: "docker", kind: "docker" });
    });

    it("falls through to docker when useWslc is false", async () => {
      const r = await resolveRuntime({
        platform: "win32",
        dockerPath: "docker",
        wslcPath: "wslc",
        useWslc: false,
      });
      expect(r).toEqual({ path: "docker", kind: "docker" });
    });

    it("falls through to docker on non-Windows even if useWslc is true", async () => {
      const r = await resolveRuntime({
        platform: "linux",
        dockerPath: "docker",
        wslcPath: "wslc",
        useWslc: true,
      });
      expect(r).toEqual({ path: "docker", kind: "docker" });
    });
  });
});
