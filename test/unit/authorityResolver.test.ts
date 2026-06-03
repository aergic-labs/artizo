/*
 * Copyright (c) 2026 Aergic Labs, LLC
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock vscode module
vi.mock('vscode', () => ({
  workspace: {},
  commands: {
    registerCommand: vi.fn().mockReturnValue({ dispose: vi.fn() }),
  },
  Uri: {
    parse: (str: string) => ({ toString: () => str }),
  },
}));

// Mock child_process for docker commands
vi.mock('node:child_process', () => ({
  execFile: vi.fn(),
}));
import { execFile } from 'node:child_process';
import {
  RemoteAuthorityResolver,
  registerAuthorityResolver,
  SCHEME_DEV_CONTAINER,
  SCHEME_ATTACHED_CONTAINER,
} from '../../src/remote/authorityResolver';
import { encodeAuthority } from '../../src/utils/uriUtils';

const mockExecFile = vi.mocked(execFile);

/**
 * Helper to set up execFile mock for docker inspect and docker ps commands.
 */
function setupMockForInspect(containerData: Record<string, unknown>, exitCode = 0) {
  mockExecFile.mockImplementation((_cmd: any, args: any, ...rest: any[]) => {
    const callback = typeof rest[0] === 'function' ? rest[0] : rest[1];
    const argsArray = args as string[];

    if (argsArray[0] === 'inspect') {
      if (exitCode !== 0) {
        const error: any = new Error('Command failed');
        error.code = exitCode;
        error.stdout = '';
        error.stderr = 'No such container';
        callback(error, '', 'No such container');
      } else {
        callback(null, JSON.stringify(containerData), '');
      }
    } else {
      callback(null, '', '');
    }
    return {} as any;
  });
}

function setupMockForPs(containerId: string) {
  mockExecFile.mockImplementation((_cmd: any, args: any, ...rest: any[]) => {
    const callback = typeof rest[0] === 'function' ? rest[0] : rest[1];
    const argsArray = args as string[];

    if (argsArray[0] === 'ps') {
      callback(null, containerId ? `${containerId}\n` : '', '');
    } else if (argsArray[0] === 'inspect') {
      // After finding via ps, inspect is called
      const data = makeContainerData({ Id: containerId });
      callback(null, JSON.stringify(data), '');
    } else {
      callback(null, '', '');
    }
    return {} as any;
  });
}

function makeContainerData(overrides: Record<string, unknown> = {}) {
  return {
    Id: 'abc123def456',
    Name: '/my-container',
    State: { Status: 'running', Running: true, Pid: 1234 },
    Config: {
      Image: 'node:18',
      Labels: { 'devcontainer.local_folder': '/home/user/project' },
      Env: ['NODE_ENV=development'],
      WorkingDir: '/workspace',
    },
    Mounts: [],
    NetworkSettings: { Ports: {} },
    ...overrides,
  };
}

