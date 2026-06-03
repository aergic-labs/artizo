/*
 * Copyright (c) 2026 Aergic Labs, LLC
 * SPDX-License-Identifier: AGPL-3.0-only
 */

/**
 * Shared command runner that reduces boilerplate in command registrations.
 *
 * Each command is declared as a CommandSpec with declarative guard flags.
 * The runner handles logging, terminal output, guard execution, and
 * consistent error handling.
 */

import * as vscode from "vscode";
import { getLogger } from "../utils/logger";
import { BRAND_PREFIX } from "../utils/constants";
import {
  guardLocalContext,
  checkDockerAvailable,
  getLocalWorkspaceFolder,
} from "./guards";
import type { CommandContext } from "./commands";

export interface CommandSpec {
  id: string;
  label: string;
  guardLocal: boolean;
  guardDocker: boolean;
  workspaceRequired: boolean;
  handler: (ctx: CommandContext, workspaceFolder?: string) => Promise<void>;
}

/**
 * Register a single command from a CommandSpec.
 *
 * Handles guards, logging, buildLog terminal output, and consistent
 * error presentation to the user.
 */
export function registerCommand(
  context: vscode.ExtensionContext,
  ctx: CommandContext,
  spec: CommandSpec,
): void {
  const logger = getLogger();

  context.subscriptions.push(
    vscode.commands.registerCommand(spec.id, async () => {
      let workspaceFolder: string | undefined;

      if (spec.workspaceRequired) {
        workspaceFolder = getLocalWorkspaceFolder();
        if (!workspaceFolder) {
          vscode.window.showErrorMessage("No workspace folder open.");
          return;
        }
      }

      try {
        if (spec.guardLocal) guardLocalContext();
        if (spec.guardDocker) await checkDockerAvailable(ctx.dockerPath);
        // Double-guard for workflows that need it (matching existing behavior)
        if (spec.guardLocal && spec.guardDocker) guardLocalContext();

        logger.info(`=== ${spec.label} starting ===`);
        if (workspaceFolder) logger.info(`Workspace: ${workspaceFolder}`);
        ctx.buildLogTerminal.show(true);
        ctx.buildLogPty.writeLine(`${BRAND_PREFIX} ${spec.label} starting...`);
        if (workspaceFolder)
          ctx.buildLogPty.writeLine(
            `${BRAND_PREFIX} Workspace: ${workspaceFolder}`,
          );

        await spec.handler(ctx, workspaceFolder);

        logger.info(`=== ${spec.label} completed ===`);
        ctx.buildLogPty.writeLine(`${BRAND_PREFIX} Done.`);
      } catch (err: unknown) {
        const error = err instanceof Error ? err : new Error(String(err));
        logger.error(`${spec.label} failed`, error);
        ctx.buildLogPty.writeLine(`${BRAND_PREFIX} ERROR: ${error.message}`);
        if (error.stack) ctx.buildLogPty.writeLine(error.stack);
        ctx.buildLogTerminal.show(true);
        vscode.window
          .showErrorMessage(
            `${spec.label} failed: ${error.message}`,
            "Show Log",
          )
          .then((action) => {
            if (action === "Show Log") ctx.buildLogTerminal.show(true);
          });
      }
    }),
  );
}