/*
 * Copyright (c) 2026 Aergic Labs, LLC
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockExecFileAsync } = vi.hoisted(() => ({
  mockExecFileAsync: vi.fn(),
}));

// Mock promisify to return our controllable mock
vi.mock("node:util", async () => {
  const actual = await vi.importActual("node:util");
  return {
    ...actual,
    promisify: () => mockExecFileAsync,
  };
});

vi.mock("vscode", () => ({
  window: {
    showErrorMessage: vi.fn(),
    showWarningMessage: vi.fn(),
    createTerminal: vi
      .fn()
      .mockReturnValue({ show: vi.fn(), dispose: vi.fn() }),
    showTextDocument: vi.fn(),
  },
  commands: { executeCommand: vi.fn() },
  workspace: {
    openTextDocument: vi.fn(),
  },
  languages: {
    setTextDocumentLanguage: vi.fn().mockResolvedValue(undefined),
  },
  Uri: {
    parse: (s: string) => ({
      with(opts: any) {
        return { scheme: "artizo-inspect", query: opts.query };
      },
      toString: () => s,
    }),
  },
}));

import { ContainerService } from "../../src/sidebar/containerService";
import { VolumeService } from "../../src/sidebar/volumeService";

describe("ContainerService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("refreshContainers", () => {
    it("parses docker ps output into container info", async () => {
      mockExecFileAsync.mockResolvedValue({
        stdout: JSON.stringify({
          ID: "abc123def456",
          Names: "/my-devcontainer",
          State: "running",
          Image: "ubuntu:22.04",
          Labels: "devcontainer.local_folder=/home/user/project,other=val",
        }),
        stderr: "",
      });

      const service = new ContainerService("docker");
      const containers = await service.refreshContainers();

      expect(containers).toHaveLength(1);
      expect(containers[0]).toEqual({
        id: "abc123def456",
        name: "my-devcontainer",
        status: "running",
        image: "ubuntu:22.04",
        localFolder: "/home/user/project",
      });
    });

    it("handles stopped containers", async () => {
      mockExecFileAsync.mockResolvedValue({
        stdout: JSON.stringify({
          ID: "stopped1",
          Names: "/stopped-container",
          State: "exited",
          Image: "alpine",
          Labels: "",
        }),
        stderr: "",
      });

      const service = new ContainerService("docker");
      const containers = await service.refreshContainers();

      expect(containers[0].status).toBe("stopped");
    });
  });
});

describe("VolumeService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("refreshVolumes", () => {
    it("parses docker volume ls output", async () => {
      mockExecFileAsync.mockResolvedValue({
        stdout: JSON.stringify({ Name: "my-volume", Driver: "local" }),
        stderr: "",
      });

      const service = new VolumeService("docker");
      const volumes = await service.refreshVolumes();

      expect(volumes).toHaveLength(1);
      expect(volumes[0]).toEqual({
        name: "my-volume",
        driver: "local",
        managed: true,
      });
    });
  });
});