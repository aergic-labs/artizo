/*
 * Copyright (c) 2026 Aergic Labs, LLC
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import * as vscode from "vscode";
import type { AiAssist, AiSubmitOptions } from "./types";

/**
 * Kiro AI assist. Uses Kiro's native (undocumented) agent command API, which
 * has changed before: `kiroAgent.agent.askAgent` was removed and replaced
 * with a two-step create -> sendPrompt -> viewSession flow. Each step can
 * throw if Kiro renames or removes commands again; the caller catches and
 * surfaces the error in the UI.
 *
 * The new API takes a plain prompt string (no `files` field); file paths are
 * inlined into the prompt text, matching GenericAiAssist. `title` is passed
 * to viewSession for the panel label.
 */
export class KiroAiAssist implements AiAssist {
  async isAvailable(): Promise<boolean> {
    return true;
  }

  async submit(prompt: string, opts: AiSubmitOptions = {}): Promise<void> {
    const text = opts.files?.length
      ? `${prompt}\n\nFiles: ${opts.files.join(", ")}`
      : prompt;

    const session = (await vscode.commands.executeCommand(
      "kiroAgent.sessions.create",
    )) as { sessionId?: string } | undefined;

    const sessionId = session?.sessionId;
    if (!sessionId) {
      throw new Error(
        "Kiro AI session creation returned no session id (API may have changed).",
      );
    }

    await vscode.commands.executeCommand(
      "kiroAgent.sessions.sendPrompt",
      sessionId,
      text,
    );

    await vscode.commands.executeCommand(
      "kiroAgent.viewSession",
      sessionId,
      opts.title,
    );
  }
}
