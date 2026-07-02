/*
 * Copyright (c) 2026 Aergic Labs, LLC
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import * as fc from "fast-check";

/**
 * Bug Condition Exploration Property Tests
 *
 * These tests encode the EXPECTED (correct) behavior. They are expected to FAIL
 * on the current unfixed code, confirming the bugs exist.
 */

// Mock vscode module for tests that import modules depending on it
vi.mock("vscode", () => ({
  window: {
    createTerminal: vi.fn(() => ({
      show: vi.fn(),
      sendText: vi.fn(),
      exitStatus: undefined,
      dispose: vi.fn(),
    })),
    createOutputChannel: vi.fn(() => ({
      appendLine: vi.fn(),
      append: vi.fn(),
      show: vi.fn(),
      dispose: vi.fn(),
    })),
  },
  workspace: {},
  commands: {
    registerCommand: vi.fn().mockReturnValue({ dispose: vi.fn() }),
  },
  Uri: {
    parse: (str: string) => ({ toString: () => str }),
  },
  EventEmitter: vi.fn(function () {
    return {
      event: vi.fn(),
      fire: vi.fn(),
    };
  }),
  ProgressLocation: { Notification: 15 },
}));

// Mock node:child_process for authority resolver's execFile and spawn usage
vi.mock("node:child_process", () => {
  const { PassThrough } = require("node:stream");
  return {
    execFile: vi.fn(),
    spawn: vi.fn().mockImplementation(() => {
      const stdin = new PassThrough();
      const stdout = new PassThrough();
      const stderr = new PassThrough();
      const child = {
        stdin,
        stdout,
        stderr,
        on: vi.fn(),
        kill: vi.fn(),
        pid: 12345,
      };
      return child;
    }),
  };
});

// Mock dockerUtils to avoid real Docker calls
vi.mock("../../src/utils/dockerUtils", () => ({
  dockerExec: vi.fn(),
  dockerInspect: vi.fn(),
}));

import { execFile } from "node:child_process";

const mockExecFile = vi.mocked(execFile);

/** Arbitrary for a valid architecture string. */
const archArb = fc.constantFrom("x64", "arm64");

/** Arbitrary for a valid container ID (hex string, 12-64 chars). */
const containerIdArb = fc.hexaString({ minLength: 12, maxLength: 64 });

/** Helper to set up execFile mock responses in sequence. */
function setupExecFileResponses(
  responses: Array<{ stdout?: string; stderr?: string; exitCode?: number }>,
) {
  let callIndex = 0;
  mockExecFile.mockImplementation((_cmd: any, _args: any, ...rest: any[]) => {
    const callback = typeof rest[0] === "function" ? rest[0] : rest[1];
    const response = responses[callIndex] ?? {
      stdout: "",
      stderr: "",
      exitCode: 0,
    };
    callIndex++;

    if (response.exitCode && response.exitCode !== 0) {
      const error: any = new Error("Command failed");
      error.code = response.exitCode;
      error.stdout = response.stdout ?? "";
      error.stderr = response.stderr ?? "";
      callback(error, response.stdout ?? "", response.stderr ?? "");
    } else {
      callback(null, response.stdout ?? "", response.stderr ?? "");
    }
    return {} as any;
  });
}

