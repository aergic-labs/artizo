/*
 * Copyright (c) 2026 Aergic Labs, LLC
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, it, expect } from 'vitest';
import {
  buildUpArgs,
  buildBuildArgs,
} from '../../src/docker/compose';

describe('Docker Compose support', () => {
  describe('buildUpArgs with compose options', () => {
    it('passes single dockerComposeFile as override-config', () => {
      const args = buildUpArgs({
        workspaceFolder: '/project',
        dockerComposeFile: 'docker-compose.yml',
      });

      expect(args).toContain('--override-config');
      const overrideIdx = args.indexOf('--override-config');
      const overrideValue = JSON.parse(args[overrideIdx + 1]);
      expect(overrideValue.dockerComposeFile).toEqual(['docker-compose.yml']);
    });

    it('passes multiple dockerComposeFiles as override-config', () => {
      const args = buildUpArgs({
        workspaceFolder: '/project',
        dockerComposeFile: ['docker-compose.yml', 'docker-compose.override.yml'],
      });

      expect(args).toContain('--override-config');
      const overrideIdx = args.indexOf('--override-config');
      const overrideValue = JSON.parse(args[overrideIdx + 1]);
      expect(overrideValue.dockerComposeFile).toEqual([
        'docker-compose.yml',
        'docker-compose.override.yml',
      ]);
    });

    it('passes service as override-config', () => {
      const args = buildUpArgs({
        workspaceFolder: '/project',
        service: 'app',
      });

      const overrideIndices = args.reduce<number[]>((acc, arg, i) => {
        if (arg === '--override-config') acc.push(i);
        return acc;
      }, []);

      const serviceOverride = overrideIndices
        .map((i) => JSON.parse(args[i + 1]))
        .find((v) => v.service);

      expect(serviceOverride).toBeDefined();
      expect(serviceOverride.service).toBe('app');
    });

    it('passes runServices as override-config', () => {
      const args = buildUpArgs({
        workspaceFolder: '/project',
        runServices: ['app', 'db', 'redis'],
      });

      const overrideIndices = args.reduce<number[]>((acc, arg, i) => {
        if (arg === '--override-config') acc.push(i);
        return acc;
      }, []);

      const runServicesOverride = overrideIndices
        .map((i) => JSON.parse(args[i + 1]))
        .find((v) => v.runServices);

      expect(runServicesOverride).toBeDefined();
      expect(runServicesOverride.runServices).toEqual(['app', 'db', 'redis']);
    });

    it('does not add override-config when no compose options are set', () => {
      const args = buildUpArgs({
        workspaceFolder: '/project',
      });

      expect(args).not.toContain('--override-config');
    });

    it('combines compose options with other up options', () => {
      const args = buildUpArgs({
        workspaceFolder: '/project',
        dockerComposeFile: 'docker-compose.yml',
        service: 'app',
        removeExistingContainer: true,
        logFormat: 'json',
      });

      expect(args).toContain('--override-config');
      expect(args).toContain('--remove-existing-container');
      expect(args).toContain('--log-format');
    });

    it('does not add override-config for empty runServices array', () => {
      const args = buildUpArgs({
        workspaceFolder: '/project',
        runServices: [],
      });

      expect(args).not.toContain('--override-config');
    });
  });

  describe('buildBuildArgs with compose options', () => {
    it('passes dockerComposeFile as override-config', () => {
      const args = buildBuildArgs({
        workspaceFolder: '/project',
        dockerComposeFile: 'docker-compose.yml',
      });

      expect(args).toContain('--override-config');
      const overrideIdx = args.indexOf('--override-config');
      const overrideValue = JSON.parse(args[overrideIdx + 1]);
      expect(overrideValue.dockerComposeFile).toEqual(['docker-compose.yml']);
    });

    it('passes service as override-config for targeted rebuild', () => {
      const args = buildBuildArgs({
        workspaceFolder: '/project',
        service: 'app',
        noCache: true,
      });

      expect(args).toContain('--override-config');
      expect(args).toContain('--no-cache');

      const overrideIndices = args.reduce<number[]>((acc, arg, i) => {
        if (arg === '--override-config') acc.push(i);
        return acc;
      }, []);

      const serviceOverride = overrideIndices
        .map((i) => JSON.parse(args[i + 1]))
        .find((v) => v.service);

      expect(serviceOverride).toBeDefined();
      expect(serviceOverride.service).toBe('app');
    });

    it('does not add override-config when no compose options are set', () => {
      const args = buildBuildArgs({
        workspaceFolder: '/project',
        noCache: true,
      });

      expect(args).not.toContain('--override-config');
    });
  });
});