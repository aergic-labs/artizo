/*
 * Copyright (c) 2026 Aergic Labs, LLC
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "node:events";

vi.mock("../../src/utils/dockerUtils", () => ({
  dockerExec: vi.fn(),
  dockerSpawn: vi.fn(),
}));

vi.mock("node:child_process", () => {
  const actual = vi.importActual("node:child_process");
  return {
    ...actual,
    spawn: vi.fn(),
  };
});

vi.mock("node:net", () => {
  const { EventEmitter } = require("node:events");
  return {
    createConnection: vi.fn().mockReturnValue(
      Object.assign(new EventEmitter(), {
        pipe: vi.fn(),
        destroy: vi.fn(),
      }),
    ),
  };
});

import { dockerSpawn } from "../../src/utils/dockerUtils";
import { SshAgentForwarder } from "../../src/credentials/sshAgentForwarder";

const mockDockerSpawn = vi.mocked(dockerSpawn);

function createMockHost() {
  return {
    dockerExec: vi
      .fn()
      .mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" }),
    dockerPath: "docker",
  };
}

function createMockChildProcess() {
  const stdout = Object.assign(new EventEmitter(), {
    pipe: vi.fn().mockReturnThis(),
    resume: vi.fn(),
    removeListener: vi.fn(),
  });
  const stdin = Object.assign(new EventEmitter(), {
    write: vi.fn(),
    end: vi.fn(),
    pipe: vi.fn().mockReturnThis(),
    destroyed: false,
  });
  const stderr = Object.assign(new EventEmitter(), { pipe: vi.fn() });

  const child = Object.assign(new EventEmitter(), {
    stdout,
    stdin,
    stderr,
    kill: vi.fn(),
    pid: 99999,
  });

  // Emit 'spawn' + stdout data with 'READY' on next tick to simulate relay startup
  setImmediate(() => {
    child.emit("spawn");
    setImmediate(() => stdout.emit("data", Buffer.from("READY\n")));
  });

  return child;
}

describe("SshAgentForwarder", () => {
  let mockHost: ReturnType<typeof createMockHost>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockHost = createMockHost();
  });

  describe("setupSshAgentForwarding", () => {
    it("skips gracefully when SSH_AUTH_SOCK is not set", async () => {
      const forwarder = new SshAgentForwarder({
        hostSshAuthSock: undefined,
        host: mockHost as any,
      });

      await forwarder.setupSshAgentForwarding("test-container", "/tmp/.kiro-server");

      expect(mockHost.dockerExec).not.toHaveBeenCalled();
    });

    it("skips gracefully when SSH_AUTH_SOCK is empty string", async () => {
      const forwarder = new SshAgentForwarder({
        hostSshAuthSock: "",
        host: mockHost as any,
      });

      await forwarder.setupSshAgentForwarding("test-container", "/tmp/.kiro-server");

      expect(mockHost.dockerExec).not.toHaveBeenCalled();
    });

    it("sets up SSH_AUTH_SOCK profile script when agent is available", async () => {
      mockDockerSpawn.mockReturnValue(createMockChildProcess() as any);
      const forwarder = new SshAgentForwarder({
        hostSshAuthSock: "/tmp/ssh-agent.sock",
        host: mockHost as any,
      });

      await forwarder.setupSshAgentForwarding("test-container", "/tmp/.kiro-server");

      expect(mockHost.dockerExec).toHaveBeenCalledWith(
        "test-container",
        expect.arrayContaining([
          "sh",
          "-c",
          expect.stringContaining("SSH_AUTH_SOCK"),
        ]),
      );
    });

    it("writes profile script to /etc/profile.d/", async () => {
      mockDockerSpawn.mockReturnValue(createMockChildProcess() as any);
      const forwarder = new SshAgentForwarder({
        hostSshAuthSock: "/tmp/ssh-agent.sock",
        host: mockHost as any,
      });

      await forwarder.setupSshAgentForwarding("test-container", "/tmp/.kiro-server");

      const profileCall = mockHost.dockerExec.mock.calls[0];
      const command = profileCall[1][2]; // sh -c argument
      expect(command).toContain("/etc/profile.d/artizo-ssh.sh");
    });

    it("sets the container SSH_AUTH_SOCK to the expected path", async () => {
      mockDockerSpawn.mockReturnValue(createMockChildProcess() as any);
      const forwarder = new SshAgentForwarder({
        hostSshAuthSock: "/tmp/ssh-agent.sock",
        host: mockHost as any,
      });

      await forwarder.setupSshAgentForwarding("test-container", "/tmp/.kiro-server");

      const profileCall = mockHost.dockerExec.mock.calls[0];
      const command = profileCall[1][2];
      expect(command).toContain("/tmp/artizo-ssh-agent.sock");
    });

    it("configures git core.sshCommand with SSH_AUTH_SOCK", async () => {
      mockDockerSpawn.mockReturnValue(createMockChildProcess() as any);
      const forwarder = new SshAgentForwarder({
        hostSshAuthSock: "/tmp/ssh-agent.sock",
        host: mockHost as any,
      });

      await forwarder.setupSshAgentForwarding("test-container", "/tmp/.kiro-server");

      expect(mockHost.dockerExec).toHaveBeenCalledWith("test-container", [
        "git",
        "config",
        "--global",
        "core.sshCommand",
        expect.stringContaining("SSH_AUTH_SOCK"),
      ]);
    });

    it("routes dockerExec through the host", async () => {
      mockDockerSpawn.mockReturnValue(createMockChildProcess() as any);
      const customHost = createMockHost();
      const forwarder = new SshAgentForwarder({
        hostSshAuthSock: "/tmp/ssh-agent.sock",
        host: customHost as any,
      });

      await forwarder.setupSshAgentForwarding("test-container", "/tmp/.kiro-server");

      for (const call of customHost.dockerExec.mock.calls) {
        expect(call[0]).toBe("test-container");
      }
    });

    it("does not throw when SSH_AUTH_SOCK is not set", async () => {
      const forwarder = new SshAgentForwarder({
        hostSshAuthSock: undefined,
        host: mockHost as any,
      });

      await expect(
        forwarder.setupSshAgentForwarding("test-container", "/tmp/.kiro-server"),
      ).resolves.toBeUndefined();
    });
  });
});
