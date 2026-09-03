/*
 * Copyright (c) 2026 Aergic Labs, LLC
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../src/utils/logger", () => ({
  getLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import {
  ExtensionInstaller,
  DEFAULT_EXTENSIONS_INSTALL_PATH,
} from "../../src/extensions/extensionInstaller";

vi.mock("node:child_process", () => ({
  execFile: vi.fn(),
  spawn: vi.fn(),
}));

// Mock tar.ts so tests don't touch the host filesystem. tarDirectory is
// used by the streaming copy path; createTar is unused here but exported
// by the module so vitest requires it in the mock factory.
vi.mock("../../src/utils/tar", () => ({
  tarDirectory: vi.fn(() => Buffer.from("mock-tar")),
  createTar: vi.fn(() => Buffer.from("mock-tar")),
}));

vi.mock("node:fs", () => ({
  unlinkSync: vi.fn(),
  createWriteStream: vi.fn(() => ({
    on: vi.fn((event: string, cb: () => void) => {
      if (event === "close") cb();
      return this;
    }),
    pipe: vi.fn(),
  })),
  unlink: vi.fn(),
  writeFileSync: vi.fn(),
  mkdirSync: vi.fn(),
  rmSync: vi.fn(),
}));

// Mock yauzl so tests don't need real ZIP files.
// Simulates immediate extraction with no entries.
vi.mock("yauzl", () => ({
  open: vi.fn(
    (
      _vsixPath: string,
      _opts: unknown,
      cb: (err: Error | null, zipfile: unknown) => void,
    ) => {
      const zipfile = {
        on: vi.fn((event: string, cb: () => void) => {
          if (event === "end") {
            // Fire end on next tick so entry handlers register first
            setTimeout(cb, 0);
          }
          return zipfile;
        }),
        readEntry: vi.fn(),
      };
      cb(null, zipfile);
    },
  ),
}));

import { execFile, spawn } from "node:child_process";
import { PassThrough, EventEmitter } from "node:stream";

const mockExecFile = vi.mocked(execFile);
const mockSpawn = vi.mocked(spawn);

/**
 * Build a fake ChildProcess for the streaming copy/write path. The
 * extension installer streams a tar buffer (or JSON) to `docker exec -i`
 * stdin and waits on the `close` event for the exit code.
 */
function createMockSpawnChild(opts: { exitCode?: number; stderr?: string } = {}) {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const child = new EventEmitter();
  (child as any).stdin = stdin;
  (child as any).stdout = stdout;
  (child as any).stderr = stderr;
  if (opts.stderr) stderr.write(Buffer.from(opts.stderr));
  setTimeout(() => child.emit("close", opts.exitCode ?? 0), 0);
  return child as unknown as import("node:child_process").ChildProcess;
}

/**
 * Configure sequential spawn responses (exit code + stderr) for the
 * streaming `docker exec -i` calls. Unconfigured trailing calls succeed.
 */
function setupSpawnResponses(
  responses: Array<{ exitCode?: number; stderr?: string }>,
) {
  let i = 0;
  mockSpawn.mockImplementation(() => {
    const r = responses[i++] ?? { exitCode: 0 };
    return createMockSpawnChild(r);
  });
}

function createMockHost() {
  return {
    dockerExec: vi
      .fn()
      .mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" }),
    dockerPath: "docker",
  };
}

/**
 * Configures the mock host's dockerExec to delegate to the mocked execFile.
 * This preserves the sequential-response pattern used in existing tests.
 */
function wireHostToExecFile(mockHost: ReturnType<typeof createMockHost>) {
  mockHost.dockerExec.mockImplementation(
    (containerId: string, command: string[], options?: any) => {
      const args = ["exec"];
      if (options?.user) args.push("-u", options.user);
      if (options?.workdir) args.push("-w", options.workdir);
      args.push(containerId, ...command);
      return new Promise((resolve) => {
        mockExecFile(
          "docker",
          args,
          (error: any, stdout: string, stderr: string) => {
            if (error) {
              resolve({
                exitCode: error.status ?? error.code ?? 1,
                stdout: error.stdout ?? stdout ?? "",
                stderr: error.stderr ?? stderr ?? "",
              });
            } else {
              resolve({
                exitCode: 0,
                stdout: stdout ?? "",
                stderr: stderr ?? "",
              });
            }
          },
        );
      });
    },
  );
}

