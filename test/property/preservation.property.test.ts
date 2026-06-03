/*
 * Copyright (c) 2026 Aergic Labs, LLC
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("vscode", () => ({
  window: {
    createTerminal: vi
      .fn()
      .mockReturnValue({ show: vi.fn(), dispose: vi.fn() }),
    withProgress: vi.fn(),
  },
  commands: { executeCommand: vi.fn() },
  EventEmitter: vi.fn().mockImplementation(() => ({
    event: vi.fn(),
    fire: vi.fn(),
    dispose: vi.fn(),
  })),
  ProgressLocation: { Notification: 15 },
  Uri: { parse: (s: string) => ({ toString: () => s }) },
  workspace: { workspaceFolders: [{ uri: { fsPath: "/test/workspace" } }] },
}));

import * as fc from "fast-check";

/**
 * Preservation property tests. These verify existing correct behavior
 * that MUST be preserved through the bugfix.
 */

// Mock vscode module (required by authorityResolver.ts)
vi.mock("vscode", () => ({
  Uri: {
    parse: (s: string) => ({ toString: () => s }),
  },
  workspace: {},
  commands: {},
}));

// Mock node:child_process for authorityResolver's internal execFilePromise
const mockExecFile = vi.fn();
vi.mock("node:child_process", () => ({
  execFile: (...args: any[]) => mockExecFile(...args),
}));

// Mock dockerUtils for container inspection
const mockDockerInspect = vi.fn();
const mockExecFilePromise = vi.fn();
vi.mock("../../src/utils/dockerUtils", () => ({
  dockerInspect: (...args: any[]) => mockDockerInspect(...args),
  dockerExec: vi.fn(),
  execFilePromise: (...args: any[]) => mockExecFilePromise(...args),
}));

import { RemoteAuthorityResolver } from "../../src/remote/authorityResolver";
import { encodeAuthority } from "../../src/utils/uriUtils";
import { validateArch, versionsMatch } from "../../src/remote/serverManager";

// ─── Property 2.1: Container lookup by label ────────────────────────────────
// For all container lookups with `devcontainer.local_folder` label,
// the resolver finds the correct container.

describe("Property 2.1: Container lookup by label", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("findContainerByLabel returns the container ID when docker ps outputs a matching ID", async () => {
    await fc.assert(
      fc.asyncProperty(
        // Generate arbitrary workspace paths (non-empty strings without null/newline)
        fc.stringOf(
          fc.oneof(
            fc.char().filter((c) => c !== "\0" && c !== "\n" && c !== "\r"),
            fc.constantFrom("/", "\\", " ", ".", "-", "_"),
          ),
          { minLength: 1, maxLength: 80 },
        ),
        // Generate arbitrary container IDs (hex strings like docker uses)
        fc.hexaString({ minLength: 12, maxLength: 64 }),
        async (workspacePath, containerId) => {
          // Setup mock: docker ps returns the container ID
          mockExecFilePromise.mockResolvedValue({
            exitCode: 0,
            stdout: containerId + "\n",
            stderr: "",
          });

          const resolver = new RemoteAuthorityResolver({
            dockerPath: "docker",
          });
          const result = await resolver.findContainerByLabel(workspacePath);

          expect(result).toBe(containerId);
        },
      ),
      { numRuns: 50 },
    );
  });

  it("findContainerByLabel returns undefined when docker ps returns empty output", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.stringOf(
          fc.char().filter((c) => c !== "\0" && c !== "\n"),
          { minLength: 1, maxLength: 50 },
        ),
        async (workspacePath) => {
          // Setup mock: docker ps returns empty (no matching container)
          mockExecFilePromise.mockResolvedValue({
            exitCode: 0,
            stdout: "",
            stderr: "",
          });

          const resolver = new RemoteAuthorityResolver({
            dockerPath: "docker",
          });
          const result = await resolver.findContainerByLabel(workspacePath);

          expect(result).toBeUndefined();
        },
      ),
      { numRuns: 50 },
    );
  });

  it("findContainerByLabel returns undefined when docker ps fails", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.stringOf(
          fc.char().filter((c) => c !== "\0" && c !== "\n"),
          { minLength: 1, maxLength: 50 },
        ),
        async (workspacePath) => {
          // Setup mock: docker ps fails with an error
          mockExecFilePromise.mockResolvedValue({
            exitCode: 1,
            stdout: "",
            stderr: "docker not found",
          });

          const resolver = new RemoteAuthorityResolver({
            dockerPath: "docker",
          });
          const result = await resolver.findContainerByLabel(workspacePath);

          expect(result).toBeUndefined();
        },
      ),
      { numRuns: 30 },
    );
  });
});

// ─── Property 2.2: Container lookup by ID ───────────────────────────────────
// For all container lookups by container ID, the resolver finds the correct container.

