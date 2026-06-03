/*
 * Copyright (c) 2026 Aergic Labs, LLC
 * SPDX-License-Identifier: AGPL-3.0-only
 */

/**
 * Volume service, manages Docker volume operations for the sidebar.
 *
 * Extracted from SidebarProvider to make volume operations
 * independently testable.
 */

import * as vscode from "vscode";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { MANAGED_LABEL } from "../utils/constants";

const execFileAsync = promisify(execFile);

export interface VolumeInfo {
  name: string;
  driver: string;
  managed: boolean;
}

export class VolumeService {
  constructor(private readonly dockerPath: string) {}

  /** Fetch all managed Docker volumes. */
  async refreshVolumes(): Promise<VolumeInfo[]> {
    const { stdout } = await execFileAsync(
      this.dockerPath,
      [
        "volume",
        "ls",
        "--filter",
        `label=${MANAGED_LABEL}`,
        "--format",
        "{{json .}}",
      ],
      { timeout: 10000, maxBuffer: 1024 * 1024 },
    );

    const lines = stdout.trim().split("\n").filter(Boolean);
    return lines.map((line) => {
      const v = JSON.parse(line);
      return {
        name: v.Name || "",
        driver: v.Driver || "local",
        managed: true,
      };
    });
  }

  /** Handle volume actions: inspect or remove. */
  async handleVolumeAction(
    action: "inspect" | "remove",
    volumeName: string,
  ): Promise<void> {
    try {
      const { stdout } = await execFileAsync(
        this.dockerPath,
        ["volume", "inspect", volumeName],
        { timeout: 10000, maxBuffer: 1024 * 1024 },
      );
      const info = JSON.parse(stdout);
      const details = JSON.stringify(info, null, 2);

      if (action === "inspect") {
        const encoded = Buffer.from(details).toString("base64");
        const uri = vscode.Uri.parse(
          `artizo-inspect:Volume ${volumeName}.json`,
        ).with({ query: encoded });
        const doc = await vscode.workspace.openTextDocument(uri);
        const jsonDoc = await vscode.languages.setTextDocumentLanguage(
          doc,
          "json",
        );
        await vscode.window.showTextDocument(jsonDoc, { preview: true });
      } else {
        const confirmed = await vscode.window.showWarningMessage(
          `Remove volume "${volumeName}"? This cannot be undone.`,
          { modal: true },
          "Remove",
        );
        if (confirmed === "Remove") {
          await execFileAsync(this.dockerPath, ["volume", "rm", volumeName], {
            timeout: 30000,
          });
        }
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      vscode.window.showErrorMessage(`Volume operation failed: ${msg}`);
    }
  }
}