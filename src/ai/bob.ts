/*
 * Copyright (c) 2026 Aergic Labs, LLC
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import * as vscode from "vscode";
import type { AiAssist, AiSubmitOptions } from "./types";

/**
 * Bob AI assist. Uses the `bob-code.sendMessageWithHiddenPrompt` command
 * (undocumented, sourced from the bob-code extension's command
 * registration). The command opens a new agent task and submits the
 * prompt as a hidden user message.
 *
 * The first arg (`mask`) is opaque to artizo - pass `""`. The second arg
 * is the prompt text. There is no separate files parameter, so file
 * references are inlined into the prompt text by the caller (matching
 * Kiro/Trae). `opts.title` has no mapping - Bob's task gets a default
 * label.
 *
 * On command failure: THROW. Do not silently fall back to GenericAiAssist
 * - silent fallback hides real breakage from the user. The caller catches
 * and surfaces the error. Same resilience pattern as KiroAiAssist.
 *
 * Risk: IBM could rename or remove the command. Acceptable - the throw
 * surfaces a real, actionable error to the user.
 */
export class BobAiAssist implements AiAssist {
  async isAvailable(): Promise<boolean> {
    const ext = vscode.extensions.getExtension("IBM.bob-code");
    return Boolean(ext?.isActive);
  }

  async submit(prompt: string, opts: AiSubmitOptions = {}): Promise<void> {
    const text = opts.files?.length
      ? `${prompt}\n\nFiles: ${opts.files.join(", ")}`
      : prompt;

    await vscode.commands.executeCommand(
      "bob-code.sendMessageWithHiddenPrompt",
      "", // mask - opaque to artizo
      text,
    );
  }
}
