/*
 * Copyright (c) 2026 Aergic Labs, LLC
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, it, expect, vi } from 'vitest';
import { WindsurfAdapter } from '../../src/platform/windsurf';

const TEST_CONFIG = {
  name: 'Windsurf',
  dataFolderName: '.windsurf-server',
  serverApplicationName: 'windsurf-server',
  needsArgvPatch: true,
  additionalDockerRunArgs: [],
  serverInstallRoot: '/tmp',
  needsHomeSymlink: true,
};

describe('WindsurfAdapter', () => {
  const adapter = new WindsurfAdapter(TEST_CONFIG);

  it('has correct name', () => {
    expect(adapter.name).toBe('Windsurf');
  });

  it('has correct data folder name', () => {
    expect(adapter.dataFolderName).toBe('.windsurf-server');
  });

  describe('getServerDownloadUrl', () => {
    it('constructs URL with commit and quality', () => {
      const url = adapter.getServerDownloadUrl('abc123', 'stable', 'x64', 'x64');
      expect(url).toContain('windsurf-stable.codeiumdata.com');
      expect(url).toContain('/stable/abc123/');
      expect(url).toContain('windsurf-reh-linux-x64');
    });

    it('uses buildId as version when provided', () => {
      const url = adapter.getServerDownloadUrl('def456', 'insider', 'x64', 'arm64', '2.3.9');
      expect(url).toContain('windsurf-reh-linux-arm64-2.3.9.tar.gz');
    });

    it('defaults version to 0.0.0 when buildId is absent', () => {
      const url = adapter.getServerDownloadUrl('ghi789', 'stable', 'x64', 'x64');
      expect(url).toContain('windsurf-reh-linux-x64-0.0.0.tar.gz');
    });
  });

  describe('getAdditionalDockerRunArgs', () => {
    it('returns empty array', () => {
      expect(adapter.getAdditionalDockerRunArgs()).toEqual([]);
    });
  });

  describe('getServerInstallRoot', () => {
    it('returns /tmp', () => {
      expect(adapter.getServerInstallRoot()).toBe('/tmp');
    });
  });

  describe('needsArgvPatch', () => {
    it('returns true', () => {
      expect(adapter.needsArgvPatch()).toBe(true);
    });
  });

  describe('needsHomeSymlink', () => {
    it('returns true', () => {
      expect(adapter.needsHomeSymlink()).toBe(true);
    });
  });

  describe('getArgvPath', () => {
    it('returns path under data folder in home directory', () => {
      const argvPath = adapter.getArgvPath();
      expect(argvPath).toContain('.windsurf-server');
      expect(argvPath).toContain('argv.json');
    });
  });
});