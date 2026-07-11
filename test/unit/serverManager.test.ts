/*
 * Copyright (c) 2026 Aergic Labs, LLC
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../src/utils/logger", () => ({
  getLogger: () => ({ info: vi.fn(), error: vi.fn(), debug: vi.fn(), warn: vi.fn(), trace: vi.fn(), show: vi.fn(), append: vi.fn() }),
}));

vi.mock("node:fs", async () => ({
  ...(await vi.importActual("node:fs")),
  readFileSync: vi.fn(),
}));

vi.mock("../../src/utils/dockerUtils", () => ({
  dockerExec: vi.fn(),
  execFilePromise: vi.fn(),
}));

vi.mock("../../src/remote/bootstrap", () => {
  const mockBootstrapBusybox = vi.fn().mockResolvedValue(undefined);
  const mockDeployTools = vi.fn().mockResolvedValue(undefined);
  const mockRunSetup = vi.fn().mockResolvedValue({ home: "/root" });
  return {
    ContainerBootstrap: vi.fn(function () {
      return {
        bootstrapBusybox: mockBootstrapBusybox,
        deployTools: mockDeployTools,
        runSetup: mockRunSetup,
      };
    }),
    __mockBootstrapBusybox: mockBootstrapBusybox,
    __mockDeployTools: mockDeployTools,
    __mockRunSetup: mockRunSetup,
  };
});

const { mockReadKiroToken } = vi.hoisted(() => ({
  mockReadKiroToken: vi.fn(),
}));

vi.mock("../../src/platform", () => ({
  getPlatformAdapter: vi.fn().mockResolvedValue({
    readAuthToken: mockReadKiroToken,
    getAuthTokenPath: vi
      .fn()
      .mockReturnValue(".aws/sso/cache/kiro-auth-token.json"),
    getServerInstallRoot: vi.fn(),
    name: "Kiro",
    serverApplicationName: "kiro-server",
    dataFolderName: ".kiro",
    getServerDownloadUrl: vi.fn(
      (commit: string) =>
        `https://update.code.visualstudio.com/commit:${commit}/server-linux-x64/stable`,
    ),
  }),
}));

vi.mock("node:crypto", () => ({
  randomUUID: () => "test-uuid-1234-5678-abcd-ef0123456789",
}));

import {
  ServerManager,
  validateArch,
  buildStartCommand,
  type ServerManagerOptions,
} from "../../src/remote/serverManager";
import type { ProductInfo } from "../../src/remote/productInfo";
// Access mock internals via the mocked module
const bootstrapModule = (await import("../../src/remote/bootstrap")) as any;
const {
  ContainerBootstrap,
  __mockBootstrapBusybox,
  __mockDeployTools,
  __mockRunSetup,
} = bootstrapModule;
const mockBootstrapBusybox = __mockBootstrapBusybox as ReturnType<typeof vi.fn>;
const mockDeployTools = __mockDeployTools as ReturnType<typeof vi.fn>;
const mockRunSetup = __mockRunSetup as ReturnType<typeof vi.fn>;

function createMockHost() {
  return {
    dockerExec: vi
      .fn()
      .mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" }),
    dockerPath: "docker",
  };
}

let mockHost = createMockHost();

/**
 * Helper to set up sequential mock responses for host.dockerExec.
 * Each call to dockerExec will consume the next response in the array.
 */
function setupExecFileResponses(
  responses: Array<{ stdout: string; stderr?: string; exitCode?: number }>,
) {
  mockHost.dockerExec.mockReset();
  let callIndex = 0;

  mockHost.dockerExec.mockImplementation(
    (_containerId: string, _command: string[], _options?: any) => {
      const response = responses[callIndex] ?? {
        stdout: "",
        stderr: "",
        exitCode: 1,
      };
      callIndex++;

      const { stdout, stderr = "", exitCode = 0 } = response;

      if (exitCode !== 0) {
        return Promise.resolve({ exitCode, stdout: stdout ?? "", stderr });
      }
      return Promise.resolve({ exitCode: 0, stdout: stdout ?? "", stderr });
    },
  );
}

