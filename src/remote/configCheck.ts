/*
 * Copyright (c) 2026 Aergic Labs, LLC
 * SPDX-License-Identifier: AGPL-3.0-only
 */

/**
 * Shared container-config drift check.
 *
 * Runs on whichever side owns Docker (apex for local containers,
 * workspace-side for SSH-remote containers): everything it needs
 * (docker inspect, config files) is local to that side.
 *
 * Only containers we built are checked (identified by the
 * artizo.config_file label); attached/foreign containers skip.
 */

import * as vscode from "vscode";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  computeConfigHashes,
  compareConfigHashes,
  deserializeConfigHashes,
} from "../config/configHash";
import { getLogger } from "../utils/logger";
import type { ContainerInfo } from "../utils/dockerUtils";

const LABEL_CONFIG_FILE = "artizo.config_file";
const LABEL_CONFIG_HASH = "artizo.config_hash";

export type ConfigCheckResult = "ok" | "rebuild";

/**
 * Compare the container's stored config hashes against the current config
 * files. Prompts on mismatch or missing label.
 *
 * Returns "ok" to proceed or "rebuild" if the user chose to rebuild (the
 * rebuild command opens its own window; the caller should abort its
 * current flow).
 */
export async function checkContainerConfig(
  info: ContainerInfo,
): Promise<ConfigCheckResult> {
  const log = getLogger();
  const configPath = info.config.labels[LABEL_CONFIG_FILE];
  if (!configPath) {
    log.info(
      `[config-hash] check: no ${LABEL_CONFIG_FILE} label, skipping (foreign container)`,
    );
    return "ok"; // not built by artizo; nothing to compare
  }

  const stored = deserializeConfigHashes(info.config.labels[LABEL_CONFIG_HASH]);
  if (!stored) {
    log.info(
      `[config-hash] check: no ${LABEL_CONFIG_HASH} label (container predates tracking), prompting`,
    );
    const action = await vscode.window.showWarningMessage(
      "This container predates config tracking. Rebuild to enable change detection?",
      "Rebuild",
      "Continue anyway",
    );
    if (action === "Rebuild") {
      log.info("[config-hash] user chose Rebuild (predates tracking)");
      await vscode.commands.executeCommand("artizo.rebuildContainer");
      return "rebuild";
    }
    log.info("[config-hash] user chose Continue anyway (predates tracking)");
    return "ok";
  }

  let current;
  try {
    const { parse } = await import("jsonc-parser");
    const content = await fs.promises.readFile(configPath, "utf-8");
    const config = parse(content) as Record<string, unknown>;
    current = await computeConfigHashes(
      config,
      path.dirname(configPath),
      configPath,
    );
  } catch (err: unknown) {
    log.warn(
      `config hash computation failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    return "ok"; // unreadable config: let the normal flow surface the error
  }

  const diff = compareConfigHashes(stored, current);
  if (!diff.changed) {
    log.info(
      `[config-hash] check: hashes match (${Object.keys(current).length} file(s))`,
    );
    return "ok";
  }

  const changedFiles = [...diff.modified, ...diff.added, ...diff.deleted];
  log.info(`[config-hash] check: config changed: ${changedFiles.join(", ")}`);
  const action = await vscode.window.showWarningMessage(
    `Container config has changed: ${changedFiles.join(", ")}. Rebuild?`,
    "Rebuild",
    "Continue anyway",
  );
  if (action === "Rebuild") {
    log.info("[config-hash] user chose Rebuild (mismatch)");
    await vscode.commands.executeCommand("artizo.rebuildContainer");
    return "rebuild";
  }
  log.info("[config-hash] user chose Continue anyway (mismatch)");
  return "ok";
}
