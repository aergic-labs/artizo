/*
 * Copyright (c) 2026 Aergic Labs, LLC
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import * as vscode from "vscode";
import type { AiAssist, AiSubmitOptions } from "./types";

/**
 * Devin AI assist. The cascade-action command opens the chat panel and submits
 * the prompt as a user message. It accepts an array whose first element is the
 * JSON form of a text item; the handler deserializes it internally. There is no
 * separate files parameter, so file references are folded into the prompt text
 * by the caller.
 */
export class DevinAiAssist implements AiAssist {
  async isAvailable(): Promise<boolean> {
    return true;
  }

  async submit(prompt: string, _opts: AiSubmitOptions = {}): Promise<void> {
    await vscode.commands.executeCommand("devin.executeCascadeAction", [
      JSON.stringify({ text: prompt }),
    ]);
  }
}
