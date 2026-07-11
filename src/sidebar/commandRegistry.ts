/*
 * Copyright (c) 2026 Aergic Labs, LLC
 * SPDX-License-Identifier: AGPL-3.0-only
 */

/**
 * Command registry. Computes the set of contextually available
 * sidebar commands based on managed-container state, workspace
 * presence, and config availability.
 *
 * Extracted from SidebarProvider.refreshCommands() to make it
 * independently testable.
 */

import {
  isInDevContainerWindow,
  getTier,
  ExecutionTier,
  isAttachedContainerWindow,
} from "../host/state";
import type { CommandInfo } from "./messages";

/**
 * Compute the list of sidebar commands available in the current context.
 *
 * @param hasWorkspace - Whether a workspace folder is open
 * @param hasConfig - Whether a devcontainer.json exists for the workspace
 */
export function computeCommands(
  hasWorkspace: boolean,
  hasConfig: boolean,
): CommandInfo[] {
  const managed = isInDevContainerWindow();
  const onSSHHost = getTier().tier === ExecutionTier.RemoteSSH;
  const inAttached = isAttachedContainerWindow();

  const all: { id: string; label: string; when: boolean }[] = [
    {
      id: "artizo.reopenInContainer",
      label: "Reopen in Container",
      when: !managed && hasWorkspace && hasConfig,
    },
    {
      id: "artizo.rebuildContainer",
      label: "Rebuild Container",
      when: !managed && hasWorkspace && hasConfig,
    },
    {
      id: "artizo.rebuildContainerNoCache",
      label: "Rebuild Without Cache",
      when: !managed && hasWorkspace && hasConfig,
    },
    {
      id: "artizo.rebuildAndReopenInContainer",
      label: "Rebuild and Reopen",
      when: !managed && hasWorkspace && hasConfig,
    },
    {
      id: "artizo.openFolderInContainer",
      label: hasWorkspace
        ? "Open Different Folder in Container"
        : "Open Folder in Container",
      when: !managed,
    },
    {
      id: "artizo.openFolderInContainerNewWindow",
      label: hasWorkspace
        ? "Open Different Folder in Container (New Window)"
        : "Open Folder in Container (New Window)",
      when: !managed,
    },
    {
      id: "artizo.cleanUpContainers",
      label: "Clean Up Dev Containers",
      when: !managed,
    },
    {
      id: "artizo.reopenInHost",
      label: "Return to Host",
      when: (managed && !inAttached) || onSSHHost,
    },
    { id: "artizo.revealOutputLog", label: "Show Log", when: true },
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
