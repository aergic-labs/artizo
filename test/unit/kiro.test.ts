/*
 * Copyright (c) 2026 Aergic Labs, LLC
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, it, expect, vi } from "vitest";
import vscodeMock from "../__mocks__/vscode";
import { KiroAdapter } from "../../src/platform/kiro";

vi.mock("vscode", () => ({ default: vscodeMock, ...vscodeMock }));

describe("KiroAdapter", () => {
  const adapter = new KiroAdapter({
    name: "Kiro",
    dataFolderName: ".kiro",
    serverApplicationName: "kiro-server",
    needsArgvPatch: true,
    additionalDockerRunArgs: [],
  });

  it("implements readAuthToken", () => {
    expect(typeof adapter.readAuthToken).toBe("function");
  });

  it("implements getAuthTokenPath", () => {
    expect(typeof adapter.getAuthTokenPath).toBe("function");
    expect(adapter.getAuthTokenPath()).toBe(
      ".aws/sso/cache/kiro-auth-token.json",
    );
  });

  it("readAuthToken exists and returns string or undefined", () => {
    const result = adapter.readAuthToken();
    expect(result === undefined || typeof result === "string").toBe(true);
  });

  it("has required interface properties", () => {
    expect(adapter.name).toBe("Kiro");
    expect(adapter.dataFolderName).toBe(".kiro");
    expect(adapter.serverApplicationName).toBe("kiro-server");
  });
});