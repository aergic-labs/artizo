/*
 * Copyright (c) 2026 Aergic Labs, LLC
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import vscodeMock from "../__mocks__/vscode";

vi.mock("vscode", () => ({ default: vscodeMock, ...vscodeMock }));

import * as fc from "fast-check";

/**
 * Preservation property tests. These verify current behavior that must not
 * regress through future changes.
 */

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
import { validateArch } from "../../src/remote/serverManager";

// Property 2.1: Container lookup by label
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

// Property 2.2: Container lookup by ID
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
            // With no serverManager injected, resolveContainerById falls back
            // to host=containerId, port=0. The production path injects a
            // serverManager and returns 127.0.0.1 + a forwarded port + token
            // (see bugCondition.property.test.ts property 1.3).
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

// Property 2.4: Architecture mapping
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

// Property 2.5 (Skip-if-installed / versionsMatch) was removed: the
// version-comparison design it covered was superseded by binary-presence
// detection, so there is no live behavior left to assert.