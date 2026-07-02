/*
 * Copyright (c) 2026 Aergic Labs, LLC
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import vscodeMock from "../__mocks__/vscode";

vi.mock("vscode", () => ({ default: vscodeMock, ...vscodeMock }));

const { mockExec } = vi.hoisted(() => ({
  mockExec: vi.fn(),
}));

import * as vscode from "vscode";
import { ContainerService } from "../../src/sidebar/containerService";
import type { Host } from "../../src/host/host";

function makeHost(): Host {
  return { dockerPath: "docker", exec: mockExec } as unknown as Host;
}

function makeContainerJson(opts: {
  id: string;
  name?: string;
  state?: string;
  image?: string;
  labels?: Record<string, string>;
}) {
  return JSON.stringify({
    ID: opts.id,
    Names: opts.name ?? opts.id,
    State: opts.state ?? "running",
    Image: opts.image ?? "img",
    Labels: JSON.stringify(opts.labels ?? {}),
  });
}

describe("ContainerService", () => {
  let service: ContainerService;

  beforeEach(() => {
    vi.clearAllMocks();
    service = new ContainerService(makeHost());
  });

  describe("refreshContainers", () => {
    it("returns dev containers from docker ps", async () => {
      const stdout = [
        makeContainerJson({
          id: "abc123def456",
          name: "dev1",
          state: "running",
          labels: { "devcontainer.local_folder": "/proj1" },
        }),
        makeContainerJson({
          id: "xyz789",
          name: "plain",
          state: "exited",
          labels: {},
        }),
        makeContainerJson({
          id: "compose1",
          name: "compose-svc",
          state: "running",
          labels: { "com.docker.compose.project": "myapp" },
        }),
      ].join("\n");
      mockExec.mockResolvedValue({ exitCode: 0, stdout, stderr: "" });

      const result = await service.refreshContainers();

      expect(result).toHaveLength(2);
      expect(result[0]).toMatchObject({
        id: "abc123def456",
        name: "dev1",
        status: "running",
        localFolder: "/proj1",
      });
      expect(result[1]).toMatchObject({
        id: "compose1",
        name: "compose-svc",
        status: "running",
        localFolder: "",
      });
      expect(mockExec).toHaveBeenCalledWith({
        cmd: "docker",
        args: ["ps", "-a", "--no-trunc", "--format", "{{json .}}"],
      });
    });

    it("marks non-running state as stopped", async () => {
      const stdout = makeContainerJson({
        id: "abc",
        state: "exited",
        labels: { "artizo.local_folder": "/p" },
      });
      mockExec.mockResolvedValue({ exitCode: 0, stdout, stderr: "" });

      const result = await service.refreshContainers();

      expect(result[0].status).toBe("stopped");
    });

    it("returns empty array when docker ps exits non-zero", async () => {
      mockExec.mockResolvedValue({
        exitCode: 1,
        stdout: "",
        stderr: "docker not found",
      });

      const result = await service.refreshContainers();

      expect(result).toEqual([]);
    });

    it("returns empty array when no containers exist", async () => {
      mockExec.mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" });

      const result = await service.refreshContainers();

      expect(result).toEqual([]);
    });

    it("reads config_file label from either namespace", async () => {
      const stdout = makeContainerJson({
        id: "abc",
        labels: {
          "artizo.local_folder": "/proj",
          "artizo.config_file": "/cfg/devcontainer.json",
        },
      });
      mockExec.mockResolvedValue({ exitCode: 0, stdout, stderr: "" });

      const result = await service.refreshContainers();

      expect(result[0].configFile).toBe("/cfg/devcontainer.json");
    });
  });

  describe("handleContainerAction", () => {
    describe("start", () => {
      it("runs docker start", async () => {
        mockExec.mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" });

        await service.handleContainerAction("start", "cid");

        expect(mockExec).toHaveBeenCalledWith({
          cmd: "docker",
          args: ["start", "cid"],
        });
      });

      it("shows error message when exec throws", async () => {
        mockExec.mockRejectedValue(new Error("boom"));

        await service.handleContainerAction("start", "cid");

        expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
          "Docker start failed: boom",
        );
      });
    });

    describe("stop", () => {
      it("runs docker stop", async () => {
        mockExec.mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" });

        await service.handleContainerAction("stop", "cid");

        expect(mockExec).toHaveBeenCalledWith({
          cmd: "docker",
          args: ["stop", "cid"],
        });
      });

      it("shows error message for non-Error throw", async () => {
        mockExec.mockRejectedValue("string err");

        await service.handleContainerAction("stop", "cid");

        expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
          "Docker stop failed: string err",
        );
      });
    });

    describe("remove", () => {
      it("runs docker rm -f after confirmation", async () => {
        vi.mocked(vscode.window.showWarningMessage).mockResolvedValue(
          "Remove" as any,
        );
        mockExec.mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" });

        await service.handleContainerAction("remove", "cid", "myname");

        expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(
          'Remove container "myname"? This cannot be undone.',
          { modal: true },
          "Remove",
        );
        expect(mockExec).toHaveBeenCalledWith({
          cmd: "docker",
          args: ["rm", "-f", "cid"],
        });
      });

      it("uses sliced id when no name given", async () => {
        vi.mocked(vscode.window.showWarningMessage).mockResolvedValue(
          "Remove" as any,
        );
        mockExec.mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" });

        const longId = "abcdef1234567890";
        await service.handleContainerAction("remove", longId);

        expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(
          'Remove container "abcdef123456"? This cannot be undone.',
          { modal: true },
          "Remove",
        );
      });

      it("aborts when confirmation is dismissed", async () => {
        vi.mocked(vscode.window.showWarningMessage).mockResolvedValue(
          undefined as any,
        );

        await service.handleContainerAction("remove", "cid", "myname");

        expect(mockExec).not.toHaveBeenCalled();
      });

      it("aborts when confirmation is not Remove", async () => {
        vi.mocked(vscode.window.showWarningMessage).mockResolvedValue(
          "Cancel" as any,
        );

        await service.handleContainerAction("remove", "cid", "myname");

        expect(mockExec).not.toHaveBeenCalled();
      });

      it("shows error message when exec throws", async () => {
        vi.mocked(vscode.window.showWarningMessage).mockResolvedValue(
          "Remove" as any,
        );
        mockExec.mockRejectedValue(new Error("in use"));

        await service.handleContainerAction("remove", "cid", "myname");

        expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
          "Docker remove failed: in use",
        );
      });
    });

    describe("showLog", () => {
      it("creates a terminal following logs", async () => {
        const term = { show: vi.fn() };
        vi.mocked(vscode.window.createTerminal).mockReturnValue(term as any);

        await service.handleContainerAction("showLog", "cid", "logname");

        expect(vscode.window.createTerminal).toHaveBeenCalledWith({
          name: "Log: logname",
          shellPath: "docker",
          shellArgs: ["logs", "-f", "cid"],
        });
        expect(term.show).toHaveBeenCalled();
      });

      it("uses sliced id when no name given", async () => {
        const term = { show: vi.fn() };
        vi.mocked(vscode.window.createTerminal).mockReturnValue(term as any);

        const longId = "abcdef1234567890";
        await service.handleContainerAction("showLog", longId);

        expect(vscode.window.createTerminal).toHaveBeenCalledWith({
          name: "Log: abcdef123456",
          shellPath: "docker",
          shellArgs: ["logs", "-f", longId],
        });
      });
    });

    describe("inspect", () => {
      it("opens inspect output as json document", async () => {
        mockExec.mockResolvedValue({
          exitCode: 0,
          stdout: '{"Id":"abc"}',
          stderr: "",
        });
        const doc = {};
        const jsonDoc = {};
        vi.mocked(vscode.workspace.openTextDocument).mockResolvedValue(
          doc as any,
        );
        vi.mocked(vscode.languages.setTextDocumentLanguage).mockResolvedValue(
          jsonDoc as any,
        );

        await service.handleContainerAction("inspect", "cid", "iname");

        expect(mockExec).toHaveBeenCalledWith({
          cmd: "docker",
          args: ["inspect", "cid"],
        });
        const expectedQuery = Buffer.from('{"Id":"abc"}').toString("base64");
        expect(vscode.workspace.openTextDocument).toHaveBeenCalled();
        const uriArg = vi.mocked(vscode.workspace.openTextDocument).mock
          .calls[0][0];
        expect(uriArg).toHaveProperty("query", expectedQuery);
        expect(vscode.languages.setTextDocumentLanguage).toHaveBeenCalledWith(
          doc,
          "json",
        );
        expect(vscode.window.showTextDocument).toHaveBeenCalledWith(jsonDoc, {
          preview: true,
        });
      });

      it("uses sliced id when no name given for uri", async () => {
        mockExec.mockResolvedValue({
          exitCode: 0,
          stdout: "{}",
          stderr: "",
        });
        const longId = "abcdef1234567890";

        await service.handleContainerAction("inspect", longId);

        const uriArg = vi.mocked(vscode.workspace.openTextDocument).mock
          .calls[0][0]!;
        expect(uriArg.toString()).toContain("abcdef123456");
      });

      it("shows error message when exec throws", async () => {
        mockExec.mockRejectedValue(new Error("nope"));

        await service.handleContainerAction("inspect", "cid", "iname");

        expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
          "Docker inspect failed: nope",
        );
        expect(vscode.workspace.openTextDocument).not.toHaveBeenCalled();
      });

      it("shows error message when openTextDocument throws", async () => {
        mockExec.mockResolvedValue({
          exitCode: 0,
          stdout: "{}",
          stderr: "",
        });
        vi.mocked(vscode.workspace.openTextDocument).mockRejectedValue(
          new Error("doc fail"),
        );

        await service.handleContainerAction("inspect", "cid", "iname");

        expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
          "Docker inspect failed: doc fail",
        );
      });
    });

    describe("connect actions", () => {
      it("connectCurrentWindow executes attach command", async () => {
        await service.handleContainerAction("connectCurrentWindow", "cid");

        expect(vscode.commands.executeCommand).toHaveBeenCalledWith(
          "artizo.attachToRunningContainer",
          "cid",
          false,
        );
      });

      it("connectNewWindow executes attach command with true", async () => {
        await service.handleContainerAction("connectNewWindow", "cid");

        expect(vscode.commands.executeCommand).toHaveBeenCalledWith(
          "artizo.attachToRunningContainer",
          "cid",
          true,
        );
      });
    });
  });
});