describe('RemoteAuthorityResolver', () => {
  let resolver: RemoteAuthorityResolver;

  beforeEach(() => {
    vi.clearAllMocks();
    resolver = new RemoteAuthorityResolver();
  });

  describe('resolve - attached-container scheme', () => {
    it('resolves a running container by ID', async () => {
      const containerId = 'abc123def456';
      const authority = encodeAuthority(SCHEME_ATTACHED_CONTAINER, containerId);
      const containerData = makeContainerData({ Id: containerId });

      setupMockForInspect(containerData);

      const result = await resolver.resolve(authority);

      expect(result.type).toBe('success');
      if (result.type === 'success') {
        expect(result.authority.host).toBe(containerId);
        expect(result.authority.port).toBe(0);
      }
    });

    it('returns error for a stopped container', async () => {
      const containerId = 'stopped123';
      const authority = encodeAuthority(SCHEME_ATTACHED_CONTAINER, containerId);
      const containerData = makeContainerData({
        Id: containerId,
        State: { Status: 'exited', Running: false, Pid: 0 },
      });

      setupMockForInspect(containerData);

      const result = await resolver.resolve(authority);

      expect(result.type).toBe('error');
      if (result.type === 'error') {
        expect(result.message).toContain('not running');
        expect(result.message).toContain('exited');
      }
    });

    it('returns error when docker inspect fails', async () => {
      const containerId = 'nonexistent';
      const authority = encodeAuthority(SCHEME_ATTACHED_CONTAINER, containerId);

      setupMockForInspect({}, 1);

      const result = await resolver.resolve(authority);

      expect(result.type).toBe('error');
      if (result.type === 'error') {
        expect(result.message).toContain('Failed to inspect container');
      }
    });
  });

  describe('resolve - dev-container scheme', () => {
    it('resolves a dev container by workspace path', async () => {
      const workspacePath = '/home/user/project';
      const authority = encodeAuthority(SCHEME_DEV_CONTAINER, workspacePath);

      setupMockForPs('abc123def456');

      const result = await resolver.resolve(authority);

      expect(result.type).toBe('success');
      if (result.type === 'success') {
        expect(result.authority.host).toBe('abc123def456');
        expect(result.authority.port).toBe(0);
      }
    });

    it('returns error when no container found for workspace', async () => {
      const workspacePath = '/nonexistent/path';
      const authority = encodeAuthority(SCHEME_DEV_CONTAINER, workspacePath);

      // docker ps returns empty
      mockExecFile.mockImplementation((_cmd: any, _args: any, ...rest: any[]) => {
        const callback = typeof rest[0] === 'function' ? rest[0] : rest[1];
        callback(null, '', '');
        return {} as any;
      });

      const result = await resolver.resolve(authority);

      expect(result.type).toBe('error');
      if (result.type === 'error') {
        expect(result.message).toContain('No dev container found');
        expect(result.message).toContain(workspacePath);
      }
    });
  });

  describe('resolve - error cases', () => {
    it('returns error for invalid authority format', async () => {
      const result = await resolver.resolve('invalid-no-plus');

      expect(result.type).toBe('error');
      if (result.type === 'error') {
        expect(result.message).toContain('Failed to decode authority');
      }
    });

    it('returns error for unknown scheme', async () => {
      const authority = encodeAuthority('unknown-scheme', 'some-id');

      const result = await resolver.resolve(authority);

      expect(result.type).toBe('error');
      if (result.type === 'error') {
        expect(result.message).toContain('Unknown authority scheme');
        expect(result.message).toContain('unknown-scheme');
      }
    });

    it('returns error for empty hex in authority', async () => {
      const result = await resolver.resolve('dev-container+');

      expect(result.type).toBe('error');
      if (result.type === 'error') {
        expect(result.message).toContain('Failed to decode authority');
      }
    });
  });

  describe('findContainerByLabel', () => {
    it('finds container by workspace label', async () => {
      mockExecFile.mockImplementation((_cmd: any, _args: any, ...rest: any[]) => {
        const callback = typeof rest[0] === 'function' ? rest[0] : rest[1];
        callback(null, 'container123\n', '');
        return {} as any;
      });

      const result = await resolver.findContainerByLabel('/home/user/project');
      expect(result).toBe('container123');
    });

    it('returns undefined when no container matches', async () => {
      mockExecFile.mockImplementation((_cmd: any, _args: any, ...rest: any[]) => {
        const callback = typeof rest[0] === 'function' ? rest[0] : rest[1];
        callback(null, '', '');
        return {} as any;
      });

      const result = await resolver.findContainerByLabel('/no/match');
      expect(result).toBeUndefined();
    });

    it('returns undefined when docker ps fails', async () => {
      mockExecFile.mockImplementation((_cmd: any, _args: any, ...rest: any[]) => {
        const callback = typeof rest[0] === 'function' ? rest[0] : rest[1];
        callback(new Error('Docker not available'), '', '');
        return {} as any;
      });

      const result = await resolver.findContainerByLabel('/some/path');
      expect(result).toBeUndefined();
    });

    it('returns first container when multiple match', async () => {
      mockExecFile.mockImplementation((_cmd: any, _args: any, ...rest: any[]) => {
        const callback = typeof rest[0] === 'function' ? rest[0] : rest[1];
        callback(null, 'first123\nsecond456\n', '');
        return {} as any;
      });

      const result = await resolver.findContainerByLabel('/some/path');
      expect(result).toBe('first123');
    });
  });

  describe('getCanonicalURI', () => {
    it('returns the URI unchanged', () => {
      const uri = { scheme: 'vscode-remote', authority: 'dev-container+abc123' } as any;
      expect(resolver.getCanonicalURI(uri)).toBe(uri);
    });
  });

  describe('custom docker path', () => {
    it('uses custom docker path for inspect', async () => {
      const customResolver = new RemoteAuthorityResolver({ dockerPath: '/usr/local/bin/docker' });
      const containerId = 'abc123';
      const authority = encodeAuthority(SCHEME_ATTACHED_CONTAINER, containerId);
      const containerData = makeContainerData({ Id: containerId });

      setupMockForInspect(containerData);

      await customResolver.resolve(authority);

      const calls = mockExecFile.mock.calls;
      expect(calls.some((call) => call[0] === '/usr/local/bin/docker')).toBe(true);
    });
  });
});

describe('registerAuthorityResolver', () => {
  let mockContext: any;
  let resolver: RemoteAuthorityResolver;

  beforeEach(() => {
    vi.clearAllMocks();
    resolver = new RemoteAuthorityResolver();
    mockContext = {
      subscriptions: [],
    };
  });

  it('registers via proposed API when available', async () => {
    const vscode = await import('vscode');
    const mockDisposable = { dispose: vi.fn() };
    (vscode as any).workspace = {
      registerRemoteAuthorityResolver: vi.fn().mockReturnValue(mockDisposable),
    };

    registerAuthorityResolver(mockContext, resolver);

    expect((vscode as any).workspace.registerRemoteAuthorityResolver).toHaveBeenCalledTimes(2);
    expect((vscode as any).workspace.registerRemoteAuthorityResolver).toHaveBeenCalledWith(
      SCHEME_DEV_CONTAINER,
      expect.any(Object)
    );
    expect((vscode as any).workspace.registerRemoteAuthorityResolver).toHaveBeenCalledWith(
      SCHEME_ATTACHED_CONTAINER,
      expect.any(Object)
    );
    expect(mockContext.subscriptions).toHaveLength(2);
  });
});