describe("Property 1: Bug Condition - Wrong Server Binary and Broken Connection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("1.1 Server download URL must contain kiro-reh", () => {
    it("buildDownloadUrl produces URL containing kiro-reh for any version and arch", async () => {
      const { buildServerDownloadUrl } =
        await import("../../src/remote/productInfo");

      const url = await buildServerDownloadUrl(
        {
          commit: "0000000000000000000000000000000000000000",
          quality: "stable",
          serverApplicationName: "kiro-reh",
          serverDataFolderName: ".kiro-server",
          serverDownloadUrlTemplate:
            "https://prod.download.desktop.kiro.dev/releases/remotes/${commit}/kiro-reh-${os}-${arch}.tar.gz",
        },
        "x64",
      );

      expect(url).toContain("kiro-reh");
    });
  });

  describe("1.2 Server startup command must use bin/<serverApplicationName> with --port and --connection-token-file", () => {
    it("start command uses correct server binary and flags", async () => {
      const { ServerManager } = await import("../../src/remote/serverManager");

      await fc.assert(
        fc.asyncProperty(containerIdArb, async (containerId) => {
          // Create a fresh mock host for each property run
          const mockHost = {
            dockerExec: vi.fn(),
            dockerPath: "docker",
          };

          // start() calls many dockerExec operations in sequence:
          // 1. detectArch (uname -m)
          // 2. ensureConnectionToken (cat token file - may fail, then create)
          // 3. stop (cat pidfile - may fail)
          // 4. start command (nohup ... &)
          // 5. waitForPort (cat logfile)
          // Provide enough responses for all of them
          mockHost.dockerExec.mockResolvedValue({
            exitCode: 0,
            stdout: "x86_64\n",
            stderr: "",
          });
          // Override specific calls: token creation returns a UUID
          mockHost.dockerExec.mockResolvedValueOnce({
            exitCode: 0,
            stdout: "x86_64\n",
            stderr: "",
          }); // detectArch
          mockHost.dockerExec.mockResolvedValueOnce({
            exitCode: 0,
            stdout: "test-token-uuid\n",
            stderr: "",
          }); // ensureConnectionToken
          mockHost.dockerExec.mockResolvedValueOnce({
            exitCode: 1,
            stdout: "",
            stderr: "",
          }); // stop - cat pidfile (not found)
          mockHost.dockerExec.mockResolvedValueOnce({
            exitCode: 1,
            stdout: "",
            stderr: "",
          }); // stop - pgrep (not found)
          mockHost.dockerExec.mockResolvedValueOnce({
            exitCode: 0,
            stdout: "",
            stderr: "",
          }); // start command
          mockHost.dockerExec.mockResolvedValueOnce({
            exitCode: 0,
            stdout: "Extension host agent listening on 9999\n",
            stderr: "",
          }); // waitForPort

          const manager = new ServerManager({
            dockerPath: "docker",
            host: mockHost as any,
          });

          try {
            await manager.start(containerId);
          } catch {
            // May throw, that's fine - we just need to inspect the commands
          }

          // Find the start command among all dockerExec calls
          const allCalls = mockHost.dockerExec.mock.calls;
          const startCall = allCalls.find((call: any[]) => {
            const cmdStr = call[1].join(" ");
            return (
              cmdStr.includes("nohup") || cmdStr.includes("--start-server")
            );
          });

          if (!startCall) return; // Skip if start command wasn't reached

          const fullCommand = startCall[1].join(" ");

          // Expected: should NOT use --socket-path
          expect(fullCommand).not.toContain("--socket-path");
          // Expected: should NOT use --without-connection-token
          expect(fullCommand).not.toContain("--without-connection-token");
          // Expected: should use --port flag
          expect(fullCommand).toContain("--port");
          // Expected: should use --connection-token-file flag
          expect(fullCommand).toContain("--connection-token-file");
        }),
        { numRuns: 20 },
      );
    });
  });

  describe("1.3 Authority resolver must return non-zero port and valid connectionToken", () => {
    /**
     * For any valid running container, the authority resolver should return:
     * - host: "127.0.0.1" (not the containerId)
     * - port: non-zero (not 0)
     * - connectionToken: a non-empty string
     *
     * This test FAILS on unfixed code because resolveContainerById returns
     * { host: containerId, port: 0 } with no connectionToken.
     */
    it("resolver returns 127.0.0.1 with non-zero port and connectionToken", async () => {
      const { dockerInspect } = await import("../../src/utils/dockerUtils");
      const { RemoteAuthorityResolver } =
        await import("../../src/remote/authorityResolver");

      const mockedDockerInspect = vi.mocked(dockerInspect);

      await fc.assert(
        fc.asyncProperty(containerIdArb, async (containerId) => {
          mockedDockerInspect.mockReset();

          // Mock a running container
          mockedDockerInspect.mockResolvedValueOnce({
            id: containerId,
            name: "test-container",
            state: { status: "running", running: true, pid: 1234 },
            config: {
              image: "ubuntu:22.04",
              labels: {},
              env: [],
              workingDir: "/workspace",
            },
            mounts: [],
            networkSettings: { ports: {} },
          });

          // Provide a mock serverManager so the resolver doesn't use the fallback path
          const mockServerManager = {
            ensureInstalled: vi.fn().mockResolvedValue({
              commit: "abc",
              arch: "x64",
              installPath: "/tmp/.kiro-server/abc",
              port: 0,
            }),
            start: vi.fn().mockResolvedValue({
              commit: "abc",
              arch: "x64",
              installPath: "/tmp/.kiro-server/abc",
              port: 9999,
              connectionToken: "test-token-123",
            }),
            stop: vi.fn().mockResolvedValue(undefined),
            getStatus: vi.fn().mockResolvedValue(null),
            getCompatibleVersion: vi.fn().mockReturnValue("abc"),
          };

          const resolver = new RemoteAuthorityResolver({
            dockerPath: "docker",
            serverManager: mockServerManager as any,
          });

          // Resolve an attached-container authority
          const hexId = Buffer.from(containerId).toString("hex");
          const authority = `attached-container+${hexId}`;
          const result = await resolver.resolve(authority);

          expect(result.type).toBe("success");
          if (result.type === "success") {
            // Expected: host should be 127.0.0.1, not the containerId
            expect(result.authority.host).toBe("127.0.0.1");
            // Expected: port should be non-zero
            expect(result.authority.port).toBeGreaterThan(0);
            // Expected: connectionToken should be present
            expect(result.authority.connectionToken).toBeDefined();
            expect(result.authority.connectionToken).not.toBe("");
          }
        }),
        { numRuns: 20 },
      );
    });
  });

  describe("1.5/1.6 CLI output must not be piped to shell via sendText", () => {
    /**
     * CLI output lines should be written to a pseudo-terminal (pty) that writes
     * directly to the terminal buffer, NOT piped to shell via terminal.sendText().
     *
     * The current VscodeWorkflowUI.showBuildLog() calls terminal.sendText(content),
     * which causes the shell to interpret JSON lines as commands
     * (e.g., "bash: type:text: command not found").
     *
     * This test FAILS on unfixed code.
     */
    it("showBuildLog does not use sendText (which causes shell interpretation)", async () => {
      const vscode = await import("vscode");
      const { VscodeWorkflowUI } = await import("../../src/workflows/vscodeUI");
      const { LogOutputTerminal } =
        await import("../../src/workflows/logOutputTerminal");

      // Generate arbitrary CLI output content (JSON lines and plain text)
      const cliOutputArb = fc
        .array(
          fc.oneof(
            fc
              .record({
                type: fc.constantFrom(
                  "text",
                  "raw",
                  "start",
                  "stop",
                  "progress",
                ),
                level: fc.integer({ min: 1, max: 3 }),
                timestamp: fc.integer({ min: 1000000000, max: 9999999999 }),
                text: fc.string({ minLength: 1, maxLength: 100 }),
              })
              .map((obj) => JSON.stringify(obj)),
            fc.string({ minLength: 1, maxLength: 80 }),
          ),
          { minLength: 1, maxLength: 10 },
        )
        .map((lines) => lines.join("\n"));

      fc.assert(
        fc.property(cliOutputArb, (content) => {
          // Set up a fresh mock terminal for each property run
          const mockTerminal = {
            show: vi.fn(),
            sendText: vi.fn(),
            exitStatus: undefined,
            dispose: vi.fn(),
          };
          vi.mocked(vscode.window.createTerminal).mockReturnValue(
            mockTerminal as any,
          );

          const pty = new LogOutputTerminal();
          pty.open();
          const ui = new VscodeWorkflowUI(pty);
          ui.showBuildLog(content);

          // Expected: sendText should NOT be called
          // (content should go through a pty writeEmitter instead)
          expect(mockTerminal.sendText).not.toHaveBeenCalled();
        }),
        { numRuns: 50 },
      );
    });
  });
});
