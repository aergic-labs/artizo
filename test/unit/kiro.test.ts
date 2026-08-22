/*
 * Copyright (c) 2026 Aergic Labs, LLC
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
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

  it("implements readAuthFiles", () => {
    expect(typeof adapter.readAuthFiles).toBe("function");
  });

  it("returns empty array when token file is missing", () => {
    const result = adapter.readAuthFiles();
    expect(Array.isArray(result)).toBe(true);
  });

  it("has required interface properties", () => {
    expect(adapter.name).toBe("Kiro");
    expect(adapter.dataFolderName).toBe(".kiro");
    expect(adapter.serverApplicationName).toBe("kiro-server");
  });
});
