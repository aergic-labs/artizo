/*
 * Copyright (c) 2026 Aergic Labs, LLC
 * SPDX-License-Identifier: AGPL-3.0-only
 */

/**
 * Integration tests that talk to a real Docker daemon.
 *
 * These tests create actual containers, run commands inside them,
 * and verify the results. They require Docker to be running.
 *
 * Run with: npm run test:integration
 */

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import * as path from "node:path";
import * as fs from "node:fs";
import * as vscode from "vscode";

vi.mock("vscode", () => {
  const realFs = require("node:fs") as typeof import("node:fs");

  const realPath = require("node:path") as typeof import("node:path");

  return {
    Uri: {
      file: (p: string) => ({ fsPath: p, scheme: "file", path: p }),
      joinPath: (base: { fsPath: string }, ...segments: string[]) => ({
        fsPath: realPath.join(base.fsPath, ...segments),
        scheme: "file",
        path: realPath.join(base.fsPath, ...segments),
      }),
    },
    workspace: {
      fs: {
        stat: async (uri: { fsPath: string }) => {
          if (realFs.existsSync(uri.fsPath)) {
            return { type: 1, ctime: 0, mtime: 0, size: 0 };
          }
          throw Object.assign(new Error("File not found"), {
            code: "FileNotFound",
          });
        },
        readFile: async (uri: { fsPath: string }) => {
          return realFs.readFileSync(uri.fsPath);
        },
      },
    },
  };
});

import {
  dockerExec,
  dockerInspect,
  isContainerRunning,
} from "../../src/utils/dockerUtils";
import { ConfigManager } from "../../src/config/configManager";

const execFileAsync = promisify(execFile);

const TEST_LABEL = "artizo-integration-test";
const TEST_IMAGE = "alpine:3.19";
const FIXTURE_DIR = path.resolve(__dirname, "fixtures/minimal-image");

// Check if Docker is available before running tests
let dockerAvailable: boolean;
try {
  const { stdout } = await execFileAsync("docker", [
    "info",
    "--format",
    "{{.ServerVersion}}",
  ]);
  dockerAvailable = stdout.trim().length > 0;
} catch {
  dockerAvailable = false;
}

// Skip all tests if Docker is not running
const describeWithDocker = dockerAvailable ? describe : describe.skip;

// Track containers we create so we can clean them up
const containersToCleanup: string[] = [];

/** Helper to create a test container with our label. */
async function createTestContainer(name: string): Promise<string> {
  const { stdout } = await execFileAsync("docker", [
    "run",
    "-d",
    "--label",
    `${TEST_LABEL}=true`,
    "--label",
    `devcontainer.local_folder=${FIXTURE_DIR}`,
    "--name",
    name,
    TEST_IMAGE,
    "sleep",
    "300",
  ]);
  const containerId = stdout.trim();
  containersToCleanup.push(containerId);
  return containerId;
}

/** Clean up any leftover containers from interrupted previous runs. */
async function cleanupLeftovers(): Promise<void> {
  try {
    const { stdout } = await execFileAsync("docker", [
      "ps",
      "-aq",
      "--filter",
      `label=${TEST_LABEL}=true`,
    ]);
    const ids = stdout.trim().split("\n").filter(Boolean);
    for (const id of ids) {
      try {
        await execFileAsync("docker", ["rm", "-f", id]);
      } catch {
        /* ignore */
      }
    }
  } catch {
    /* Docker might not be running */
  }
}

/** Cleanup all test containers after the suite. */
afterAll(async () => {
  for (const id of containersToCleanup) {
    try {
      await execFileAsync("docker", ["rm", "-f", id]);
    } catch {
      // Ignore cleanup errors
    }
  }
});

