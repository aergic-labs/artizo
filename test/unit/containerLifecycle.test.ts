/*
 * Copyright (c) 2026 Aergic Labs, LLC
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { ContainerLifecycle } from "../../src/lifecycle/containerLifecycle";

vi.mock("node:child_process", () => ({
  execFile: vi.fn(),
}));

vi.mock("../../src/docker/execPolicy.js", () => ({
  configureDockerPath: vi.fn(),
  dockerExecPolicy: vi.fn(),
}));

import { execFile } from "node:child_process";
import { dockerExecPolicy } from "../../src/docker/execPolicy.js";

const mockExecFile = vi.mocked(execFile);
const mockDockerExecPolicy = vi.mocked(dockerExecPolicy);

function setupExecFile(exitCode: number, stdout: string, stderr: string) {
  mockDockerExecPolicy.mockImplementation(async (_args: string[]) => {
    if (exitCode !== 0) {
      return { exitCode, stdout, stderr: stderr || "Command failed" };
    }
    return { exitCode: 0, stdout, stderr };
  });
}

// For tests that need more control (multiple calls, specific args)
function setupRawExecFile(exitCode: number, stdout: string, stderr: string) {
  mockExecFile.mockImplementation((_cmd: any, _args: any, callback: any) => {
    if (exitCode !== 0) {
      const error: any = new Error("Command failed");
      error.code = exitCode;
      error.stdout = stdout;
      error.stderr = stderr;
      callback(error, stdout, stderr);
    } else {
      callback(null, stdout, stderr);
    }
    return {} as any;
  });
}

describe("ContainerLifecycle", () => {
  let lifecycle: ContainerLifecycle;

  beforeEach(() => {
    vi.clearAllMocks();
    lifecycle = new ContainerLifecycle();
  });

  describe("start", () => {
    it("starts a container successfully", async () => {
      setupExecFile(0, "container-123\n", "");

      const result = await lifecycle.start("container-123");

      expect(result.success).toBe(true);
      expect(mockDockerExecPolicy).toHaveBeenCalledWith([
        "start",
        "container-123",
      ]);
    });

    it("returns error when start fails", async () => {
      setupExecFile(1, "", "Error: No such container");

      const result = await lifecycle.start("nonexistent");

      expect(result.success).toBe(false);
      expect(result.error).toContain("No such container");
    });
  });

  describe("stop", () => {
    it("stops a container successfully", async () => {
      setupExecFile(0, "container-123\n", "");

      const result = await lifecycle.stop("container-123");

      expect(result.success).toBe(true);
      expect(mockDockerExecPolicy).toHaveBeenCalledWith([
        "stop",
        "container-123",
      ]);
    });

    it("returns error when stop fails", async () => {
      setupExecFile(1, "", "Error: container already stopped");

      const result = await lifecycle.stop("container-123");

      expect(result.success).toBe(false);
      expect(result.error).toContain("already stopped");
    });
  });

  describe("remove", () => {
    it("removes a container successfully", async () => {
      setupExecFile(0, "container-123\n", "");

      const result = await lifecycle.remove("container-123");

      expect(result.success).toBe(true);
      expect(mockDockerExecPolicy).toHaveBeenCalledWith([
        "rm",
        "container-123",
      ]);
    });

    it("passes --force flag when specified", async () => {
      setupExecFile(0, "", "");

      await lifecycle.remove("container-123", { force: true });

      expect(mockDockerExecPolicy).toHaveBeenCalledWith([
        "rm",
        "--force",
        "container-123",
      ]);
    });

    it("passes --volumes flag when specified", async () => {
      setupExecFile(0, "", "");

      await lifecycle.remove("container-123", { removeVolumes: true });

      expect(mockDockerExecPolicy).toHaveBeenCalledWith([
        "rm",
        "--volumes",
        "container-123",
      ]);
    });

    it("passes both --force and --volumes flags", async () => {
      setupExecFile(0, "", "");

      await lifecycle.remove("container-123", {
        force: true,
        removeVolumes: true,
      });

      expect(mockDockerExecPolicy).toHaveBeenCalledWith([
        "rm",
        "--force",
        "--volumes",
        "container-123",
      ]);
    });

    it("returns error when remove fails", async () => {
      setupExecFile(1, "", "Error: container is running");

      const result = await lifecycle.remove("container-123");

      expect(result.success).toBe(false);
      expect(result.error).toContain("container is running");
    });
  });

  describe("cleanUp", () => {
    it("removes stopped dev containers", async () => {
      let callCount = 0;
      mockDockerExecPolicy.mockImplementation(async (_args: string[]) => {
        callCount++;
        if (callCount === 1) {
          return {
            exitCode: 0,
            stdout: "container-1\ncontainer-2\n",
            stderr: "",
          };
        }
        return { exitCode: 0, stdout: "", stderr: "" };
      });

      const result = await lifecycle.cleanUp();

      expect(result.containersRemoved).toBe(2);
      expect(result.errors).toHaveLength(0);
    });

    it("handles no stopped containers", async () => {
      setupExecFile(0, "", "");

      const result = await lifecycle.cleanUp();

      expect(result.containersRemoved).toBe(0);
    });

    it("collects errors from failed removals", async () => {
      let callCount = 0;
      mockDockerExecPolicy.mockImplementation(async (_args: string[]) => {
        callCount++;
        if (callCount === 1) {
          return { exitCode: 0, stdout: "container-1\n", stderr: "" };
        }
        return { exitCode: 1, stdout: "", stderr: "Permission denied" };
      });

      const result = await lifecycle.cleanUp();

      expect(result.containersRemoved).toBe(0);
      expect(result.errors.length).toBeGreaterThan(0);
    });

    it("prunes images when removeImages option is set", async () => {
      let callCount = 0;
      mockDockerExecPolicy.mockImplementation(async (_args: string[]) => {
        callCount++;
        if (callCount === 1) {
          return { exitCode: 0, stdout: "container-1\n", stderr: "" };
        }
        if (callCount === 2) {
          return { exitCode: 0, stdout: "", stderr: "" };
        }
        return {
          exitCode: 0,
          stdout: "Deleted: sha256:abc123\nTotal reclaimed space: 100MB\n",
          stderr: "",
        };
      });

      const result = await lifecycle.cleanUp({ removeImages: true });

      expect(result.imagesRemoved).toBe(1);
    });
  });

  describe("error paths", () => {
    it("returns failure when start command fails", async () => {
      setupExecFile(1, "", "Container not found");

      const result = await lifecycle.start("nonexistent");

      expect(result.success).toBe(false);
      expect(result.error).toContain("Container not found");
    });

    it("returns failure when stop command fails", async () => {
      setupExecFile(1, "", "Not running");

      const result = await lifecycle.stop("stopped-container");

      expect(result.success).toBe(false);
      expect(result.error).toContain("Not running");
    });

    it("returns failure when remove command fails", async () => {
      setupExecFile(1, "", "Container in use");

      const result = await lifecycle.remove("busy-container");

      expect(result.success).toBe(false);
      expect(result.error).toContain("Container in use");
    });
  });
});