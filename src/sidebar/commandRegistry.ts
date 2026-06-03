/*
 * Copyright (c) 2026 Aergic Labs, LLC
 * SPDX-License-Identifier: AGPL-3.0-only
 */

/**
 * Command registry. Computes the set of contextually available
 * sidebar commands based on remote state, workspace presence, and
 * config availability.
 *
 * Extracted from SidebarProvider.refreshCommands() to make it
 * independently testable.
 */

import type { CommandInfo } from "./messages";

/**
 * Compute the list of sidebar commands available in the current context.
 *
 * @param remoteName - vscode.env.remoteName
 * @param hasWorkspace - Whether a workspace folder is open
 * @param hasConfig - Whether a devcontainer.json exists for the workspace
 */
export function computeCommands(
  remoteName: string | undefined,
  hasWorkspace: boolean,
  hasConfig: boolean,
): CommandInfo[] {
  const remote = !!remoteName;
  const isArtizoRemote =
    remote && /^artizo-container|attached-container/.test(remoteName || "");

  const all: { id: string; label: string; when: boolean }[] = [
    { id: "artizo.revealLogTerminal", label: "Show Log", when: true },
    {
      id: "artizo.reopenInContainer",
      label: "Reopen in Container",
      when: !remote && hasWorkspace && hasConfig,
    },
    {
      id: "artizo.rebuildContainer",
      label: "Rebuild Container",
      when: !remote && hasWorkspace && hasConfig,
    },
    {
      id: "artizo.rebuildContainerNoCache",
      label: "Rebuild Without Cache",
      when: !remote && hasWorkspace && hasConfig,
    },
    {
      id: "artizo.rebuildAndReopenInContainer",
      label: "Rebuild and Reopen",
      when: !remote && hasWorkspace && hasConfig,
    },
    {
      id: "artizo.openFolderInContainer",
      label: "Open Folder in Container",
      when: !remote && !hasWorkspace,
    },
    {
      id: "artizo.cloneInVolume",
      label: "Clone Repository in Volume",
      when: !remote,
    },
    {
      id: "artizo.attachToRunningContainer",
      label: "Attach to Running Container",
      when: !remote,
    },
    {
      id: "artizo.cleanUpContainers",
      label: "Clean Up Dev Containers",
      when: !remote,
    },
    {
      id: "artizo.openDevContainerFile",
      label: "Open Container Config File",
      when: !remote && hasConfig,
    },
    {
      id: "artizo.addConfiguration",
      label: "Add Dev Container Configuration",
      when: !remote && hasWorkspace && !hasConfig,
    },
    {
      id: "artizo.configureDevContainer",
      label: "Configure Dev Container",
      when: !remote && hasWorkspace && hasConfig,
    },
    {
      id: "artizo.reopenLocally",
      label: "Reopen Folder Locally",
      when: isArtizoRemote,
    },
    {
      id: "workbench.action.remote.close",
      label: "Close Remote Connection",
      when: isArtizoRemote,
    },
    {
      id: "workbench.action.remote.showMenu",
      label: "Remote Menu",
      when: true,
    },
  ];

  return all
    .filter((c) => c.when)
    .reduce<CommandInfo[]>((acc, c) => {
      if (c.id === "artizo.rebuildContainer") {
        acc.push({
          id: "",
          label: "Rebuild Container",
          children: all
            .filter((x) => x.id.startsWith("artizo.rebuild"))
            .map((x) => ({ id: x.id, label: x.label })),
        });
      } else if (!c.id.startsWith("artizo.rebuild")) {
        acc.push({ id: c.id, label: c.label });
      }
      return acc;
    }, []);
}