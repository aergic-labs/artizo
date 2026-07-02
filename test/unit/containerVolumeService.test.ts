/*
 * Copyright (c) 2026 Aergic Labs, LLC
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockHostExec } = vi.hoisted(() => ({
  mockHostExec: vi.fn(),
}));

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

function createMockHost() {
  return {
    kind: "local" as const,
    dockerPath: "docker",
    exec: mockHostExec,
    onReady: vi.fn(() => ({ dispose: vi.fn() })),
  } as any;
}

describe("ContainerService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("refreshContainers", () => {
    it("parses docker ps output into container info", async () => {
      mockHostExec.mockResolvedValue({
        exitCode: 0,
        stdout: JSON.stringify({
          ID: "abc123def456",
          Names: "/my-devcontainer",
          State: "running",
          Image: "ubuntu:22.04",
          Labels: "devcontainer.local_folder=/home/user/project,other=val",
        }),
        stderr: "",
      });

      const host = createMockHost();
      const service = new ContainerService(host);
      const containers = await service.refreshContainers();

      expect(containers).toHaveLength(1);
      expect(containers[0]).toEqual({
        id: "abc123def456",
        name: "my-devcontainer",
        status: "running",
        image: "ubuntu:22.04",
        localFolder: "/home/user/project",
        configFile: "",
      });
    });

    it("recognizes artizo.local_folder labels too", async () => {
      mockHostExec.mockResolvedValue({
        exitCode: 0,
        stdout: JSON.stringify({
          ID: "artizo1",
          Names: "/artizo-container",
          State: "running",
          Image: "ubuntu:22.04",
          Labels:
            "artizo.local_folder=/home/user/project,artizo.config_file=/path/devcontainer.json",
        }),
        stderr: "",
      });

      const host = createMockHost();
      const service = new ContainerService(host);
      const containers = await service.refreshContainers();

      expect(containers).toHaveLength(1);
      expect(containers[0].localFolder).toBe("/home/user/project");
      expect(containers[0].configFile).toBe("/path/devcontainer.json");
    });

    it("filters out non-dev containers", async () => {
      mockHostExec.mockResolvedValue({
        exitCode: 0,
        stdout: [
          JSON.stringify({
            ID: "dev1",
            Names: "/dev-container",
            State: "running",
            Image: "ubuntu:22.04",
            Labels: "devcontainer.local_folder=/home/user/project",
          }),
          JSON.stringify({
            ID: "other1",
            Names: "/random-container",
            State: "running",
            Image: "redis",
            Labels: "",
          }),
        ].join("\n"),
        stderr: "",
      });

      const host = createMockHost();
      const service = new ContainerService(host);
      const containers = await service.refreshContainers();

      expect(containers).toHaveLength(1);
      expect(containers[0].id).toBe("dev1");
    });

    it("handles stopped containers", async () => {
      mockHostExec.mockResolvedValue({
        exitCode: 0,
        stdout: JSON.stringify({
          ID: "stopped1",
          Names: "/stopped-container",
          State: "exited",
          Image: "alpine",
          Labels: "devcontainer.local_folder=/home/user/project",
        }),
        stderr: "",
      });

      const host = createMockHost();
      const service = new ContainerService(host);
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
      mockHostExec.mockResolvedValue({
        exitCode: 0,
        stdout: JSON.stringify({ Name: "my-volume", Driver: "local" }),
        stderr: "",
      });

      const host = createMockHost();
      const service = new VolumeService(host);
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
