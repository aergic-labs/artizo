/*
 * Copyright (c) 2026 Aergic Labs, LLC
 * SPDX-License-Identifier: AGPL-3.0-only
 */

/**
 * Single place that reports a container build/provision failure to the user.
 *
 * Shows one notification with "Show Log" and - when the platform has an AI
 * chat - "Diagnose with AI", which hands the build-log tail plus the
 * devcontainer.json (and any Dockerfile/compose file) to the platform chat.
 *
 * Called once at the command layer for a ProvisionFailedError; the building
 * workflows let that error propagate rather than showing their own toast.
 */

import * as vscode from "vscode";
import * as fs from "node:fs";
import * as path from "node:path";
import { BRAND_PREFIX } from "../utils/constants";
import { getLogger } from "../utils/logger";
import { getAiAssist } from "../ai";
import { resolveDockerfilePath } from "../config/dockerfilePath";
import type { LogOutputTerminal } from "../workflows/logOutputTerminal";
import type { ConfigManager } from "../config/configManager";
import type { ProvisionFailedError } from "../devcontainer/provisionError";

export interface ProvisionFailureContext {
  buildLogPty: LogOutputTerminal;
  buildLogTerminal: { show(preserveFocus?: boolean): void };
  configManager: ConfigManager;
  extensionUri: vscode.Uri;
}

/** Workspace-relative path with forward slashes, or undefined if outside. */
function toWorkspaceRelative(
  workspaceFolder: string | undefined,
  absPath: string | undefined,
): string | undefined {
  if (!workspaceFolder || !absPath) return undefined;
  const rel = path.relative(workspaceFolder, absPath);
  if (rel.startsWith("..") || path.isAbsolute(rel)) return undefined;
  return rel.split(path.sep).join("/");
}

export async function reportProvisionFailure(
  error: ProvisionFailedError,
  ctx: ProvisionFailureContext,
  workspaceFolder?: string,
): Promise<void> {
  ctx.buildLogTerminal.show(true);

  const ai = await getAiAssist();
  let aiAvailable = false;
  try {
    aiAvailable = await ai.isAvailable();
  } catch {
    aiAvailable = false;
  }

  // The build log terminal is already shown above, so when AI is available we
  // offer a single "Diagnose with AI" action - adding "Show Log" alongside it
  // would only let the user pick one (clicking either dismisses the toast),
  // orphaning the diagnose option. "Show Log" remains the fallback when there's
  // no AI to offer.
  const actions = aiAvailable ? ["Diagnose with AI"] : ["Show Log"];
  const choice = await vscode.window.showErrorMessage(
    `${BRAND_PREFIX} Container build failed: ${error.message}`,
    ...actions,
  );

  if (choice === "Show Log") {
    ctx.buildLogTerminal.show(true);
    return;
  }
  if (choice !== "Diagnose with AI") return;

  try {
    await diagnose(error, ctx, workspaceFolder);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    getLogger().warn(`Diagnose with AI failed: ${msg}`);
    vscode.window.showErrorMessage(
      `${BRAND_PREFIX} Couldn't start AI diagnosis: ${msg}`,
    );
  }
}

async function diagnose(
  error: ProvisionFailedError,
  ctx: ProvisionFailureContext,
  workspaceFolder: string | undefined,
): Promise<void> {
  // Base prompt template.
  const promptUri = vscode.Uri.joinPath(
    ctx.extensionUri,
    "src",
    "ai",
    "prompts",
    "devcontainer",
    "diagnose.md",
  );
  const base = fs.readFileSync(promptUri.fsPath, "utf-8");

  // Resolve config + dockerfile/compose paths.
  const configPath = error.configPath;
  let dockerfileAbs: string | undefined;
  if (configPath && workspaceFolder) {
    const cfg = await ctx.configManager.readConfig(
      vscode.Uri.file(workspaceFolder),
    );
    if (cfg.config) {
      dockerfileAbs = resolveDockerfilePath(
        cfg.config as Record<string, unknown>,
        path.dirname(configPath),
      );
    }
  }

  const relConfig = toWorkspaceRelative(workspaceFolder, configPath);
  const relDockerfile = toWorkspaceRelative(workspaceFolder, dockerfileAbs);

  // Files to attach (Kiro honors these; Trae/Devin ignore them, so the paths
  // are also named in the prompt text below).
  const files = [relConfig, relDockerfile].filter(
    (f): f is string => typeof f === "string",
  );

  const logTail = ctx.buildLogPty.getRecentText();
  const logPath = ctx.buildLogPty.getLogPath();

  const prompt =
    `${base}\n\n---\n\n` +
    `## Build error\n\n${error.message}\n\n` +
    (relConfig
      ? `## Config\n\nThe devcontainer config is at \`${relConfig}\`.\n`
      : "") +
    (relDockerfile
      ? `The referenced Dockerfile/compose file is at \`${relDockerfile}\`.\n`
      : "") +
    `\n## Build log (tail)\n\n\`\`\`\n${logTail}\n\`\`\`\n\n` +
    `## Full build log\n\n` +
    `The full log file is at \`${logPath}\`. It is a rolling session log that ` +
    `also contains EARLIER, unrelated operations and previous build attempts. ` +
    `The failure you are diagnosing is the MOST RECENT run - at the very end of ` +
    `the file. If the tail above isn't enough, use a shell command to read the ` +
    `entire file, then scan from the bottom up to find the most recent build ` +
    `run and its failure; ignore the older runs higher up.\n`;

  await getAiAssist().then((ai) =>
    ai.submit(prompt, { files, title: "Diagnose Container Build Failure" }),
  );
}
