/*
 * Copyright (c) 2026 Aergic Labs, LLC
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../src/utils/dockerUtils", () => ({
  dockerExec: vi.fn(),
}));

import { dockerExec } from "../../src/utils/dockerUtils";
import { CredentialForwarder } from "../../src/credentials/credentialForwarder";

const mockDockerExec = vi.mocked(dockerExec);

describe("CredentialForwarder", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDockerExec.mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" });
  });

  describe("setupGitCredentialHelper", () => {
    it("writes the credential helper script to the container", async () => {
      const forwarder = new CredentialForwarder();

      await forwarder.setupGitCredentialHelper("test-container");

      // First call writes the script
      expect(mockDockerExec).toHaveBeenCalledWith(
        "test-container",
        expect.arrayContaining([
          "sh",
          "-c",
          expect.stringContaining(
            "cat > /tmp/.kiro-server/artizo-credential-helper.sh",
          ),
        ]),
        expect.objectContaining({ dockerPath: "docker" }),
      );
    });

    it("makes the helper script executable", async () => {
      const forwarder = new CredentialForwarder();

      await forwarder.setupGitCredentialHelper("test-container");

      expect(mockDockerExec).toHaveBeenCalledWith(
        "test-container",
        ["chmod", "+x", "/tmp/.kiro-server/artizo-credential-helper.sh"],
        expect.objectContaining({ dockerPath: "docker" }),
      );
    });

    it("configures git to use the credential helper", async () => {
      const forwarder = new CredentialForwarder();

      await forwarder.setupGitCredentialHelper("test-container");

      expect(mockDockerExec).toHaveBeenCalledWith(
        "test-container",
        [
          "git",
          "config",
          "--global",
          "credential.helper",
          "!/tmp/.kiro-server/artizo-credential-helper.sh",
        ],
        expect.objectContaining({ dockerPath: "docker" }),
      );
    });

    it("uses custom docker path when provided", async () => {
      const forwarder = new CredentialForwarder({
        dockerPath: "/usr/local/bin/docker",
      });

      await forwarder.setupGitCredentialHelper("my-container");

      // All calls should use the custom docker path
      for (const call of mockDockerExec.mock.calls) {
        expect(call[2]).toEqual(
          expect.objectContaining({ dockerPath: "/usr/local/bin/docker" }),
        );
      }
    });

    it("completes all three setup steps", async () => {
      const forwarder = new CredentialForwarder();

      await forwarder.setupGitCredentialHelper("test-container");

      // Each step should have been called
      expect(mockDockerExec).toHaveBeenCalledWith(
        "test-container",
        expect.arrayContaining(["sh", "-c"]),
        expect.anything(),
      );
      expect(mockDockerExec).toHaveBeenCalledWith(
        "test-container",
        ["chmod", "+x", "/tmp/.kiro-server/artizo-credential-helper.sh"],
        expect.anything(),
      );
      expect(mockDockerExec).toHaveBeenCalledWith(
        "test-container",
        expect.arrayContaining([
          "git",
          "config",
          "--global",
          "credential.helper",
        ]),
        expect.anything(),
      );
    });

    it("helper script contains docker exec callback logic", async () => {
      const forwarder = new CredentialForwarder();

      await forwarder.setupGitCredentialHelper("test-container");

      const writeCall = mockDockerExec.mock.calls[0];
      const scriptContent = writeCall[1][2]; // The sh -c argument
      expect(scriptContent).toContain("git credential");
      expect(scriptContent).toContain("ARTIZO_HOST_ID");
    });
  });
});