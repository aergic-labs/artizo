/*
 * Copyright (c) 2026 Aergic Labs, LLC
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../src/utils/dockerUtils", () => ({
  dockerExec: vi.fn(),
}));

import { CredentialForwarder } from "../../src/credentials/credentialForwarder";

function createMockHost() {
  return {
    dockerExec: vi
      .fn()
      .mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" }),
    dockerPath: "docker",
  };
}

describe("CredentialForwarder", () => {
  let mockHost: ReturnType<typeof createMockHost>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockHost = createMockHost();
  });

  describe("setupGitCredentialHelper", () => {
    it("writes the credential helper script to the container", async () => {
      const forwarder = new CredentialForwarder({ host: mockHost as any });

      await forwarder.setupGitCredentialHelper("test-container");

      // First call writes the script
      expect(mockHost.dockerExec).toHaveBeenCalledWith(
        "test-container",
        expect.arrayContaining([
          "sh",
          "-c",
          expect.stringContaining(
            "cat > /tmp/.kiro-server/artizo-credential-helper.sh",
          ),
        ]),
      );
    });

    it("makes the helper script executable", async () => {
      const forwarder = new CredentialForwarder({ host: mockHost as any });

      await forwarder.setupGitCredentialHelper("test-container");

      expect(mockHost.dockerExec).toHaveBeenCalledWith("test-container", [
        "chmod",
        "+x",
        "/tmp/.kiro-server/artizo-credential-helper.sh",
      ]);
    });

    it("configures git to use the credential helper", async () => {
      const forwarder = new CredentialForwarder({ host: mockHost as any });

      await forwarder.setupGitCredentialHelper("test-container");

      expect(mockHost.dockerExec).toHaveBeenCalledWith("test-container", [
        "git",
        "config",
        "--global",
        "credential.helper",
        "!/tmp/.kiro-server/artizo-credential-helper.sh",
      ]);
    });

    it("routes dockerExec through the host", async () => {
      const customHost = createMockHost();
      const forwarder = new CredentialForwarder({
        host: customHost as any,
      });

      await forwarder.setupGitCredentialHelper("my-container");

      // All calls should go through the host
      for (const call of customHost.dockerExec.mock.calls) {
        expect(call[0]).toBe("my-container");
      }
    });

    it("completes all three setup steps", async () => {
      const forwarder = new CredentialForwarder({ host: mockHost as any });

      await forwarder.setupGitCredentialHelper("test-container");

      // Each step should have been called
      expect(mockHost.dockerExec).toHaveBeenCalledWith(
        "test-container",
        expect.arrayContaining(["sh", "-c"]),
      );
      expect(mockHost.dockerExec).toHaveBeenCalledWith("test-container", [
        "chmod",
        "+x",
        "/tmp/.kiro-server/artizo-credential-helper.sh",
      ]);
      expect(mockHost.dockerExec).toHaveBeenCalledWith(
        "test-container",
        expect.arrayContaining([
          "git",
          "config",
          "--global",
          "credential.helper",
        ]),
      );
    });

    it("helper script contains docker exec callback logic", async () => {
      const forwarder = new CredentialForwarder({ host: mockHost as any });

      await forwarder.setupGitCredentialHelper("test-container");

      const writeCall = mockHost.dockerExec.mock.calls[0];
      const scriptContent = writeCall[1][2]; // The sh -c argument
      expect(scriptContent).toContain("git credential");
      expect(scriptContent).toContain("ARTIZO_HOST_ID");
    });
  });
});
