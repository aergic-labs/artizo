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
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const LABEL_DEVCONTAINER = "devcontainer.local_folder";

export interface ContainerInfo {
  id: string;
  name: string;
  status: "running" | "stopped";
  image: string;
  localFolder: string;
}

export class ContainerService {
  constructor(private readonly dockerPath: string) {}

  /** Fetch all dev containers from Docker. */
  async refreshContainers(): Promise<ContainerInfo[]> {
    const { stdout } = await execFileAsync(
      this.dockerPath,
      [
        "ps",
        "-a",
        "--filter",
        `label=${LABEL_DEVCONTAINER}`,
        "--format",
        "{{json .}}",
      ],
      { timeout: 10000, maxBuffer: 1024 * 1024 },
    );

    const lines = stdout.trim().split("\n").filter(Boolean);
    return lines.map((line) => {
      const c = JSON.parse(line);
      const labels = parseLabelString(c.Labels || "");
      return {
        id: c.ID || "",
        name: (c.Names || "").replace(/^\/+/, ""),
        status:
          c.State === "running" ? ("running" as const) : ("stopped" as const),
        image: c.Image || "",
        localFolder: labels[LABEL_DEVCONTAINER] || "",
      };
    });
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
    const docker = this.dockerPath;
    const newWindow = action === "connectNewWindow";

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
          await execFileAsync(docker, args, { timeout: 30000 });
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
          const { stdout } = await execFileAsync(
            docker,
            ["inspect", containerId],
            { timeout: 10000, maxBuffer: 1024 * 1024 },
          );
          const name = containerName || containerId.slice(0, 12);
          const encoded = Buffer.from(stdout).toString("base64");
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
        const hexId = Buffer.from(containerId).toString("hex");
        const uri = vscode.Uri.parse(
          `vscode-remote://attached-container+${hexId}/`,
        );
        await vscode.commands.executeCommand("vscode.openFolder", uri, {
          forceNewWindow: newWindow,
        });
        return;
      }
    }
  }
}

function parseLabelString(labels: string): Record<string, string> {
  const result: Record<string, string> = {};
  if (!labels) {
    return result;
  }
  // Docker --format {{json .}} outputs Labels as a comma-separated string
  // Try JSON first (some Docker versions output JSON for Labels)
  try {
    const obj = JSON.parse(labels);
    if (typeof obj === "object" && obj !== null) {
      return obj as Record<string, string>;
    }
  } catch {
    // Not JSON, parse as comma-separated key=value
  }
  for (const part of labels.split(",")) {
    const eq = part.indexOf("=");
    if (eq > 0) {
      result[part.slice(0, eq).trim()] = part.slice(eq + 1);
    }
  }
  return result;
}