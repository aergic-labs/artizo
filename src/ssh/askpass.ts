/*
 * Copyright (c) 2026 Aergic Labs, LLC
 * SPDX-License-Identifier: AGPL-3.0-only
 */

/** Askpass helpers for SSH invocations. */

import * as path from "node:path";
import * as vscode from "vscode";
import { getLogger } from "../utils/logger";
import { AskpassServer } from "./askpassServer";

export interface AskpassHandle {
  server: AskpassServer;
  askpassScript: string;
  askpassMain: string;
  nodePath: string;
}

/** Start an askpass server if enabled in config. Caller calls stop() on teardown. */
export async function startAskpass(
  extensionPath: string,
  opts?: { title?: string; modalPrompt?: boolean },
): Promise<AskpassHandle | undefined> {
  const enabled = vscode.workspace
    .getConfiguration("artizo")
    .get<boolean>("askpass", true);
  if (!enabled) return undefined;

  const title = opts?.title;
  const modalPrompt = opts?.modalPrompt ?? false;
  const server = new AskpassServer(getLogger(), {
    showPrompt: async (prompt, errorMessage) => {
      if (modalPrompt) {
        await vscode.window.showWarningMessage(
          "Artizo needs your SSH password to set up on the remote host. " +
            "A password input will appear at the top of the window.",
          { modal: true },
          "OK",
        );
      }
      const result = await vscode.window.showInputBox({
        password: true,
        prompt: errorMessage ? `${prompt} (${errorMessage})` : prompt,
        title,
        ignoreFocusOut: true,
      });
      getLogger().info(
        `[askpass] showInputBox returned: ${
          result === undefined
            ? "undefined"
            : result.length === 0
              ? "empty"
              : "value"
        } for prompt: ${prompt}`,
      );
      return result;
    },
  });
  await server.start();
  const scriptsDir = path.join(extensionPath, "scripts", "askpass");
  return {
    server,
    askpassScript:
      process.platform === "win32"
        ? path.join(scriptsDir, "askpass.cmd")
        : path.join(scriptsDir, "askpass.sh"),
    askpassMain: path.join(scriptsDir, "askpass-main.js"),
    nodePath: process.execPath,
  };
}

/** Build env for an ssh subprocess. Returns undefined when askpass is off. */
export function sshEnvForAskpass(
  handle: AskpassHandle | undefined,
): NodeJS.ProcessEnv | undefined {
  if (!handle) return undefined;
  return {
    ...process.env,
    SSH_ASKPASS: handle.askpassScript,
    SSH_ASKPASS_REQUIRE: "force",
    DISPLAY: "artizo",
    ARTIZO_SSH_ASKPASS_HANDLE: handle.server.handle,
    ARTIZO_SSH_ASKPASS_TOKEN: handle.server.token,
    ARTIZO_SSH_ASKPASS_NODE: handle.nodePath,
    ARTIZO_SSH_ASKPASS_MAIN: handle.askpassMain,
  };
}

/** BatchMode args when askpass is off (fail fast instead of hanging). */
export function batchModeArgs(hasAskpass: boolean): string[] {
  return hasAskpass ? [] : ["-o", "BatchMode=yes"];
}
