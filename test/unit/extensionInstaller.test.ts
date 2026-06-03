/*
 * Copyright (c) 2026 Aergic Labs, LLC
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  ExtensionInstaller,
  EXTENSIONS_INSTALL_PATH,
} from '../../src/extensions/extensionInstaller';

vi.mock('node:child_process', () => ({
  execFile: vi.fn(),
}));

vi.mock('node:fs', () => ({
  unlinkSync: vi.fn(),
  createWriteStream: vi.fn(),
  unlink: vi.fn(),
}));

import { execFile } from 'node:child_process';

const mockExecFile = vi.mocked(execFile);

type ExecFileCallback = (error: any, stdout: string, stderr: string) => void;

/**
 * Helper to set up sequential mock responses for execFile.
 */
function setupExecFileResponses(
  responses: Array<{ stdout: string; stderr?: string; exitCode?: number }>
) {
  mockExecFile.mockReset();
  let callIndex = 0;

  mockExecFile.mockImplementation((_cmd, _args, ...rest) => {
    const response = responses[callIndex] ?? { stdout: '', stderr: '', exitCode: 1 };
    callIndex++;

    const callback: ExecFileCallback =
      typeof rest[0] === 'function'
        ? (rest[0] as ExecFileCallback)
        : (rest[1] as ExecFileCallback);

    const { stdout, stderr = '', exitCode = 0 } = response;

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

describe('extensionInstaller', () => {
  describe('EXTENSIONS_INSTALL_PATH', () => {
    it('points to the artizo-server extensions directory', () => {
      expect(EXTENSIONS_INSTALL_PATH).toBe('~/.artizo-server/extensions');
    });
  });

  describe('ExtensionInstaller', () => {
    let installer: ExtensionInstaller;
    let mockHttpGet: ReturnType<typeof vi.fn>;
    let mockHttpDownload: ReturnType<typeof vi.fn>;

    beforeEach(() => {
      mockExecFile.mockReset();
      mockHttpGet = vi.fn();
      mockHttpDownload = vi.fn();

      installer = new ExtensionInstaller({
        marketplaceOptions: {
          httpGet: mockHttpGet,
          httpDownload: mockHttpDownload,
        },
      });
    });

    describe('installFromConfig', () => {
      it('returns empty array when no extensions in config', async () => {
        const config = { image: 'node:18' };
        const results = await installer.installFromConfig('container1', config);
        expect(results).toEqual([]);
      });

      it('extracts and installs extensions from config', async () => {
        const config = {
          customizations: {
            vscode: {
              extensions: ['pub.ext1'],
            },
          },
        };

        // Mock marketplace response
        mockHttpGet.mockResolvedValue(
          JSON.stringify({
            version: '1.0.0',
            files: { download: 'https://example.com/pub.ext1-1.0.0.vsix' },
          })
        );
        mockHttpDownload.mockResolvedValue(undefined);

        // Mock docker exec calls:
        // 1. mkdir -p extensions dir
        // 2. docker cp (via execFile directly)
        // 3. unzip in container
        // 4. rm vsix from container
        setupExecFileResponses([
          { stdout: '' }, // mkdir -p extensions dir
          { stdout: '' }, // docker cp
          { stdout: '' }, // unzip
          { stdout: '' }, // rm
        ]);

        const results = await installer.installFromConfig('container1', config);

        expect(results).toHaveLength(1);
        expect(results[0].id).toBe('pub.ext1');
        expect(results[0].success).toBe(true);
      });
    });

    describe('installExtensions', () => {
      it('returns empty array for empty extension list', async () => {
        const results = await installer.installExtensions('container1', []);
        expect(results).toEqual([]);
      });

      it('installs a single extension successfully', async () => {
        mockHttpGet.mockResolvedValue(
          JSON.stringify({
            version: '2.0.0',
            files: { download: 'https://example.com/download.vsix' },
          })
        );
        mockHttpDownload.mockResolvedValue(undefined);

        setupExecFileResponses([
          { stdout: '' }, // mkdir -p extensions dir
          { stdout: '' }, // docker cp
          { stdout: '' }, // unzip
          { stdout: '' }, // rm
        ]);

        const results = await installer.installExtensions('container1', ['pub.ext']);

        expect(results).toHaveLength(1);
        expect(results[0]).toEqual({ id: 'pub.ext', success: true });
      });

      it('reports failure when marketplace fetch fails', async () => {
        mockHttpGet.mockRejectedValue(new Error('HTTP 404 for url'));

        setupExecFileResponses([
          { stdout: '' }, // mkdir -p extensions dir
        ]);

        const results = await installer.installExtensions('container1', ['bad.ext']);

        expect(results).toHaveLength(1);
        expect(results[0].id).toBe('bad.ext');
        expect(results[0].success).toBe(false);
        expect(results[0].error).toContain('HTTP 404');
      });

      it('reports failure when docker cp fails', async () => {
        mockHttpGet.mockResolvedValue(
          JSON.stringify({
            version: '1.0.0',
            files: { download: 'https://example.com/download.vsix' },
          })
        );
        mockHttpDownload.mockResolvedValue(undefined);

        setupExecFileResponses([
          { stdout: '' }, // mkdir -p extensions dir
          { stdout: '', stderr: 'No such container', exitCode: 1 }, // docker cp fails
        ]);

        const results = await installer.installExtensions('container1', ['pub.ext']);

        expect(results).toHaveLength(1);
        expect(results[0].success).toBe(false);
        expect(results[0].error).toContain('Failed to copy file to container');
      });

      it('reports failure when unzip fails', async () => {
        mockHttpGet.mockResolvedValue(
          JSON.stringify({
            version: '1.0.0',
            files: { download: 'https://example.com/download.vsix' },
          })
        );
        mockHttpDownload.mockResolvedValue(undefined);

        setupExecFileResponses([
          { stdout: '' }, // mkdir -p extensions dir
          { stdout: '' }, // docker cp succeeds
          { stdout: '', stderr: 'unzip: cannot find', exitCode: 1 }, // unzip fails
        ]);

        const results = await installer.installExtensions('container1', ['pub.ext']);

        expect(results).toHaveLength(1);
        expect(results[0].success).toBe(false);
        expect(results[0].error).toContain('Failed to extract VSIX');
      });

      it('installs multiple extensions and reports individual results', async () => {
        // First extension succeeds
        mockHttpGet
          .mockResolvedValueOnce(
            JSON.stringify({
              version: '1.0.0',
              files: { download: 'https://example.com/good.vsix' },
            })
          )
          // Second extension fails at marketplace
          .mockRejectedValueOnce(new Error('Not found'));

        mockHttpDownload.mockResolvedValue(undefined);

        setupExecFileResponses([
          { stdout: '' }, // mkdir -p extensions dir
          { stdout: '' }, // docker cp for first ext
          { stdout: '' }, // unzip for first ext
          { stdout: '' }, // rm for first ext
        ]);

        const results = await installer.installExtensions('container1', [
          'good.ext',
          'bad.ext',
        ]);

        expect(results).toHaveLength(2);
        expect(results[0]).toEqual({ id: 'good.ext', success: true });
        expect(results[1].id).toBe('bad.ext');
        expect(results[1].success).toBe(false);
      });

      it('throws when extensions directory creation fails', async () => {
        setupExecFileResponses([
          { stdout: '', stderr: 'Permission denied', exitCode: 1 }, // mkdir fails
        ]);

        await expect(
          installer.installExtensions('container1', ['pub.ext'])
        ).rejects.toThrow('Failed to create extensions directory');
      });
    });

    describe('custom docker path', () => {
      it('uses custom docker path', async () => {
        const customInstaller = new ExtensionInstaller({
          dockerPath: '/usr/local/bin/docker',
          marketplaceOptions: {
            httpGet: mockHttpGet,
            httpDownload: mockHttpDownload,
          },
        });

        mockHttpGet.mockResolvedValue(
          JSON.stringify({
            version: '1.0.0',
            files: { download: 'https://example.com/download.vsix' },
          })
        );
        mockHttpDownload.mockResolvedValue(undefined);

        setupExecFileResponses([
          { stdout: '' }, // mkdir
          { stdout: '' }, // docker cp
          { stdout: '' }, // unzip
          { stdout: '' }, // rm
        ]);

        await customInstaller.installExtensions('container1', ['pub.ext']);

        // First call is mkdir via dockerExec
        const firstCallCmd = mockExecFile.mock.calls[0][0];
        expect(firstCallCmd).toBe('/usr/local/bin/docker');
      });
    });
  });
});