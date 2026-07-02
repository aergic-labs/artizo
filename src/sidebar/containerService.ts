/*
 * Copyright (c) 2026 Aergic Labs, LLC
 * SPDX-License-Identifier: AGPL-3.0-only
 */

/**
 * Container service, manages Docker container operations for the sidebar.
 *
 * Extracted from SidebarProvider to make container lifecycle operations
 * independently testable.
 */

import * as vscode from "vscode";
import type { Host } from "../host/host";
import { getLogger } from "../utils/logger";
import {
  parseContainerList,
  getLocalFolder,
  getConfigFile,
  isDevContainer,
} from "../devcontainer/labels";

export interface ContainerInfo {
  id: string;
  name: string;
  status: "running" | "stopped";
  image: string;
  localFolder: string;
  configFile: string;
}

export class ContainerService {
  constructor(private readonly host: Host) {}

  /**
   * Fetch all dev containers from Docker.
   *
   * Mirrors the official extension: list every container with
   * `docker ps -a`, then categorize in memory by checking our
   * artizo.* / devcontainer.* labels.
   */
  async refreshContainers(): Promise<ContainerInfo[]> {
    getLogger().info("refreshContainers: called");
    const result = await this.host.exec({
      cmd: this.host.dockerPath,
      args: ["ps", "-a", "--no-trunc", "--format", "{{json .}}"],
    });

    getLogger().info(
      `refreshContainers: stdout length=${result.stdout.length}, exitCode=${result.exitCode}`,
    );
    if (result.exitCode !== 0) {
      getLogger().warn(`refreshContainers: docker ps failed: ${result.stderr}`);
      return [];
    }

    const summaries = parseContainerList(result.stdout);
    const dev = summaries.filter((s) => isDevContainer(s.labels));
    getLogger().info(
      `refreshContainers: ${summaries.length} total, ${dev.length} dev containers`,
    );
    return dev.map((s) => ({
      id: s.id,
      name: s.name,
      status: s.state === "running" ? "running" : "stopped",
      image: s.image,
      localFolder: getLocalFolder(s.labels) || "",
      configFile: getConfigFile(s.labels) || "",
    }));
  }

  /** Handle container actions: start, stop, remove, connect, logs, inspect. */
  async handleContainerAction(
    action:
      | "start"
      | "stop"
      | "remove"
      | "connectCurrentWindow"
      | "connectNewWindow"
      | "showLog"
      | "inspect",
    containerId: string,
    containerName?: string,
  ): Promise<void> {
    const docker = this.host.dockerPath;

    switch (action) {
      case "start":
      case "stop":
      case "remove": {
        if (action === "remove") {
          const name = containerName || containerId.slice(0, 12);
          const confirmed = await vscode.window.showWarningMessage(
            `Remove container "${name}"? This cannot be undone.`,
            { modal: true },
            "Remove",
          );
          if (confirmed !== "Remove") return;
        }
        try {
          const cmd =
            action === "start" ? "start" : action === "stop" ? "stop" : "rm";
          const args =
            cmd === "rm" ? ["rm", "-f", containerId] : [cmd, containerId];
          await this.host.exec({ cmd: docker, args });
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          vscode.window.showErrorMessage(`Docker ${action} failed: ${msg}`);
          return;
        }
        break;
      }
      case "showLog": {
        const name = containerName || containerId.slice(0, 12);
        const term = vscode.window.createTerminal({
          name: `Log: ${name}`,
          shellPath: docker,
          shellArgs: ["logs", "-f", containerId],
        });
        term.show();
        return;
      }
      case "inspect": {
        try {
          const result = await this.host.exec({
            cmd: docker,
            args: ["inspect", containerId],
          });
          const name = containerName || containerId.slice(0, 12);
          const encoded = Buffer.from(result.stdout).toString("base64");
          const uri = vscode.Uri.parse(
            `artizo-inspect:Container ${name}.json`,
          ).with({ query: encoded });
          const doc = await vscode.workspace.openTextDocument(uri);
          const jsonDoc = await vscode.languages.setTextDocumentLanguage(
            doc,
            "json",
          );
          await vscode.window.showTextDocument(jsonDoc, { preview: true });
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          vscode.window.showErrorMessage(`Docker inspect failed: ${msg}`);
        }
        return;
      }
      case "connectCurrentWindow":
      case "connectNewWindow": {
        await vscode.commands.executeCommand(
          "artizo.attachToRunningContainer",
          containerId,
          action === "connectNewWindow",
        );
        return;
      }
    }
  }
}
