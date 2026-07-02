/*
 * Copyright (c) 2026 Aergic Labs, LLC
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import * as vscode from "vscode";
import type { AiAssist, AiSubmitOptions } from "./types";

/** Cline's cross-extension API (saoudrizwan.claude-dev). */
interface ClineAPI {
  startNewTask(task?: string, images?: string[]): Promise<void>;
}

/** Roo Code / Zoo Code - Cline descendants, same API shape. */
interface ZooCodeAPI {
  startNewTask(opts: { text?: string }): Promise<string>;
}

type SubmitFn = (text: string) => Promise<void>;

interface ProbeTarget {
  extensionId: string;
  buildSubmit(exports: unknown): SubmitFn | undefined;
}

/** Reusable probe for Roo Code and Zoo Code - same API, different IDs. */
const ROO_ZOO_PROBE: ProbeTarget = {
  extensionId: "",
  buildSubmit(exports) {
    const api = exports as ZooCodeAPI;
    if (typeof api.startNewTask !== "function") return undefined;
    return async (text) => {
      await api.startNewTask({ text });
    };
  },
};

const TARGETS: ProbeTarget[] = [
  {
    extensionId: "saoudrizwan.claude-dev",
    buildSubmit(exports) {
      const api = exports as ClineAPI;
      return typeof api.startNewTask === "function"
        ? (text) => api.startNewTask(text)
        : undefined;
    },
  },
  { ...ROO_ZOO_PROBE, extensionId: "RooVeterinaryInc.roo-cline" },
  { ...ROO_ZOO_PROBE, extensionId: "ZooCodeOrganization.zoo-code" },
];

/**
 * Generic AI assist for VSCodium and other editors without a vendor-specific
 * chat integration. Probes for installed AI extensions at runtime in priority
 * order (Cline → Roo Code → Zoo Code). Only returns isAvailable() === true
 * when an extension is actually installed and active.
 */
export class GenericAiAssist implements AiAssist {
  private _submit: SubmitFn | undefined;
  private _probed = false;

  async isAvailable(): Promise<boolean> {
    await this.probe();
    return this._submit !== undefined;
  }

  async submit(prompt: string, opts: AiSubmitOptions = {}): Promise<void> {
    await this.probe();

    if (!this._submit) {
      throw new Error(
        "AI assist is not available. Install Cline, Roo Code, or Zoo Code.",
      );
    }

    const text = opts.files?.length
      ? `${prompt}\n\nFiles: ${opts.files.join(", ")}`
      : prompt;

    await this._submit(text);
  }

  private async probe(): Promise<void> {
    if (this._probed) return;
    this._probed = true;

    for (const target of TARGETS) {
      try {
        const ext = vscode.extensions.getExtension(target.extensionId);
        if (!ext?.isActive) continue;

        const submit = target.buildSubmit(ext.exports);
        if (submit) {
          this._submit = submit;
          return;
        }
      } catch {
        /* extension not installed, or exports don't match */
      }
    }
  }
}
