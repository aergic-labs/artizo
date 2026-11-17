/*
 * Copyright (c) 2026 Aergic Labs, LLC
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, it, expect, vi } from "vitest";

vi.mock("vscode", () => ({}));

import { containerWorkspacePath } from "../../src/workflows/postLaunch";

describe("containerWorkspacePath", () => {
  it("uses the config's workspaceFolder when set", () => {
    expect(
      containerWorkspacePath({ workspaceFolder: "/app" }, "/home/u/proj"),
    ).toBe("/app");
  });

  it("prefixes a relative workspaceFolder", () => {
    expect(
      containerWorkspacePath({ workspaceFolder: "app" }, "/home/u/proj"),
    ).toBe("/app");
  });

  it("defaults to /workspaces/<basename>", () => {
    expect(containerWorkspacePath({ image: "node:18" }, "/home/u/proj")).toBe(
      "/workspaces/proj",
    );
    expect(containerWorkspacePath(undefined, "/home/u/proj")).toBe(
      "/workspaces/proj",
    );
  });

  it("handles Windows-style host paths without backslashes", () => {
    expect(containerWorkspacePath({}, "C:\\Users\\u\\proj")).toBe(
      "/workspaces/proj",
    );
  });

  it("ignores a blank or non-string workspaceFolder", () => {
    expect(containerWorkspacePath({ workspaceFolder: "  " }, "/h/proj")).toBe(
      "/workspaces/proj",
    );
    expect(containerWorkspacePath({ workspaceFolder: 5 }, "/h/proj")).toBe(
      "/workspaces/proj",
    );
  });

  it("uses / for compose configs without a workspaceFolder", () => {
    // CLI: getRemoteWorkspaceFolder = workspaceFolder || '/'.
    expect(
      containerWorkspacePath({ dockerComposeFile: "compose.yml" }, "/h/proj"),
    ).toBe("/");
    expect(
      containerWorkspacePath(
        { dockerComposeFile: ["a.yml", "b.yml"], workspaceFolder: "/code" },
        "/h/proj",
      ),
    ).toBe("/code");
  });

  it("uses the directory for a .code-workspace host path", () => {
    expect(
      containerWorkspacePath({ image: "node:18" }, "/home/u/proj/app.code-workspace"),
    ).toBe("/workspaces/proj");
  });
});