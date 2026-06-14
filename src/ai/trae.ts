/*
 * Copyright (c) 2026 Aergic Labs, LLC
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import * as vscode from "vscode";
import type { AiAssist, AiSubmitOptions } from "./types";

/**
 * Trae AI assist. The chat panel command is multiplexed by its options object;
 * passing a `query` string (without `addToChat`) opens the side chat and
 * submits the text as a user message. `keepOpen` avoids a toggle-close when the
 * panel is already focused. There is no separate files parameter, so file
 * references are folded into the prompt text by the caller.
 */
export class TraeAiAssist implements AiAssist {
  async isAvailable(): Promise<boolean> {
    return true;
  }

  async submit(prompt: string, _opts: AiSubmitOptions = {}): Promise<void> {
    // Open/focus the chat FIRST (no query). This moves focus off any active
    // code editor — otherwise the open command's editor-context branch grabs
    // the active file as a context chip and only *prefills* the prompt instead
    // of sending it. With the chat focused there is no active code editor, so
    // the second call takes the send path (sendPromptToSideChat).
    await vscode.commands.executeCommand("workbench.action.chat.icube.open", {
      keepOpen: true,
    });
    await new Promise((resolve) => setTimeout(resolve, 300));
    await vscode.commands.executeCommand("workbench.action.chat.icube.open", {
      query: prompt,
      keepOpen: true,
    });
  }
}
