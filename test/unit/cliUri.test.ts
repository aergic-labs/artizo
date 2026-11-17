/*
 * Copyright (c) 2026 Aergic Labs, LLC
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, it, expect } from "vitest";
import { cliFileUri, CLIHOST_URI_SCHEME } from "../../src/devcontainer/cliUri";

describe("cliFileUri", () => {
  it("uses the CLIHost scheme so the CLI reads through its FileHost", () => {
    const uri = cliFileUri("/home/ubuntu/foo/.devcontainer/devcontainer.json");
    expect(uri.scheme).toBe(CLIHOST_URI_SCHEME);
    expect(uri.scheme).toBe("vscode-fileHost");
    expect(uri.path).toBe("/home/ubuntu/foo/.devcontainer/devcontainer.json");
    expect(uri.authority).toBe("");
  });

  it("keeps Windows paths intact on the way in", () => {
    const uri = cliFileUri("C:\\Users\\me\\proj\\.devcontainer\\devcontainer.json");
    // vscode-uri normalizes the drive path to a leading-slash form; the CLI
    // converts back with uriToFsPath(uri, cliHost.platform).
    expect(uri.scheme).toBe(CLIHOST_URI_SCHEME);
    expect(uri.fsPath).toBe("c:\\Users\\me\\proj\\.devcontainer\\devcontainer.json");
  });

  it("never emits a file: URI", () => {
    for (const p of [
      "/home/u/proj/.devcontainer/devcontainer.json",
      "C:\\proj\\.devcontainer\\devcontainer.json",
      "/tmp/artizo-override-1.json",
    ]) {
      expect(cliFileUri(p).scheme).not.toBe("file");
    }
  });
});