describeWithDocker("Docker Integration Tests", () => {
  beforeAll(async () => {
    await cleanupLeftovers();
  });
  describe("dockerExec - real container", () => {
    it("executes a command and returns stdout", async () => {
      const containerId = await createTestContainer("artizo-test-exec");

      const result = await dockerExec(containerId, [
        "echo",
        "hello from container",
      ]);

      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe("hello from container");
    });

    it("returns non-zero exit code for failing commands", async () => {
      const containerId = await createTestContainer("artizo-test-fail");

      const result = await dockerExec(containerId, ["sh", "-c", "exit 42"]);

      expect(result.exitCode).toBe(42);
    });

    it("can read files inside the container", async () => {
      const containerId = await createTestContainer("artizo-test-read");

      // /etc/os-release exists in alpine
      const result = await dockerExec(containerId, ["cat", "/etc/os-release"]);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("Alpine");
    });

    it("can write and read back files", async () => {
      const containerId = await createTestContainer("artizo-test-write");

      // Write a file
      const writeResult = await dockerExec(containerId, [
        "sh",
        "-c",
        'echo "test content" > /tmp/testfile.txt',
      ]);
      expect(writeResult.exitCode).toBe(0);

      // Read it back
      const readResult = await dockerExec(containerId, [
        "cat",
        "/tmp/testfile.txt",
      ]);
      expect(readResult.exitCode).toBe(0);
      expect(readResult.stdout.trim()).toBe("test content");
    });

    it("detects container architecture", async () => {
      const containerId = await createTestContainer("artizo-test-arch");

      const result = await dockerExec(containerId, ["uname", "-m"]);

      expect(result.exitCode).toBe(0);
      // Should be x86_64 or aarch64 depending on host
      expect(result.stdout.trim()).toMatch(/^(x86_64|aarch64|arm64)$/);
    });
  });

  describe("dockerInspect - real container", () => {
    it("returns container info with correct fields", async () => {
      const containerId = await createTestContainer("artizo-test-inspect");

      const info = await dockerInspect(containerId);

      expect(info.id).toBeTruthy();
      expect(info.name).toBe("artizo-test-inspect");
      expect(info.state.running).toBe(true);
      expect(info.state.status).toBe("running");
      expect(info.config.image).toContain("alpine");
      expect(info.config.labels[TEST_LABEL]).toBe("true");
    });

    it("throws for non-existent container", async () => {
      await expect(
        dockerInspect("nonexistent-container-id-12345"),
      ).rejects.toThrow();
    });
  });

  describe("isContainerRunning - real container", () => {
    it("returns true for a running container", async () => {
      const containerId = await createTestContainer("artizo-test-running");

      const running = await isContainerRunning(containerId);

      expect(running).toBe(true);
    });

    it("returns false for a stopped container", async () => {
      const containerId = await createTestContainer("artizo-test-stopped");

      // Stop the container
      await execFileAsync("docker", ["stop", containerId]);

      const running = await isContainerRunning(containerId);

      expect(running).toBe(false);
    });

    it("returns false for a non-existent container", async () => {
      const running = await isContainerRunning("does-not-exist-xyz");

      expect(running).toBe(false);
    });
  });

  describe("ConfigManager - real filesystem", () => {
    it("detects devcontainer.json in the fixture directory", async () => {
      const configManager = new ConfigManager();
      const configPath = await configManager.getConfigPath(
        vscode.Uri.file(FIXTURE_DIR),
      );

      expect(configPath).not.toBeNull();
      expect(configPath?.fsPath).toContain("devcontainer.json");
    });

    it("parses the fixture devcontainer.json correctly", async () => {
      const configManager = new ConfigManager();
      const result = await configManager.readConfig(
        vscode.Uri.file(FIXTURE_DIR),
      );

      expect(result.config).not.toBeNull();
      expect((result.config as any).name).toBe("Integration Test - Minimal");
      expect((result.config as any).image).toBe("alpine:3.19");
      expect(result.parseErrors).toHaveLength(0);
    });

    it("returns null for a directory with no config", async () => {
      const configManager = new ConfigManager();
      const configPath = await configManager.getConfigPath(
        vscode.Uri.file("/tmp"),
      );

      expect(configPath).toBeNull();
    });
  });

  describe("End-to-end: container lifecycle", () => {
    it("creates a container, verifies it runs, stops it, verifies it stopped", async () => {
      const containerId = await createTestContainer("artizo-test-lifecycle");

      // Verify running
      expect(await isContainerRunning(containerId)).toBe(true);

      // Execute a command
      const execResult = await dockerExec(containerId, ["hostname"]);
      expect(execResult.exitCode).toBe(0);
      expect(execResult.stdout.trim().length).toBeGreaterThan(0);

      // Stop
      await execFileAsync("docker", ["stop", containerId]);
      expect(await isContainerRunning(containerId)).toBe(false);

      // Inspect still works on stopped container
      const info = await dockerInspect(containerId);
      expect(info.state.running).toBe(false);
      expect(info.state.status).toBe("exited");
    });
  });
});
