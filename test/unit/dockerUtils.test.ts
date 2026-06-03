/*
 * Copyright (c) 2026 Aergic Labs, LLC
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, it, expect, vi } from 'vitest';
import { dockerExec, dockerInspect, isContainerRunning } from '../../src/utils/dockerUtils';

// We mock child_process.execFile to avoid needing a real Docker daemon
vi.mock('node:child_process', () => ({
  execFile: vi.fn(),
}));

import { execFile } from 'node:child_process';

const mockExecFile = vi.mocked(execFile);

function setupExecFileMock(stdout: string, stderr = '', exitCode = 0) {
  mockExecFile.mockReset();
  mockExecFile.mockImplementation((_cmd, _args, callback: any) => {
    if (exitCode !== 0) {
      const error: any = new Error('Command failed');
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

describe('dockerUtils', () => {
  describe('dockerExec', () => {
    it('executes a command in a container', async () => {
      setupExecFileMock('hello world\n');
      const result = await dockerExec('container123', ['echo', 'hello world']);
      expect(result.stdout).toBe('hello world\n');
      expect(result.exitCode).toBe(0);
    });

    it('passes user option', async () => {
      setupExecFileMock('');
      await dockerExec('container123', ['ls'], { user: 'root' });
      const callArgs = mockExecFile.mock.calls[0];
      expect(callArgs[1]).toContain('-u');
      expect(callArgs[1]).toContain('root');
    });

    it('passes workdir option', async () => {
      setupExecFileMock('');
      await dockerExec('container123', ['ls'], { workdir: '/app' });
      const callArgs = mockExecFile.mock.calls[0];
      expect(callArgs[1]).toContain('-w');
      expect(callArgs[1]).toContain('/app');
    });

    it('uses custom docker path', async () => {
      setupExecFileMock('');
      await dockerExec('container123', ['ls'], { dockerPath: '/usr/local/bin/docker' });
      const callArgs = mockExecFile.mock.calls[0];
      expect(callArgs[0]).toBe('/usr/local/bin/docker');
    });

    it('returns non-zero exit code on failure', async () => {
      setupExecFileMock('', 'error message', 1);
      const result = await dockerExec('container123', ['false']);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toBe('error message');
    });
  });

  describe('dockerInspect', () => {
    it('parses docker inspect output (array format, matching real Docker)', async () => {
      // Real `docker inspect` returns an array with one element
      const inspectOutput = JSON.stringify([{
        Id: 'abc123def456',
        Name: '/my-container',
        State: { Status: 'running', Running: true, Pid: 1234 },
        Config: {
          Image: 'node:18',
          Labels: { 'devcontainer.local_folder': '/home/user/project' },
          Env: ['NODE_ENV=development'],
          WorkingDir: '/workspace',
        },
        Mounts: [
          { Type: 'bind', Source: '/home/user/project', Destination: '/workspace', Mode: 'rw' },
        ],
        NetworkSettings: {
          Ports: { '3000/tcp': [{ HostIp: '0.0.0.0', HostPort: '3000' }] },
        },
      }]);

      setupExecFileMock(inspectOutput);
      const result = await dockerInspect('my-container');

      expect(result.id).toBe('abc123def456');
      expect(result.name).toBe('my-container');
      expect(result.state.running).toBe(true);
      expect(result.config.image).toBe('node:18');
      expect(result.config.labels['devcontainer.local_folder']).toBe('/home/user/project');
      expect(result.mounts).toHaveLength(1);
      expect(result.mounts[0].destination).toBe('/workspace');
    });

    it('handles plain object format (non-array)', async () => {
      // Some Docker versions or wrappers may return a plain object
      const inspectOutput = JSON.stringify({
        Id: 'plain123',
        Name: '/plain-container',
        State: { Status: 'running', Running: true, Pid: 99 },
        Config: { Image: 'alpine:3.19', Labels: {}, Env: [], WorkingDir: '/app' },
        Mounts: [],
        NetworkSettings: { Ports: {} },
      });

      setupExecFileMock(inspectOutput);
      const result = await dockerInspect('plain-container');

      expect(result.id).toBe('plain123');
      expect(result.name).toBe('plain-container');
    });

    it('throws when docker inspect returns non-zero exit code', async () => {
      setupExecFileMock('', 'No such container: xyz', 1);
      await expect(dockerInspect('xyz')).rejects.toThrow('docker inspect failed');
    });

    it('throws when Docker daemon is not available', async () => {
      setupExecFileMock(
        '',
        'Cannot connect to the Docker daemon. Is the docker daemon running?',
        1
      );
      await expect(dockerInspect('any-container')).rejects.toThrow('docker inspect failed');
    });

    it('strips leading slash from container name', async () => {
      const inspectOutput = JSON.stringify([{
        Id: 'abc',
        Name: '/my-container',
        State: { Status: 'running', Running: true, Pid: 1 },
        Config: { Image: 'node:18', Labels: {}, Env: [], WorkingDir: '' },
        Mounts: [],
        NetworkSettings: { Ports: {} },
      }]);

      setupExecFileMock(inspectOutput);
      const result = await dockerInspect('my-container');

      expect(result.name).toBe('my-container');
    });
  });

  describe('isContainerRunning', () => {
    it('returns true for running container', async () => {
      const inspectOutput = JSON.stringify([{
        Id: 'abc123',
        Name: '/test',
        State: { Status: 'running', Running: true, Pid: 100 },
        Config: { Image: 'node:18', Labels: {}, Env: [], WorkingDir: '' },
        Mounts: [],
        NetworkSettings: { Ports: {} },
      }]);
      setupExecFileMock(inspectOutput);
      expect(await isContainerRunning('test')).toBe(true);
    });

    it('returns false for stopped container', async () => {
      const inspectOutput = JSON.stringify([{
        Id: 'abc123',
        Name: '/test',
        State: { Status: 'exited', Running: false, Pid: 0 },
        Config: { Image: 'node:18', Labels: {}, Env: [], WorkingDir: '' },
        Mounts: [],
        NetworkSettings: { Ports: {} },
      }]);
      setupExecFileMock(inspectOutput);
      expect(await isContainerRunning('test')).toBe(false);
    });

    it('returns false when docker inspect fails', async () => {
      mockExecFile.mockImplementation((_cmd, _args, callback: any) => {
        callback(new Error('No such container'), '', '');
        return {} as any;
      });
      expect(await isContainerRunning('nonexistent')).toBe(false);
    });

    it('returns false when Docker daemon is unavailable', async () => {
      mockExecFile.mockImplementation((_cmd, _args, callback: any) => {
        const error: any = new Error('Cannot connect to Docker daemon');
        error.code = 1;
        error.stderr = 'Cannot connect to the Docker daemon';
        callback(error, '', 'Cannot connect to the Docker daemon');
        return {} as any;
      });
      expect(await isContainerRunning('any')).toBe(false);
    });
  });
});