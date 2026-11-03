/*
 * Copyright (c) 2026 Aergic Labs, LLC
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, it, expect, vi } from "vitest";

vi.mock("vscode", () => ({
  workspace: {
    getConfiguration: vi.fn().mockReturnValue({ get: vi.fn() }),
  },
}));

import { formatProvisionFailure } from "../../src/devcontainer/api";
import { ProvisionFailedError } from "../../src/devcontainer/provisionError";

function containerErrorLike(
  over: Partial<{
    description: string;
    message: string;
    stack: string;
    originalError: unknown;
  }> = {},
): Error & { description?: string; originalError?: unknown } {
  const e = new Error(over.message ?? "boom") as Error & {
    description?: string;
    originalError?: unknown;
  };
  e.description = over.description;
  e.originalError = over.originalError;
  if (over.stack) e.stack = over.stack;
  return e;
}

describe("formatProvisionFailure", () => {
  it("prefers the underlying message over the generic description", () => {
    const err = containerErrorLike({
      description: "An error occurred setting up the container.",
      message: "Cannot convert object to primitive value",
    });
    const out = formatProvisionFailure(err, "Build failed");
    expect(out).toContain("An error occurred setting up the container.");
    expect(out).toContain("Cannot convert object to primitive value");
  });

  it("does not duplicate when description equals message", () => {
    const err = containerErrorLike({ description: "same", message: "same" });
    expect(formatProvisionFailure(err, "Build failed")).toBe("Build failed: same");
  });

  it("appends cmd, cmdOutput, stderr, stdout from originalError", () => {
    const err = containerErrorLike({
      message: "x",
      originalError: {
        cmd: ["docker", "build"],
        cmdOutput: "OUT",
        stderr: "ERR",
        stdout: "STD",
      },
    });
    const out = formatProvisionFailure(err, "Build failed");
    expect(out).toContain("[cmd] docker build");
    expect(out).toContain("[cmdOutput]\nOUT");
    expect(out).toContain("[stderr]\nERR");
    expect(out).toContain("[stdout]\nSTD");
  });
});

describe("ProvisionFailedError", () => {
  it("carries the original error stack and reference", () => {
    const orig = new Error("root cause");
    const e = new ProvisionFailedError("wrapped", "/cfg", orig);
    expect(e.stack).toBe(orig.stack);
    expect(e.originalError).toBe(orig);
    expect(e.configPath).toBe("/cfg");
  });

  it("keeps its own stack when no original error is given", () => {
    const e = new ProvisionFailedError("wrapped");
    expect(e.stack).toBeDefined();
    expect(e.configPath).toBeUndefined();
  });
});