type ExecFileCallback = (error: any, stdout: string, stderr: string) => void;

/**
 * Helper to set up sequential mock responses for execFile.
 */
function setupExecFileResponses(
  responses: Array<{ stdout: string; stderr?: string; exitCode?: number }>,
) {
  mockExecFile.mockReset();
  let callIndex = 0;

  mockExecFile.mockImplementation((_cmd, _args, ...rest) => {
    const response = responses[callIndex] ?? {
      stdout: "",
      stderr: "",
      exitCode: 1,
    };
    callIndex++;

    const callback: ExecFileCallback =
      typeof rest[0] === "function"
        ? (rest[0] as ExecFileCallback)
        : (rest[1] as ExecFileCallback);

    const { stdout, stderr = "", exitCode = 0 } = response;

    if (exitCode !== 0) {
      const error: any = new Error("Command failed");
      error.stdout = stdout;
      error.stderr = stderr;
      error.code = exitCode;
      callback(error, stdout, stderr);
    } else {
      callback(null, stdout, stderr);
    }

    return {} as any;
  });
}

describe("extensionInstaller", () => {
  describe("EXTENSIONS_INSTALL_PATH", () => {
    it("points to the artizo-server extensions directory", () => {
      expect(DEFAULT_EXTENSIONS_INSTALL_PATH).toBe(
        "~/.artizo-server/extensions",
      );
    });
  });

  describe("ExtensionInstaller", () => {
    let installer: ExtensionInstaller;
    let mockHttpGet: ReturnType<typeof vi.fn<(url: string) => Promise<string>>>;
    let mockHttpDownload: ReturnType<
      typeof vi.fn<(url: string, destPath: string) => Promise<void>>
    >;
    let mockHost: ReturnType<typeof createMockHost>;

    beforeEach(() => {
      mockExecFile.mockReset();
      mockSpawn.mockReset();
      // Default: all streaming `docker exec -i` calls succeed.
      setupSpawnResponses([]);
      mockHttpGet = vi.fn();
      mockHttpDownload = vi.fn();
      mockHost = createMockHost();

      wireHostToExecFile(mockHost);

      installer = new ExtensionInstaller({
        marketplaceOptions: {
          httpGet: mockHttpGet,
          httpDownload: mockHttpDownload,
        },
        host: mockHost as any,
        extensionsDir: "/tmp/test-extensions",
      });
    });

    describe("installFromConfig", () => {
      it("returns empty array when no extensions in config", async () => {
        const config = { image: "node:18" };
        const results = await installer.installFromConfig("container1", config);
        expect(results).toEqual([]);
      });

      it("extracts and installs extensions from config", async () => {
        const config = {
          customizations: {
            vscode: {
              extensions: ["pub.ext1"],
            },
          },
        };

        // Mock marketplace response
        mockHttpGet.mockResolvedValue(
          JSON.stringify({
            version: "1.0.0",
            files: { download: "https://example.com/pub.ext1-1.0.0.vsix" },
          }),
        );
        mockHttpDownload.mockResolvedValue(undefined);

        // Mock docker exec / spawn calls:
        // 1. mkdir -p extensions dir (dockerExec -> execFile)
        // 2. mkdir -p destination ext folder (dockerExec -> execFile)
        // 3. stream tar -xC (spawn)
        // 4. cat extensions.json - not found (dockerExec -> execFile)
        // 5. stream cat > extensions.json (spawn)
        setupExecFileResponses([
          { stdout: "" }, // mkdir -p extensions dir (dockerExec)
          { stdout: "" }, // mkdir -p destination ext folder (dockerExec)
          { stdout: "", exitCode: 1 }, // cat extensions.json - not found (dockerExec)
        ]);

        const results = await installer.installFromConfig("container1", config);

        expect(results).toHaveLength(1);
        expect(results[0].id).toBe("pub.ext1");
        expect(results[0].success).toBe(true);
      });
    });

    describe("installExtensions", () => {
      it("returns empty array for empty extension list", async () => {
        const results = await installer.installExtensions("container1", []);
        expect(results).toEqual([]);
      });

      it("replaces a stale registration when the installed version differs (version drift)", async () => {
        mockHttpGet.mockResolvedValue(
          JSON.stringify({
            version: "2.0.0",
            files: { download: "https://example.com/ext.vsix" },
          }),
        );
        mockHttpDownload.mockResolvedValue(undefined);

        // Existing extensions.json: same id, older version folder.
        const existing = [
          {
            identifier: { id: "pub.ext" },
            version: "1.0.0",
            location: {
              $mid: 1,
              path: "/tmp/test-extensions/pub.ext-1.0.0",
              scheme: "file",
            },
            relativeLocation: "pub.ext-1.0.0",
            metadata: {},
          },
        ];
        setupExecFileResponses([
          { stdout: "" }, // mkdir -p extensions dir (dockerExec)
          { stdout: "" }, // mkdir -p destination ext folder (dockerExec)
          { stdout: JSON.stringify(existing) }, // cat extensions.json -> existing
        ]);

        // Capture what each spawn writes to stdin, in spawn-call order
        // ('data' fires synchronously on write; 'finish' timing is not
        // reliable in the mock). The extensions.json write is the capture
        // that parses as a JSON array.
        const captures: string[] = [];
        mockSpawn.mockImplementation(() => {
          const child = createMockSpawnChild({});
          captures.push("");
          const idx = captures.length - 1;
          child.stdin.on("data", (c: Buffer) => {
            captures[idx] += c.toString();
          });
          return child;
        });

        const results = await installer.installExtensions("container1", [
          "pub.ext",
        ]);

        expect(results[0].success).toBe(true);
        // Spawn call order is deterministic: [0] = tar copy, [1] = the
        // extensions.json write.
        const written = JSON.parse(captures[1]);
        expect(written).toHaveLength(1);
        expect(written[0].relativeLocation).toBe("pub.ext-2.0.0");
        expect(written[0].version).toBe("2.0.0");
      });

      it("sends install lines to the progress sink (dual-write)", async () => {
        mockHttpGet.mockResolvedValue(
          JSON.stringify({
            version: "1.0.0",
            files: { download: "https://example.com/download.vsix" },
          }),
        );
        mockHttpDownload.mockResolvedValue(undefined);

        setupExecFileResponses([
          { stdout: "" }, // mkdir -p extensions dir (dockerExec)
          { stdout: "" }, // mkdir -p destination ext folder (dockerExec)
          { stdout: "", exitCode: 1 }, // cat extensions.json - not found (dockerExec)
        ]);

        const onLog = vi.fn();
        const results = await installer.installExtensions(
          "container1",
          ["pub.ext"],
          undefined,
          onLog,
        );

        expect(results[0].success).toBe(true);
        const lines = onLog.mock.calls.map((c: unknown[]) => c[0] as string);
        expect(lines).toEqual([
          "[extensions] extensions dir: /tmp/test-extensions",
          "[extensions] installing 1 extensions: pub.ext",
          "[extensions] pub.ext: downloading VSIX (version 1.0.0)",
          expect.stringContaining(
            "[extensions] pub.ext: installed (downloaded v1.0.0 to",
          ),
        ]);
      });

      it("installs a single extension successfully", async () => {
        mockHttpGet.mockResolvedValue(
          JSON.stringify({
            version: "2.0.0",
            files: { download: "https://example.com/download.vsix" },
          }),
        );
        mockHttpDownload.mockResolvedValue(undefined);

        setupExecFileResponses([
          { stdout: "" }, // mkdir -p extensions dir (dockerExec)
          { stdout: "" }, // mkdir -p destination ext folder (dockerExec)
          { stdout: "", exitCode: 1 }, // cat extensions.json - not found (dockerExec)
        ]);

        const results = await installer.installExtensions("container1", [
          "pub.ext",
        ]);

        expect(results).toHaveLength(1);
        expect(results[0]).toEqual({ id: "pub.ext", success: true });
      });

      it("reports failure when marketplace fetch fails", async () => {
        mockHttpGet.mockRejectedValue(new Error("HTTP 404 for url"));

        setupExecFileResponses([
          { stdout: "" }, // mkdir -p extensions dir
        ]);

        const results = await installer.installExtensions("container1", [
          "bad.ext",
        ]);

        expect(results).toHaveLength(1);
        expect(results[0].id).toBe("bad.ext");
        expect(results[0].success).toBe(false);
        expect(results[0].error).toContain("HTTP 404");
      });

      it("reports failure when streaming copy to container fails", async () => {
        mockHttpGet.mockResolvedValue(
          JSON.stringify({
            version: "1.0.0",
            files: { download: "https://example.com/download.vsix" },
          }),
        );
        mockHttpDownload.mockResolvedValue(undefined);

        // First streaming `docker exec -i tar -xC` fails.
        setupSpawnResponses([
          { exitCode: 1, stderr: "No such container" },
        ]);
        setupExecFileResponses([
          { stdout: "" }, // mkdir -p extensions dir (dockerExec)
          { stdout: "" }, // mkdir -p destination ext folder (dockerExec)
        ]);

        const results = await installer.installExtensions("container1", [
          "pub.ext",
        ]);

        expect(results).toHaveLength(1);
        expect(results[0].success).toBe(false);
        expect(results[0].error).toContain(
          "Failed to copy extension to container",
        );
      });

      it("installs multiple extensions and reports individual results", async () => {
        // good.ext succeeds, bad.ext fails at marketplace.
        // Use URL-based mock because getExtensionInfo is called twice
        // per extension (resolution + downloadVsix).
        mockHttpGet.mockImplementation((url: string) => {
          if (url.includes("/good/ext")) {
            return Promise.resolve(
              JSON.stringify({
                version: "1.0.0",
                files: { download: "https://example.com/good.vsix" },
              }),
            );
          }
          return Promise.reject(new Error("Not found"));
        });

        mockHttpDownload.mockResolvedValue(undefined);

        setupExecFileResponses([
          { stdout: "" }, // mkdir -p extensions dir (dockerExec)
          { stdout: "" }, // mkdir -p destination ext folder, good.ext (dockerExec)
          { stdout: "", exitCode: 1 }, // cat extensions.json - not found (dockerExec)
        ]);

        const results = await installer.installExtensions("container1", [
          "good.ext",
          "bad.ext",
        ]);

        expect(results).toHaveLength(2);
        expect(results[0]).toEqual({ id: "good.ext", success: true });
        expect(results[1].id).toBe("bad.ext");
        expect(results[1].success).toBe(false);
      });

      it("throws when extensions directory creation fails", async () => {
        mockHttpGet.mockResolvedValue(
          JSON.stringify({
            version: "1.0.0",
            files: { download: "https://example.com/download.vsix" },
          }),
        );

        setupExecFileResponses([
          { stdout: "", stderr: "Permission denied", exitCode: 1 }, // mkdir fails (dockerExec)
        ]);

        await expect(
          installer.installExtensions("container1", ["pub.ext"]),
        ).rejects.toThrow("Failed to create extensions directory");
      });
    });

    describe("dependency resolution", () => {
      // Helper: mock httpGet to return different metadata based on the
      // extension ID in the URL. getExtensionInfo is called twice per
      // extension (once during tree resolution, once during downloadVsix),
      // so a simple mockResolvedValueOnce won't work.
      function mockMetadataById(exts: Record<string, any>) {
        mockHttpGet.mockImplementation((url: string) => {
          for (const [id, data] of Object.entries(exts)) {
            const [ns, name] = id.split(".");
            if (url.includes(`/${ns}/${name}`)) {
              return Promise.resolve(JSON.stringify(data));
            }
          }
          return Promise.reject(new Error(`Unexpected URL: ${url}`));
        });
      }

      it("resolves and installs dependencies before dependents", async () => {
        // pub.parent depends on pub.child
        mockMetadataById({
          "pub.parent": {
            version: "1.0.0",
            files: { download: "https://example.com/parent.vsix" },
            dependencies: [{ namespace: "pub", extension: "child" }],
          },
          "pub.child": {
            version: "1.0.0",
            files: { download: "https://example.com/child.vsix" },
          },
        });
        mockHttpDownload.mockResolvedValue(undefined);

        setupExecFileResponses([
          { stdout: "" }, // mkdir -p extensions dir (dockerExec)
          { stdout: "" }, // mkdir -p dest, pub.child (dockerExec)
          { stdout: "", exitCode: 1 }, // cat extensions.json - child
          { stdout: "" }, // mkdir -p dest, pub.parent (dockerExec)
          { stdout: "", exitCode: 1 }, // cat extensions.json - parent
        ]);

        const results = await installer.installExtensions("container1", [
          "pub.parent",
        ]);

        expect(results).toHaveLength(2);
        // Child should be installed first (dependency-first order)
        expect(results[0].id).toBe("pub.child");
        expect(results[0].success).toBe(true);
        expect(results[1].id).toBe("pub.parent");
        expect(results[1].success).toBe(true);
      });

      it("resolves extension packs (bundledExtensions)", async () => {
        // pub.pack bundles pub.bundled
        mockMetadataById({
          "pub.pack": {
            version: "1.0.0",
            files: { download: "https://example.com/pack.vsix" },
            bundledExtensions: [{ namespace: "pub", extension: "bundled" }],
          },
          "pub.bundled": {
            version: "1.0.0",
            files: { download: "https://example.com/bundled.vsix" },
          },
        });
        mockHttpDownload.mockResolvedValue(undefined);

        setupExecFileResponses([
          { stdout: "" }, // mkdir -p extensions dir (dockerExec)
          { stdout: "" }, // mkdir -p dest, pub.bundled (dockerExec)
          { stdout: "", exitCode: 1 }, // cat extensions.json - bundled
          { stdout: "" }, // mkdir -p dest, pub.pack (dockerExec)
          { stdout: "", exitCode: 1 }, // cat extensions.json - pack
        ]);

        const results = await installer.installExtensions("container1", [
          "pub.pack",
        ]);

        expect(results).toHaveLength(2);
        // Bundled ext installed first, then the pack
        expect(results[0].id).toBe("pub.bundled");
        expect(results[1].id).toBe("pub.pack");
      });

      it("deduplicates when same extension appears multiple times", async () => {
        // pub.a depends on pub.shared; pub.b also depends on pub.shared
        mockMetadataById({
          "pub.a": {
            version: "1.0.0",
            files: { download: "https://example.com/a.vsix" },
            dependencies: [{ namespace: "pub", extension: "shared" }],
          },
          "pub.b": {
            version: "1.0.0",
            files: { download: "https://example.com/b.vsix" },
            dependencies: [{ namespace: "pub", extension: "shared" }],
          },
          "pub.shared": {
            version: "1.0.0",
            files: { download: "https://example.com/shared.vsix" },
          },
        });
        mockHttpDownload.mockResolvedValue(undefined);

        setupExecFileResponses([
          { stdout: "" }, // mkdir -p extensions dir (dockerExec)
          { stdout: "" }, // mkdir -p dest, pub.shared (dockerExec)
          { stdout: "", exitCode: 1 }, // cat extensions.json - shared
          { stdout: "" }, // mkdir -p dest, pub.a (dockerExec)
          { stdout: "", exitCode: 1 }, // cat extensions.json - a
          { stdout: "" }, // mkdir -p dest, pub.b (dockerExec)
          { stdout: "", exitCode: 1 }, // cat extensions.json - b
        ]);

        const results = await installer.installExtensions("container1", [
          "pub.a",
          "pub.b",
        ]);

        // shared should appear only once
        const sharedResults = results.filter((r) => r.id === "pub.shared");
        expect(sharedResults).toHaveLength(1);
        expect(results).toHaveLength(3);
      });

      it("handles circular dependencies without infinite loop", async () => {
        // pub.x depends on pub.y, pub.y depends on pub.x (cycle)
        mockMetadataById({
          "pub.x": {
            version: "1.0.0",
            files: { download: "https://example.com/x.vsix" },
            dependencies: [{ namespace: "pub", extension: "y" }],
          },
          "pub.y": {
            version: "1.0.0",
            files: { download: "https://example.com/y.vsix" },
            dependencies: [{ namespace: "pub", extension: "x" }],
          },
        });
        mockHttpDownload.mockResolvedValue(undefined);

        setupExecFileResponses([
          { stdout: "" }, // mkdir -p extensions dir (dockerExec)
          { stdout: "" }, // mkdir -p dest, pub.x (dockerExec)
          { stdout: "", exitCode: 1 }, // cat extensions.json - x
          { stdout: "" }, // mkdir -p dest, pub.y (dockerExec)
          { stdout: "", exitCode: 1 }, // cat extensions.json - y
        ]);

        const results = await installer.installExtensions("container1", [
          "pub.x",
        ]);

        // Both should install without hanging
        expect(results).toHaveLength(2);
        expect(results.every((r) => r.success)).toBe(true);
      });
    });

    describe("custom host", () => {
      it("routes dockerExec through the host", async () => {
        const customHost = createMockHost();
        wireHostToExecFile(customHost);
        const customInstaller = new ExtensionInstaller({
          marketplaceOptions: {
            httpGet: mockHttpGet,
            httpDownload: mockHttpDownload,
          },
          host: customHost as any,
          extensionsDir: "/tmp/test-extensions",
        });

        mockHttpGet.mockResolvedValue(
          JSON.stringify({
            version: "1.0.0",
            files: { download: "https://example.com/download.vsix" },
          }),
        );
        mockHttpDownload.mockResolvedValue(undefined);

        setupExecFileResponses([
          { stdout: "" }, // mkdir -p extensions dir (dockerExec)
          { stdout: "" }, // mkdir -p destination ext folder (dockerExec)
          { stdout: "", exitCode: 1 }, // cat extensions.json - not found (dockerExec)
        ]);

        await customInstaller.installExtensions("container1", ["pub.ext"]);

        // Verify mkdir was called through the host (3rd arg is the
        // optional options object, now threaded for remoteUser).
        expect(customHost.dockerExec).toHaveBeenCalledWith(
          "container1",
          expect.arrayContaining(["mkdir"]),
          undefined,
        );
      });
    });

    describe("copy from local", () => {
      it("copies from apex-local when provider returns a path", async () => {
        mockHttpGet.mockResolvedValue(
          JSON.stringify({
            version: "1.0.0",
            files: { download: "https://example.com/download.vsix" },
          }),
        );

        const localInstaller = new ExtensionInstaller({
          marketplaceOptions: {
            httpGet: mockHttpGet,
            httpDownload: mockHttpDownload,
          },
          host: createMockHost() as any,
          extensionsDir: "/tmp/test-extensions",
          localExtensionProvider: () =>
            "/home/user/.vscode/extensions/pub.ext-1.0.0",
        });

        setupExecFileResponses([
          { stdout: "" }, // mkdir -p extensions dir (dockerExec)
          { stdout: "" }, // mkdir -p destination ext folder (dockerExec)
          { stdout: "", exitCode: 1 }, // cat extensions.json - not found (dockerExec)
        ]);

        const results = await localInstaller.installExtensions("container1", [
          "pub.ext",
        ]);

        expect(results).toHaveLength(1);
        expect(results[0].success).toBe(true);
        // httpDownload should not be called (copied from local)
        expect(mockHttpDownload).not.toHaveBeenCalled();
      });
    });

    describe("platform-aware install", () => {
      it("does not inspect image when extensions are universal", async () => {
        // Universal extension: no downloads map, no platform variants.
        mockHttpGet.mockResolvedValue(
          JSON.stringify({
            version: "1.0.0",
            files: { download: "https://example.com/universal.vsix" },
          }),
        );
        mockHttpDownload.mockResolvedValue(undefined);

        const inspectSpy = vi.fn();
        const localInstaller = new ExtensionInstaller({
          marketplaceOptions: {
            httpGet: mockHttpGet,
            httpDownload: mockHttpDownload,
          },
          host: createMockHost() as any,
          extensionsDir: "/tmp/test-extensions",
        });
        // Override resolveTargetPlatform to detect if it's called
        (localInstaller as any).resolveTargetPlatform = inspectSpy;

        setupExecFileResponses([
          { stdout: "" }, // mkdir -p extensions dir (dockerExec)
          { stdout: "" }, // mkdir -p destination ext folder (dockerExec)
          { stdout: "", exitCode: 1 }, // cat extensions.json (dockerExec)
        ]);

        await localInstaller.installExtensions("container1", ["pub.ext"]);

        expect(inspectSpy).not.toHaveBeenCalled();
      });

      it("inspects image and picks platform-specific VSIX", async () => {
        // Platform-specific extension with downloads map
        mockHttpGet.mockResolvedValue(
          JSON.stringify({
            version: "1.0.0",
            files: { download: "https://example.com/default.vsix" },
            targetPlatform: "universal",
            downloads: {
              "linux-x64": "https://example.com/linux-x64.vsix",
              "linux-arm64": "https://example.com/linux-arm64.vsix",
              universal: "https://example.com/default.vsix",
            },
          }),
        );
        mockHttpDownload.mockResolvedValue(undefined);

        const localInstaller = new ExtensionInstaller({
          marketplaceOptions: {
            httpGet: mockHttpGet,
            httpDownload: mockHttpDownload,
          },
          host: createMockHost() as any,
          extensionsDir: "/tmp/test-extensions",
        });
        // Mock resolveTargetPlatform to skip actual docker inspect
        (localInstaller as any).resolveTargetPlatform = vi
          .fn()
          .mockResolvedValue("linux-x64");

        setupExecFileResponses([
          { stdout: "" }, // mkdir -p extensions dir (dockerExec)
          { stdout: "" }, // mkdir -p destination ext folder (dockerExec)
          { stdout: "", exitCode: 1 }, // cat extensions.json (dockerExec)
        ]);

        await localInstaller.installExtensions("container1", ["pub.ext"]);

        // Should have downloaded the linux-x64 VSIX
        expect(mockHttpDownload).toHaveBeenCalledWith(
          "https://example.com/linux-x64.vsix",
          expect.any(String),
        );
      });
    });

    describe("remoteUser threading", () => {
      it("passes -u <remoteUser> to the streaming copy and json-write execs", async () => {
        mockHttpGet.mockResolvedValue(
          JSON.stringify({
            version: "1.0.0",
            files: { download: "https://example.com/download.vsix" },
          }),
        );
        mockHttpDownload.mockResolvedValue(undefined);

        setupExecFileResponses([
          { stdout: "" }, // mkdir -p extensions dir (dockerExec)
          { stdout: "" }, // mkdir -p destination ext folder (dockerExec)
          { stdout: "", exitCode: 1 }, // cat extensions.json - not found
        ]);

        await installer.installExtensions(
          "container1",
          ["pub.ext"],
          "dev",
        );

        // mkdir runs as remoteUser via dockerExec options.user
        expect(mockHost.dockerExec).toHaveBeenCalledWith(
          "container1",
          expect.arrayContaining(["mkdir"]),
          { user: "dev" },
        );

        // Two streaming spawn calls: tar -xC (copy) + cat > (json write).
        // Both must include -u dev in argv.
        expect(mockSpawn).toHaveBeenCalledTimes(2);
        for (const call of mockSpawn.mock.calls) {
          const args = call[1] as string[];
          expect(args).toContain("-u");
          expect(args[args.indexOf("-u") + 1]).toBe("dev");
        }
      });

      it("omits -u when remoteUser is not set", async () => {
        mockHttpGet.mockResolvedValue(
          JSON.stringify({
            version: "1.0.0",
            files: { download: "https://example.com/download.vsix" },
          }),
        );
        mockHttpDownload.mockResolvedValue(undefined);

        setupExecFileResponses([
          { stdout: "" }, // mkdir -p extensions dir
          { stdout: "" }, // mkdir -p destination ext folder
          { stdout: "", exitCode: 1 }, // cat extensions.json - not found
        ]);

        await installer.installExtensions("container1", ["pub.ext"]);

        expect(mockSpawn).toHaveBeenCalledTimes(2);
        for (const call of mockSpawn.mock.calls) {
          const args = call[1] as string[];
          expect(args).not.toContain("-u");
        }
      });
    });
  });
});
