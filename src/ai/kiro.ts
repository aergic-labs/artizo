/*
 * Copyright (c) 2026 Aergic Labs, LLC
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import * as vscode from "vscode";
import type { AiAssist, AiSubmitOptions } from "./types";

/**
 * Kiro AI assist. Uses the native agent command, which accepts a structured
 * prompt and renders an interactive agent session. Because the agent can ask
 * clarifying questions and report progress, this implementation also exposes
 * pollPendingQuestions().
 */
export class KiroAiAssist implements AiAssist {
  async isAvailable(): Promise<boolean> {
    return true;
  }

  async submit(prompt: string, opts: AiSubmitOptions = {}): Promise<void> {
    await vscode.commands.executeCommand("kiroAgent.agent.askAgent", {
      prompt,
      files: opts.files ?? [],
      title: opts.title,
    });
  }

  async pollPendingQuestions(): Promise<number> {
    const questions = (await vscode.commands.executeCommand(
      "kiroAgent.executions.getPendingQuestions",
    )) as unknown[];
    return Array.isArray(questions) ? questions.length : 0;
  }
}
