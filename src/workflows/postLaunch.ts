/*
 * Copyright (c) 2026 Aergic Labs, LLC
 * SPDX-License-Identifier: AGPL-3.0-only
 */

/**
 * Shared post-launch connection sequence.
 *
 * Every workflow that builds a container repeats ensureInstalled, start,
 * copyGitConfig, beginConnectionPhase, bridge.connect, and
 * connectionEstablished. This module centralizes that sequence and the
 * duplicated writeOverrideConfig helper. Workflows still own window
 * management, pre-build setup, and the existing-container fast path.
 */

import { BRAND_PREFIX } from "../utils/constants";
import { getPlatformAdapter } from "../platform";
import type { WorkflowDependencies, WorkflowUI } from "./types";

/**
 * Shared post-build connection sequence. Call after buildPhaseComplete()
 * or skipBuildPhase().
 */
export async function connectToContainer(
  deps: WorkflowDependencies,
  ui: WorkflowUI,
  containerId: string,
  perContainerDisable?: boolean,
): Promise<{ port: number; installPath: string }> {
  const { serverManager, bridge, orchestrator, gitConfigCopier } = deps;

  try {
    const serverName = (await getPlatformAdapter()).serverApplicationName;

    ui.showBuildLog(
      `${BRAND_PREFIX} Installing ${serverName} into container...`,
    );
    await serverManager.ensureInstalled(containerId);

    ui.showBuildLog(`${BRAND_PREFIX} Starting ${serverName}...`);
    const startedServer = await serverManager.start(containerId);

    ui.showBuildLog(`${BRAND_PREFIX} Copying Git config...`);
    await gitConfigCopier.copyGitConfig(containerId, perContainerDisable);

    orchestrator.beginConnectionPhase();

    ui.showBuildLog(`${BRAND_PREFIX} Connecting to container...`);
    await bridge.connect(
      containerId,
      startedServer.port,
      startedServer.installPath,
    );

    orchestrator.connectionEstablished();

    ui.showBuildLog(`${BRAND_PREFIX} Connected.`);

    return { port: startedServer.port, installPath: startedServer.installPath };
  } catch (err: unknown) {
    const error = err instanceof Error ? err : new Error(String(err));
    if (orchestrator.state !== "error") {
      orchestrator.fail(error);
    }
    throw error;
  }
}

/**
 * Write a temporary devcontainer.json with platform-specific runArgs merged in.
 *
 * Dynamic imports avoid bundling node:fs, node:path, node:os, and
 * jsonc-parser into every consumer.
 */
export async function writeOverrideConfig(
  originalPath: string,
  config: Record<string, unknown>,
  extraRunArgs: string[],
): Promise<string> {
  const fs = await import("node:fs/promises");
  const path = await import("node:path");
  const os = await import("node:os");
  const { modify, applyEdits } = await import("jsonc-parser");
  const content = await fs.readFile(originalPath, "utf-8");
  const existing = (config.runArgs as string[]) || [];
  const value = [...extraRunArgs, ...existing];
  const edits = modify(content, ["runArgs"], value, {
    formattingOptions: { eol: "\n", insertSpaces: true, tabSize: 4 },
  });
  const patched = applyEdits(content, edits);
  const tmpPath = path.join(os.tmpdir(), `artizo-override-${Date.now()}.json`);
  await fs.writeFile(tmpPath, patched);
  return tmpPath;
}