describe("Property 2.2: Container lookup by ID", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("resolving an attached-container authority with a running container succeeds", async () => {
    await fc.assert(
      fc.asyncProperty(
        // Generate container IDs (hex strings)
        fc.hexaString({ minLength: 12, maxLength: 64 }),
        async (containerId) => {
          // Mock dockerInspect to return a running container
          mockDockerInspect.mockResolvedValue({
            id: containerId,
            name: "test-container",
            state: { status: "running", running: true, pid: 1234 },
            config: { image: "ubuntu", labels: {}, env: [], workingDir: "/" },
            mounts: [],
            networkSettings: { ports: {} },
          });

          const resolver = new RemoteAuthorityResolver({
            dockerPath: "docker",
          });
          const authority = encodeAuthority("attached-container", containerId);
          const result = await resolver.resolve(authority);

          expect(result.type).toBe("success");
          if (result.type === "success") {
            // The current (unfixed) code returns host=containerId, port=0
            // This is the EXISTING behavior we're preserving for container lookup
            expect(result.authority.host).toBe(containerId);
            expect(result.authority.port).toBe(0);
          }
        },
      ),
      { numRuns: 50 },
    );
  });

  it("resolving an attached-container authority with a stopped container returns error", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.hexaString({ minLength: 12, maxLength: 64 }),
        async (containerId) => {
          // Mock dockerInspect to return a stopped container
          mockDockerInspect.mockResolvedValue({
            id: containerId,
            name: "stopped-container",
            state: { status: "exited", running: false, pid: 0 },
            config: { image: "ubuntu", labels: {}, env: [], workingDir: "/" },
            mounts: [],
            networkSettings: { ports: {} },
          });

          const resolver = new RemoteAuthorityResolver({
            dockerPath: "docker",
          });
          const authority = encodeAuthority("attached-container", containerId);
          const result = await resolver.resolve(authority);

          expect(result.type).toBe("error");
          if (result.type === "error") {
            expect(result.message).toContain("not running");
          }
        },
      ),
      { numRuns: 50 },
    );
  });
});

// ─── Property 2.4: Architecture mapping ─────────────────────────────────────
// For all architecture strings, mapping produces correct platform identifier.

describe("Property 2.4: Architecture mapping", () => {
  it("x86_64 maps to x64", () => {
    fc.assert(
      fc.property(
        // Generate whitespace padding around x86_64
        fc.tuple(
          fc.stringOf(fc.constantFrom(" ", "\t", "\n", "\r"), {
            minLength: 0,
            maxLength: 3,
          }),
          fc.stringOf(fc.constantFrom(" ", "\t", "\n", "\r"), {
            minLength: 0,
            maxLength: 3,
          }),
        ),
        ([prefix, suffix]) => {
          const result = validateArch(`${prefix}x86_64${suffix}`);
          expect(result).toBe("x64");
        },
      ),
      { numRuns: 50 },
    );
  });

  it("aarch64 maps to arm64", () => {
    fc.assert(
      fc.property(
        fc.tuple(
          fc.stringOf(fc.constantFrom(" ", "\t", "\n", "\r"), {
            minLength: 0,
            maxLength: 3,
          }),
          fc.stringOf(fc.constantFrom(" ", "\t", "\n", "\r"), {
            minLength: 0,
            maxLength: 3,
          }),
        ),
        ([prefix, suffix]) => {
          const result = validateArch(`${prefix}aarch64${suffix}`);
          expect(result).toBe("arm64");
        },
      ),
      { numRuns: 50 },
    );
  });

  it("arm64 maps to arm64", () => {
    fc.assert(
      fc.property(
        fc.tuple(
          fc.stringOf(fc.constantFrom(" ", "\t", "\n", "\r"), {
            minLength: 0,
            maxLength: 3,
          }),
          fc.stringOf(fc.constantFrom(" ", "\t", "\n", "\r"), {
            minLength: 0,
            maxLength: 3,
          }),
        ),
        ([prefix, suffix]) => {
          const result = validateArch(`${prefix}arm64${suffix}`);
          expect(result).toBe("arm64");
        },
      ),
      { numRuns: 50 },
    );
  });

  it("unsupported architectures throw an error", () => {
    fc.assert(
      fc.property(
        fc
          .string({ minLength: 1, maxLength: 20 })
          .filter((s) => !["x86_64", "aarch64", "arm64"].includes(s.trim())),
        (arch) => {
          expect(() => validateArch(arch)).toThrow(/Unsupported architecture/);
        },
      ),
      { numRuns: 100 },
    );
  });
});

// ─── Property 2.5: Skip-if-installed ────────────────────────────────────────
// For all cases where server commit matches installed commit, installation is skipped.

describe("Property 2.5: Skip-if-installed (versionsMatch)", () => {
  it("identical version strings match", () => {
    fc.assert(
      fc.property(fc.string({ minLength: 1, maxLength: 50 }), (version) => {
        expect(versionsMatch(version, version)).toBe(true);
      }),
      { numRuns: 200 },
    );
  });

  it("versions with surrounding whitespace still match", () => {
    fc.assert(
      fc.property(
        fc
          .string({ minLength: 1, maxLength: 50 })
          .filter((s) => s.trim().length > 0),
        fc.tuple(
          fc.stringOf(fc.constantFrom(" ", "\t", "\n", "\r"), {
            minLength: 0,
            maxLength: 3,
          }),
          fc.stringOf(fc.constantFrom(" ", "\t", "\n", "\r"), {
            minLength: 0,
            maxLength: 3,
          }),
        ),
        (version, [prefix, suffix]) => {
          const padded = `${prefix}${version.trim()}${suffix}`;
          expect(versionsMatch(padded, version.trim())).toBe(true);
        },
      ),
      { numRuns: 100 },
    );
  });

  it("different version strings do not match", () => {
    fc.assert(
      fc.property(
        fc
          .string({ minLength: 1, maxLength: 50 })
          .filter((s) => s.trim().length > 0),
        fc
          .string({ minLength: 1, maxLength: 50 })
          .filter((s) => s.trim().length > 0),
        (v1, v2) => {
          fc.pre(v1.trim() !== v2.trim());
          expect(versionsMatch(v1, v2)).toBe(false);
        },
      ),
      { numRuns: 100 },
    );
  });
});