const TEST_PRODUCT_INFO: ProductInfo = {
  commit: "abc123def456789",
  quality: "stable",
  serverApplicationName: "kiro-reh",
  serverDataFolderName: ".kiro-server",
};

describe("serverManager", () => {
  describe("validateArch", () => {
    it("maps x86_64 to x64", () => {
      expect(validateArch("x86_64")).toBe("x64");
    });

    it("maps x86_64 with trailing newline to x64", () => {
      expect(validateArch("x86_64\n")).toBe("x64");
    });

    it("maps aarch64 to arm64", () => {
      expect(validateArch("aarch64")).toBe("arm64");
    });

    it("maps arm64 to arm64", () => {
      expect(validateArch("arm64")).toBe("arm64");
    });

    it("throws for unsupported architecture", () => {
      expect(() => validateArch("mips")).toThrow(
        'Unsupported architecture: "mips"',
      );
    });
  });

  describe("buildStartCommand", () => {
    const params = {
      installPath: "/tmp/.kiro-server/abc123",
      binaryName: "kiro-reh",
      tokenFilePath: "/tmp/.kiro-server/abc123/.connection-token",
      serverDataDir: "/tmp/.kiro-server/abc123/data",
      extensionsDir: "/tmp/.kiro-server/extensions",
      telemetryLevel: "off",
      logFile: "/tmp/.kiro-server/abc123/server.log",
      pidFile: "/tmp/.kiro-server/abc123/server.pid",
    };

    it("returns a sh -c command array", () => {
      const cmd = buildStartCommand(params);
      expect(cmd[0]).toBe("sh");
      expect(cmd[1]).toBe("-c");
      expect(cmd[2]).toBeTypeOf("string");
    });

    it("includes the binary path", () => {
      const cmd = buildStartCommand(params);
      expect(cmd[2]).toContain("/tmp/.kiro-server/abc123/bin/kiro-reh");
    });

    it("includes standard server flags", () => {
      const cmd = buildStartCommand(params);
      expect(cmd[2]).toContain("--host 127.0.0.1");
      expect(cmd[2]).toContain("--port 0");
      expect(cmd[2]).toContain("--accept-server-license-terms");
      expect(cmd[2]).toContain("--start-server");
    });

    it("includes connection token file path", () => {
      const cmd = buildStartCommand(params);
      expect(cmd[2]).toContain(
        '--connection-token-file "/tmp/.kiro-server/abc123/.connection-token"',
      );
    });

    it("includes telemetry level", () => {
      const cmd = buildStartCommand(params);
      expect(cmd[2]).toContain("--telemetry-level off");
    });

    it("includes the install path in mkdir", () => {
      const cmd = buildStartCommand(params);
      expect(cmd[2]).toContain('mkdir -m 700 -p "/tmp/.kiro-server/abc123"');
    });

    it("redirects output to log and captures pid", () => {
      const cmd = buildStartCommand(params);
      expect(cmd[2]).toContain('> "/tmp/.kiro-server/abc123/server.log" 2>&1');
      expect(cmd[2]).toContain(
        'echo $! > "/tmp/.kiro-server/abc123/server.pid"',
      );
    });

    it("uses nohup for background execution", () => {
      const cmd = buildStartCommand(params);
      expect(cmd[2]).toContain("nohup");
    });

    it("includes --extensions-dir flag", () => {
      const cmd = buildStartCommand(params);
      expect(cmd[2]).toContain(
        '--extensions-dir "/tmp/.kiro-server/extensions"',
      );
    });

    it("creates extensions dir in mkdir", () => {
      const cmd = buildStartCommand(params);
      expect(cmd[2]).toContain(
        'mkdir -m 700 -p "/tmp/.kiro-server/abc123" "/tmp/.kiro-server/abc123/data" "/tmp/.kiro-server/extensions"',
      );
    });
  });

  describe("ServerManager", () => {
    let manager: ServerManager;

    beforeEach(() => {
      mockHost = createMockHost();
      manager = new ServerManager({
        productInfo: TEST_PRODUCT_INFO,
        extensionPath: "/fake/path",
        host: mockHost as any,
      });
      mockHost.dockerExec.mockReset();
      mockReadKiroToken.mockReset();
    });

    describe("getCompatibleVersion", () => {
      it("returns the product commit hash", () => {
        expect(manager.getCompatibleVersion()).toBe(TEST_PRODUCT_INFO.commit);
      });
    });

    describe("getExtensionsDir", () => {
      it("returns extensions path under the server data folder", async () => {
        const dir = await manager.getExtensionsDir("container1");
        expect(dir).toBe(
          `/tmp/${TEST_PRODUCT_INFO.serverDataFolderName}/extensions`,
        );
      });
    });

    describe("detectArch", () => {
      it("detects x86_64 architecture", async () => {
        setupExecFileResponses([{ stdout: "x86_64\n" }]);
        const arch = await manager.detectArch("container1");
        expect(arch).toBe("x64");
      });

      it("detects aarch64 architecture", async () => {
        setupExecFileResponses([{ stdout: "aarch64\n" }]);
        const arch = await manager.detectArch("container1");
        expect(arch).toBe("arm64");
      });

      it("throws on failure", async () => {
        setupExecFileResponses([
          { stdout: "", stderr: "exec failed", exitCode: 1 },
        ]);
        await expect(manager.detectArch("container1")).rejects.toThrow(
          "Failed to detect container architecture",
        );
      });

      it("passes correct docker exec args for uname", async () => {
        setupExecFileResponses([{ stdout: "x86_64\n" }]);
        await manager.detectArch("container1");

        const callArgs = mockHost.dockerExec.mock.calls[0];
        expect(callArgs[0]).toBe("container1");
        expect(callArgs[1]).toEqual(["uname", "-m"]);
      });
    });

    describe("isServerBinaryPresent", () => {
      it("returns true when server binary exists at expected path", async () => {
        setupExecFileResponses([{ stdout: "" }]);
        const present = await manager.isServerBinaryPresent("container1");
        expect(present).toBe(true);
      });

      it("returns false when server binary does not exist", async () => {
        setupExecFileResponses([
          { stdout: "", stderr: "test failed", exitCode: 1 },
        ]);
        const present = await manager.isServerBinaryPresent("container1");
        expect(present).toBe(false);
      });
    });

    describe("ensureInstalled", () => {
      it("skips installation when binary is already present", async () => {
        setupExecFileResponses([
          // detectArch: uname -m
          { stdout: "x86_64\n" },
          // isServerBinaryPresent: test -f bin/kiro-reh
          { stdout: "" },
        ]);

        const info = await manager.ensureInstalled("container1");

        expect(info.commit).toBe(TEST_PRODUCT_INFO.commit);
        expect(info.arch).toBe("x64");
        expect(info.installPath).toBe(
          `/tmp/${TEST_PRODUCT_INFO.serverDataFolderName}`,
        );
        // Only 2 calls: uname + test-f (no download)
        expect(mockHost.dockerExec).toHaveBeenCalledTimes(2);
      });

      it("installs when binary is not present", async () => {
        setupExecFileResponses([
          { stdout: "x86_64\n" },
          { stdout: "", stderr: "test failed", exitCode: 1 },
          { stdout: "" }, // rm -rf
        ]);

        const info = await manager.ensureInstalled("container1");

        expect(info.commit).toBe(TEST_PRODUCT_INFO.commit);
        expect(info.arch).toBe("x64");
        // 3 dockerExec: uname, test-f, rm
        expect(mockHost.dockerExec).toHaveBeenCalledTimes(3);
        // bootstrap called for busybox + deploy + setup
        expect(mockBootstrapBusybox).toHaveBeenCalledWith("container1", "x64");
        expect(mockDeployTools).toHaveBeenCalledWith("container1");
        expect(mockRunSetup).toHaveBeenCalledWith(
          "container1",
          expect.any(String),
          expect.any(String),
          undefined,
          expect.any(String),
        );
      });

      it("passes kiro auth token to runSetup when adapter provides it", async () => {
        mockReadKiroToken.mockReturnValue('{"token":"mock"}');

        setupExecFileResponses([
          { stdout: "x86_64\n" },
          { stdout: "", stderr: "test failed", exitCode: 1 },
          { stdout: "" }, // rm -rf
        ]);

        await manager.ensureInstalled("container1");

        expect(mockRunSetup).toHaveBeenCalledWith(
          "container1",
          expect.any(String),
          expect.any(String),
          '{"token":"mock"}',
          expect.any(String),
        );
      });

      it("installs on arm64 when binary is not present", async () => {
        setupExecFileResponses([
          { stdout: "aarch64\n" },
          { stdout: "", exitCode: 1 },
          { stdout: "" },
        ]);

        const info = await manager.ensureInstalled("container1");

        expect(info.commit).toBe(TEST_PRODUCT_INFO.commit);
        expect(info.arch).toBe("arm64");
        expect(mockHost.dockerExec).toHaveBeenCalledTimes(3);
        expect(mockBootstrapBusybox).toHaveBeenCalledWith(
          "container1",
          "arm64",
        );
      });

      it("throws when bootstrap busybox fails", async () => {
        setupExecFileResponses([
          { stdout: "x86_64\n" },
          { stdout: "", exitCode: 1 },
          { stdout: "" },
        ]);

        mockBootstrapBusybox.mockRejectedValue(new Error("readFile ENOENT"));

        await expect(manager.ensureInstalled("container1")).rejects.toThrow(
          "readFile ENOENT",
        );

        mockBootstrapBusybox.mockResolvedValue(undefined);
      });

      it("throws when setup script fails", async () => {
        setupExecFileResponses([
          { stdout: "x86_64\n" },
          { stdout: "", exitCode: 1 },
          { stdout: "" },
        ]);

        mockRunSetup.mockRejectedValue(
          new Error("Setup script failed (exit 1): tar: not found"),
        );

        await expect(manager.ensureInstalled("container1")).rejects.toThrow(
          "Setup script failed",
        );

        mockRunSetup.mockResolvedValue({ home: "/root" });
      });
    });

    describe("ensureConnectionToken", () => {
      it("creates a connection token file atomically", async () => {
        setupExecFileResponses([
          // token command returns the UUID
          { stdout: "test-uuid-1234-5678-abcd-ef0123456789\n" },
        ]);

        const token = await manager.ensureConnectionToken("container1");
        expect(token).toBe("test-uuid-1234-5678-abcd-ef0123456789");
      });

      it("uses umask 377 for restrictive permissions", async () => {
        setupExecFileResponses([
          { stdout: "test-uuid-1234-5678-abcd-ef0123456789\n" },
        ]);

        await manager.ensureConnectionToken("container1");

        const callArgs = mockHost.dockerExec.mock.calls[0];
        const args = callArgs[1] as string[];
        const shCmdIndex = args.indexOf("-c");
        const shellCmd = args[shCmdIndex + 1];
        expect(shellCmd).toContain("umask 377");
        expect(shellCmd).toContain("mv -n");
      });

      it("throws when token creation fails", async () => {
        setupExecFileResponses([
          { stdout: "", stderr: "Permission denied", exitCode: 1 },
        ]);

        await expect(
          manager.ensureConnectionToken("container1"),
        ).rejects.toThrow("Failed to create connection token");
      });

      it("throws when token file is empty", async () => {
        setupExecFileResponses([{ stdout: "\n" }]);

        await expect(
          manager.ensureConnectionToken("container1"),
        ).rejects.toThrow("Connection token file is empty");
      });
    });

    describe("start", () => {
      it("starts the server with correct flags and returns info", async () => {
        setupExecFileResponses([
          // detectArch
          { stdout: "x86_64\n" },
          // ensureConnectionToken
          { stdout: "my-connection-token\n" },
          // stop: cat pidFile (no existing server)
          { stdout: "", exitCode: 1 },
          // stop: pgrep fallback (no existing server)
          { stdout: "", exitCode: 1 },
          // nohup start command (background)
          { stdout: "" },
          // waitForPort: cat logFile
          { stdout: "Extension host agent listening on 54321\n" },
        ]);

        const info = await manager.start("container1");

        expect(info.commit).toBe(TEST_PRODUCT_INFO.commit);
        expect(info.arch).toBe("x64");
        expect(info.port).toBe(54321);
        expect(info.connectionToken).toBe("my-connection-token");
      });

      it("uses correct startup command with kiro-reh binary", async () => {
        setupExecFileResponses([
          // detectArch
          { stdout: "x86_64\n" },
          // ensureConnectionToken
          { stdout: "my-token\n" },
          // stop: cat pidFile (no existing server)
          { stdout: "", exitCode: 1 },
          // stop: pgrep fallback (no existing server)
          { stdout: "", exitCode: 1 },
          // nohup start command
          { stdout: "" },
          // waitForPort: cat logFile
          { stdout: "Extension host agent listening on 8080\n" },
        ]);

        await manager.start("container1");

        // The nohup start command is the 5th call (index 4)
        const startCallArgs = mockHost.dockerExec.mock.calls[4];
        const args = startCallArgs[1] as string[];
        const shCmdIndex = args.indexOf("-c");
        expect(shCmdIndex).toBeGreaterThan(-1);
        const shellCmd = args[shCmdIndex + 1];
        expect(shellCmd).toContain("bin/kiro-reh");
        expect(shellCmd).toContain("--host 127.0.0.1");
        expect(shellCmd).toContain("--port 0");
        expect(shellCmd).toContain("--connection-token-file");
        expect(shellCmd).toContain("--server-data-dir");
        expect(shellCmd).toContain("--telemetry-level off");
        expect(shellCmd).toContain("--accept-server-license-terms");
        expect(shellCmd).toContain("--start-server");
      });

      it("does NOT use --socket-path or --without-connection-token", async () => {
        setupExecFileResponses([
          // detectArch
          { stdout: "x86_64\n" },
          // ensureConnectionToken
          { stdout: "my-token\n" },
          // stop: cat pidFile (no existing server)
          { stdout: "", exitCode: 1 },
          // stop: pgrep fallback (no existing server)
          { stdout: "", exitCode: 1 },
          // nohup start command
          { stdout: "" },
          // waitForPort: cat logFile
          { stdout: "Extension host agent listening on 9000\n" },
        ]);

        await manager.start("container1");

        const startCallArgs = mockHost.dockerExec.mock.calls[4];
        const args = startCallArgs[1] as string[];
        const shCmdIndex = args.indexOf("-c");
        const shellCmd = args[shCmdIndex + 1];
        expect(shellCmd).not.toContain("--socket-path");
        expect(shellCmd).not.toContain("--without-connection-token");
      });

      it("starts the server on arm64", async () => {
        setupExecFileResponses([
          // detectArch
          { stdout: "aarch64\n" },
          // ensureConnectionToken
          { stdout: "arm-token\n" },
          // stop: cat pidFile (no existing server)
          { stdout: "", exitCode: 1 },
          // stop: pgrep fallback (no existing server)
          { stdout: "", exitCode: 1 },
          // nohup start command
          { stdout: "" },
          // waitForPort: cat logFile
          { stdout: "Extension host agent listening on 3000\n" },
        ]);

        const info = await manager.start("container1");
        expect(info.arch).toBe("arm64");
        expect(info.port).toBe(3000);
      });

      it("throws when start command fails", async () => {
        setupExecFileResponses([
          // detectArch
          { stdout: "x86_64\n" },
          // ensureConnectionToken
          { stdout: "my-token\n" },
          // stop: cat pidFile (no existing server)
          { stdout: "", exitCode: 1 },
          // stop: pgrep fallback (no existing server)
          { stdout: "", exitCode: 1 },
          // nohup start fails
          { stdout: "", stderr: "No such file or directory", exitCode: 127 },
        ]);

        await expect(manager.start("container1")).rejects.toThrow(
          "Failed to start server",
        );
      });

      it("uses default telemetry level of off", async () => {
        setupExecFileResponses([
          // detectArch
          { stdout: "x86_64\n" },
          // ensureConnectionToken
          { stdout: "my-token\n" },
          // stop: cat pidFile (no existing server)
          { stdout: "", exitCode: 1 },
          // stop: pgrep fallback (no existing server)
          { stdout: "", exitCode: 1 },
          // nohup start command
          { stdout: "" },
          // waitForPort: cat logFile
          { stdout: "Extension host agent listening on 5000\n" },
        ]);

        await manager.start("container1");

        const startCallArgs = mockHost.dockerExec.mock.calls[4];
        const args = startCallArgs[1] as string[];
        const shCmdIndex = args.indexOf("-c");
        const shellCmd = args[shCmdIndex + 1];
        expect(shellCmd).toContain("--telemetry-level off");
      });

      it("throws when server does not announce port", async () => {
        setupExecFileResponses([
          // detectArch
          { stdout: "x86_64\n" },
          // ensureConnectionToken
          { stdout: "my-token\n" },
          // stop: cat pidFile (no existing server)
          { stdout: "", exitCode: 1 },
          // stop: pgrep fallback (no existing server)
          { stdout: "", exitCode: 1 },
          // nohup start command
          { stdout: "" },
          // waitForPort: cat logFile (returns error in log)
          { stdout: "Error: EADDRINUSE" },
        ]);

        await expect(manager.start("container1")).rejects.toThrow(
          "Server did not announce a listening port",
        );
      });
    });

    describe("parsePortFromOutput", () => {
      it('parses port from "Extension host agent listening on" line', () => {
        const output =
          "Some startup info\nExtension host agent listening on 54321\nReady";
        expect(manager.parsePortFromOutput(output)).toBe(54321);
      });

      it("returns 0 when no port line found", () => {
        const output = "Some startup info\nServer started\n";
        expect(manager.parsePortFromOutput(output)).toBe(0);
      });

      it('parses port from "listeningOn" format', () => {
        const output = "listeningOn: 12345\n";
        expect(manager.parsePortFromOutput(output)).toBe(12345);
      });
    });

    describe("stop", () => {
      it("stops via PID file when available", async () => {
        setupExecFileResponses([
          // cat pidFile succeeds
          { stdout: "12345\n" },
          // kill succeeds
          { stdout: "" },
          // rm pidFile
          { stdout: "" },
        ]);

        await manager.stop("container1");

        // Verify kill was called with SIGTERM
        const killCallArgs = mockHost.dockerExec.mock.calls[1];
        const args = killCallArgs[1] as string[];
        expect(args).toContain("kill");
        expect(args).toContain("-TERM");
        expect(args).toContain("12345");
      });

      it("falls back to pgrep when PID file missing", async () => {
        setupExecFileResponses([
          // cat pidFile fails
          { stdout: "", exitCode: 1 },
          // pgrep finds PID
          { stdout: "12345\n" },
          // kill succeeds
          { stdout: "" },
        ]);

        await manager.stop("container1");

        // Verify pgrep searched for kiro-reh
        const pgrepCallArgs = mockHost.dockerExec.mock.calls[1];
        const args = pgrepCallArgs[1] as string[];
        expect(args).toContain("pgrep");
        expect(args).toContain("-f");
        expect(args[2]).toContain("kiro-reh");
        expect(args[2]).toContain("--connection-token-file");
      });

      it("handles multiple PIDs from pgrep fallback", async () => {
        setupExecFileResponses([
          // cat pidFile fails
          { stdout: "", exitCode: 1 },
          // pgrep finds multiple PIDs
          { stdout: "12345\n67890\n" },
          // kill first
          { stdout: "" },
          // kill second
          { stdout: "" },
        ]);

        await manager.stop("container1");

        expect(mockHost.dockerExec).toHaveBeenCalledTimes(4);
      });

      it("does nothing when no server process is found", async () => {
        setupExecFileResponses([
          // cat pidFile fails
          { stdout: "", exitCode: 1 },
          // pgrep finds nothing
          { stdout: "", exitCode: 1 },
        ]);

        await manager.stop("container1");

        // Only 2 calls (cat pidFile + pgrep), no kill
        expect(mockHost.dockerExec).toHaveBeenCalledTimes(2);
      });
    });

    describe("getStatus", () => {
      it("returns server info when running", async () => {
        setupExecFileResponses([
          // pgrep finds PID
          { stdout: "12345\n" },
          // detectArch
          { stdout: "x86_64\n" },
        ]);

        const status = await manager.getStatus("container1");

        expect(status).not.toBeNull();
        expect(status!.pid).toBe(12345);
        expect(status!.arch).toBe("x64");
        expect(status!.commit).toBe(TEST_PRODUCT_INFO.commit);
      });

      it("returns null when server is not running", async () => {
        setupExecFileResponses([
          // pgrep finds nothing
          { stdout: "", exitCode: 1 },
        ]);

        const status = await manager.getStatus("container1");
        expect(status).toBeNull();
      });

      it("handles arch detection failure gracefully", async () => {
        setupExecFileResponses([
          // pgrep finds PID
          { stdout: "12345\n" },
          // detectArch fails
          { stdout: "", stderr: "exec failed", exitCode: 1 },
        ]);

        const status = await manager.getStatus("container1");

        expect(status).not.toBeNull();
        expect(status!.arch).toBe("unknown");
        expect(status!.pid).toBe(12345);
      });
    });

    describe("custom host", () => {
      it("routes dockerExec through the host", async () => {
        const customHost = createMockHost();
        customHost.dockerExec.mockResolvedValueOnce({
          exitCode: 0,
          stdout: "x86_64\n",
          stderr: "",
        });
        const customManager = new ServerManager({
          productInfo: TEST_PRODUCT_INFO,
          extensionPath: "/fake/path",
          host: customHost as any,
        });

        await customManager.detectArch("container1");

        expect(customHost.dockerExec).toHaveBeenCalledWith("container1", [
          "uname",
          "-m",
        ]);
      });
    });

    describe("download URL construction", () => {
      it("passes server download URL to bootstrap runSetup", async () => {
        setupExecFileResponses([
          { stdout: "x86_64\n" },
          { stdout: "", stderr: "test failed", exitCode: 1 },
          { stdout: "" }, // rm -rf
        ]);

        await manager.ensureInstalled("container1");

        const url = mockRunSetup.mock.calls[0][1];
        expect(url).toContain(TEST_PRODUCT_INFO.commit);
        expect(url).not.toContain("gitpod-io");
      });
    });

    describe("custom telemetry level", () => {
      it("uses custom telemetry level in start command", async () => {
        const customManager = new ServerManager({
          productInfo: TEST_PRODUCT_INFO,
          telemetryLevel: "error",
          extensionPath: "/fake/path",
          host: mockHost as any,
        });

        setupExecFileResponses([
          // detectArch
          { stdout: "x86_64\n" },
          // ensureConnectionToken
          { stdout: "my-token\n" },
          // stop: cat pidFile (no existing server)
          { stdout: "", exitCode: 1 },
          // stop: pgrep fallback (no existing server)
          { stdout: "", exitCode: 1 },
          // nohup start command
          { stdout: "" },
          // waitForPort: cat logFile
          { stdout: "Extension host agent listening on 5000\n" },
        ]);

        await customManager.start("container1");

        const startCallArgs = mockHost.dockerExec.mock.calls[4];
        const args = startCallArgs[1] as string[];
        const shCmdIndex = args.indexOf("-c");
        const shellCmd = args[shCmdIndex + 1];
        expect(shellCmd).toContain("--telemetry-level error");
      });
    });
  });
});
