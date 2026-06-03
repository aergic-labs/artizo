/*
 * Copyright (c) 2026 Aergic Labs, LLC
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockSpawn, mockExistsSync } = vi.hoisted(() => ({
  mockSpawn: vi.fn(),
  mockExistsSync: vi.fn(),
}));

vi.mock("node:child_process", () => ({
  spawn: mockSpawn,
}));

vi.mock("node:fs", () => ({
  existsSync: mockExistsSync,
}));

vi.mock("node:path", async () => {
  const actual = await vi.importActual("node:path");
  return { ...actual };
});

import { templates, features } from "../../src/devcontainer/templates";

describe("devcontainer/templates", () => {
  beforeEach(() => {
    mockSpawn.mockReset();
    mockExistsSync.mockReset();
  });

  describe("templates", () => {
    it("calls spawnCli with correct args for basic template apply", async () => {
      mockSpawn.mockReturnValue(
        makeChild({ exitCode: 0, stdout: "done", stderr: "" }),
      );

      const result = await templates({
        outputFolder: "/tmp/out",
        templateId: "ubuntu",
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("done");
      const cliArgs: string[] = mockSpawn.mock.calls[0][1];
      expect(cliArgs).toContain("templates");
      expect(cliArgs).toContain("apply");
      expect(cliArgs).toContain("--template-id");
      expect(cliArgs).toContain("ubuntu");
      expect(cliArgs).toContain("--output-folder");
      expect(cliArgs).toContain("/tmp/out");
    });

    it("includes features when provided", async () => {
      mockSpawn.mockReturnValue(
        makeChild({ exitCode: 0, stdout: "", stderr: "" }),
      );

      await templates({
        outputFolder: "/out",
        templateId: "python",
        features: ["docker-in-docker", "git"],
      });

      const cliArgs: string[] = mockSpawn.mock.calls[0][1];
      expect(cliArgs).toContain("--features");
      expect(cliArgs).toContain("docker-in-docker");
      expect(cliArgs).toContain("--features");
      expect(cliArgs).toContain("git");
    });

    it("returns exit code from spawn", async () => {
      mockSpawn.mockReturnValue(
        makeChild({ exitCode: 1, stdout: "", stderr: "failed" }),
      );

      const result = await templates({
        outputFolder: "/out",
        templateId: "bad-template",
      });

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toBe("failed");
    });
  });

  describe("features", () => {
    it("calls features command", async () => {
      mockSpawn.mockReturnValue(
        makeChild({ exitCode: 0, stdout: "feature-list", stderr: "" }),
      );

      const result = await features({});

      expect(result.stdout).toBe("feature-list");
      const cliArgs: string[] = mockSpawn.mock.calls[0][1];
      expect(cliArgs).toContain("features");
    });

    it("adds list flag when list option is true", async () => {
      mockSpawn.mockReturnValue(
        makeChild({ exitCode: 0, stdout: "", stderr: "" }),
      );

      await features({ list: true });

      const cliArgs: string[] = mockSpawn.mock.calls[0][1];
      expect(cliArgs).toContain("features");
      expect(cliArgs).toContain("list");
    });

    it("does not add list flag when list option is false", async () => {
      mockSpawn.mockReturnValue(
        makeChild({ exitCode: 0, stdout: "", stderr: "" }),
      );

      await features({ list: false });

      const cliArgs: string[] = mockSpawn.mock.calls[0][1];
      expect(cliArgs).toContain("features");
      expect(cliArgs).not.toContain("list");
    });
  });

  describe("spawn error handling", () => {
    it("handles spawn error events", async () => {
      // Simulate spawn that emits error, then close with null code
      mockSpawn.mockImplementation(() => {
        const handlers: Record<string, Function[]> = {};
        const on = (evt: string, fn: Function) => {
          (handlers[evt] ??= []).push(fn);
          return { on };
        };
        // Emit error event first, then close
        queueMicrotask(() => {
          handlers["error"]?.[0]?.({ message: "ENOENT" });
          queueMicrotask(() => {
            handlers["close"]?.[0]?.(null);
          });
        });
        return {
          stdout: new MockStream(),
          stderr: new MockStream(),
          on,
        };
      });

      const result = await templates({ outputFolder: "/out", templateId: "x" });

      // Error handler sets exitCode:1
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("spawn error");
      expect(result.stderr).toContain("ENOENT");
    });

    it("handles close with null code", async () => {
      mockSpawn.mockReturnValue(
        makeChild({ exitCode: null as any, stdout: "", stderr: "" }),
      );

      const result = await templates({ outputFolder: "/out", templateId: "x" });

      expect(result.exitCode).toBe(1);
    });

    it("captures stdout chunks", async () => {
      mockSpawn.mockImplementation(() => {
        const stdout = new MockStream();
        const stderr = new MockStream();
        const on = (evt: string, fn: Function) => {
          if (evt === "close") queueMicrotask(() => fn(0));
          return { on };
        };
        queueMicrotask(() => stdout.emit("data", Buffer.from("chunk1")));
        queueMicrotask(() => stdout.emit("data", Buffer.from("chunk2")));
        return { stdout, stderr, on };
      });

      const result = await templates({ outputFolder: "/out", templateId: "x" });

      expect(result.stdout).toBe("chunk1chunk2");
    });

    it("captures stderr chunks", async () => {
      mockSpawn.mockImplementation(() => {
        const stdout = new MockStream();
        const stderr = new MockStream();
        const on = (evt: string, fn: Function) => {
          if (evt === "close") queueMicrotask(() => fn(0));
          return { on };
        };
        queueMicrotask(() => stderr.emit("data", Buffer.from("err1")));
        queueMicrotask(() => stderr.emit("data", Buffer.from("err2")));
        return { stdout, stderr, on };
      });

      const result = await templates({ outputFolder: "/out", templateId: "x" });

      expect(result.stderr).toBe("err1err2");
    });
  });
});

/** Build a mock child process that emits data then close. */
function makeChild(opts: {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}) {
  const stdout = new MockStream();
  const stderr = new MockStream();
  const on = (evt: string, fn: Function) => {
    if (evt === "close") {
      queueMicrotask(() => fn(opts.exitCode));
    }
    return { on };
  };
  if (opts.stdout)
    queueMicrotask(() => stdout.emit("data", Buffer.from(opts.stdout)));
  if (opts.stderr)
    queueMicrotask(() => stderr.emit("data", Buffer.from(opts.stderr)));
  return { stdout, stderr, on };
}

class MockStream {
  private handlers: Record<string, Function[]> = {};
  on(event: string, handler: Function) {
    (this.handlers[event] ??= []).push(handler);
    return this;
  }
  emit(event: string, ...args: any[]) {
    for (const h of this.handlers[event] || []) h(...args);
  }
}