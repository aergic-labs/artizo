/*
 * Copyright (c) 2026 Aergic Labs, LLC
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';

vi.mock('../../src/utils/dockerUtils', () => ({
  dockerExec: vi.fn(),
  dockerSpawn: vi.fn(),
}));

vi.mock('node:child_process', () => {
  const actual = vi.importActual('node:child_process');
  return {
    ...actual,
    spawn: vi.fn(),
  };
});

vi.mock('node:net', () => {
  const { EventEmitter } = require('node:events');
  return {
    createConnection: vi.fn().mockReturnValue(Object.assign(new EventEmitter(), {
      pipe: vi.fn(),
      destroy: vi.fn(),
    })),
  };
});

import { dockerExec, dockerSpawn } from '../../src/utils/dockerUtils';
import { SshAgentForwarder } from '../../src/credentials/sshAgentForwarder';

const mockDockerExec = vi.mocked(dockerExec);
const mockDockerSpawn = vi.mocked(dockerSpawn);

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
    child.emit('spawn');
    setImmediate(() => stdout.emit('data', Buffer.from('READY\n')));
  });

  return child;
}

describe('SshAgentForwarder', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDockerExec.mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' });
  });

  describe('setupSshAgentForwarding', () => {
    it('skips gracefully when SSH_AUTH_SOCK is not set', async () => {
      const forwarder = new SshAgentForwarder({ hostSshAuthSock: undefined });

      await forwarder.setupSshAgentForwarding('test-container');

      expect(mockDockerExec).not.toHaveBeenCalled();
    });

    it('skips gracefully when SSH_AUTH_SOCK is empty string', async () => {
      const forwarder = new SshAgentForwarder({ hostSshAuthSock: '' });

      await forwarder.setupSshAgentForwarding('test-container');

      expect(mockDockerExec).not.toHaveBeenCalled();
    });

    it('sets up SSH_AUTH_SOCK profile script when agent is available', async () => {
      mockDockerSpawn.mockReturnValue(createMockChildProcess() as any);
      const forwarder = new SshAgentForwarder({
        hostSshAuthSock: '/tmp/ssh-agent.sock',
      });

      await forwarder.setupSshAgentForwarding('test-container');

      expect(mockDockerExec).toHaveBeenCalledWith(
        'test-container',
        expect.arrayContaining(['sh', '-c', expect.stringContaining('SSH_AUTH_SOCK')]),
        expect.objectContaining({ dockerPath: 'docker' })
      );
    });

    it('writes profile script to /etc/profile.d/', async () => {
      mockDockerSpawn.mockReturnValue(createMockChildProcess() as any);
      const forwarder = new SshAgentForwarder({
        hostSshAuthSock: '/tmp/ssh-agent.sock',
      });

      await forwarder.setupSshAgentForwarding('test-container');

      const profileCall = mockDockerExec.mock.calls[0];
      const command = profileCall[1][2]; // sh -c argument
      expect(command).toContain('/etc/profile.d/artizo-ssh.sh');
    });

    it('sets the container SSH_AUTH_SOCK to the expected path', async () => {
      mockDockerSpawn.mockReturnValue(createMockChildProcess() as any);
      const forwarder = new SshAgentForwarder({
        hostSshAuthSock: '/tmp/ssh-agent.sock',
      });

      await forwarder.setupSshAgentForwarding('test-container');

      const profileCall = mockDockerExec.mock.calls[0];
      const command = profileCall[1][2];
      expect(command).toContain('/tmp/artizo-ssh-agent.sock');
    });

    it('configures git core.sshCommand with SSH_AUTH_SOCK', async () => {
      mockDockerSpawn.mockReturnValue(createMockChildProcess() as any);
      const forwarder = new SshAgentForwarder({
        hostSshAuthSock: '/tmp/ssh-agent.sock',
      });

      await forwarder.setupSshAgentForwarding('test-container');

      expect(mockDockerExec).toHaveBeenCalledWith(
        'test-container',
        ['git', 'config', '--global', 'core.sshCommand', expect.stringContaining('SSH_AUTH_SOCK')],
        expect.objectContaining({ dockerPath: 'docker' })
      );
    });

    it('uses custom docker path when provided', async () => {
      mockDockerSpawn.mockReturnValue(createMockChildProcess() as any);
      const forwarder = new SshAgentForwarder({
        dockerPath: '/custom/docker',
        hostSshAuthSock: '/tmp/ssh-agent.sock',
      });

      await forwarder.setupSshAgentForwarding('test-container');

      for (const call of mockDockerExec.mock.calls) {
        expect(call[2]).toEqual(expect.objectContaining({ dockerPath: '/custom/docker' }));
      }
    });

    it('does not throw when SSH_AUTH_SOCK is not set', async () => {
      const forwarder = new SshAgentForwarder({ hostSshAuthSock: undefined });

      await expect(forwarder.setupSshAgentForwarding('test-container')).resolves.toBeUndefined();
    });
  });
});