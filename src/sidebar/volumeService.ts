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
import type { Host } from "../host/host";
import { MANAGED_LABEL } from "../utils/constants";

export interface VolumeInfo {
  name: string;
  driver: string;
  managed: boolean;
}

export class VolumeService {
  constructor(private readonly host: Host) {}

  /** Fetch all managed Docker volumes. */
  async refreshVolumes(): Promise<VolumeInfo[]> {
    const result = await this.host.exec({
      cmd: this.host.dockerPath,
      args: [
        "volume",
        "ls",
        "--filter",
        `label=${MANAGED_LABEL}`,
        "--format",
        "{{json .}}",
      ],
    });

    const lines = result.stdout.trim().split("\n").filter(Boolean);
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
      const result = await this.host.exec({
        cmd: this.host.dockerPath,
        args: ["volume", "inspect", volumeName],
      });
      const info = JSON.parse(result.stdout);
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
          await this.host.exec({
            cmd: this.host.dockerPath,
            args: ["volume", "rm", volumeName],
          });
        }
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      vscode.window.showErrorMessage(`Volume operation failed: ${msg}`);
    }
  }
}
