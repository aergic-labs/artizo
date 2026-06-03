/*
 * Copyright (c) 2026 Aergic Labs, LLC
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, it, expect } from 'vitest';
import {
  classifyExtension,
  extractExtensionIds,
  type ExtensionLocation,
} from '../../src/extensions/extensionClassifier';

describe('extensionClassifier', () => {
  describe('classifyExtension', () => {
    it('returns "remote" when extensionKind is undefined', () => {
      expect(classifyExtension(undefined)).toBe('remote');
    });

    it('returns "remote" when extensionKind is empty array', () => {
      expect(classifyExtension([])).toBe('remote');
    });

    it('returns "local" for UI-only extensions', () => {
      expect(classifyExtension(['ui'])).toBe('local');
    });

    it('returns "remote" for workspace-only extensions', () => {
      expect(classifyExtension(['workspace'])).toBe('remote');
    });

    it('returns "both" for extensions with both ui and workspace', () => {
      expect(classifyExtension(['ui', 'workspace'])).toBe('both');
    });

    it('returns "both" regardless of order', () => {
      expect(classifyExtension(['workspace', 'ui'])).toBe('both');
    });

    it('returns "remote" for unknown kinds without ui', () => {
      expect(classifyExtension(['other'])).toBe('remote');
    });
  });

  describe('extractExtensionIds', () => {
    it('extracts from customizations.vscode.extensions (current format)', () => {
      const config = {
        customizations: {
          vscode: {
            extensions: ['ms-python.python', 'dbaeumer.vscode-eslint'],
          },
        },
      };

      expect(extractExtensionIds(config)).toEqual([
        'ms-python.python',
        'dbaeumer.vscode-eslint',
      ]);
    });

    it('extracts from legacy extensions field', () => {
      const config = {
        extensions: ['ms-python.python', 'golang.go'],
      };

      expect(extractExtensionIds(config)).toEqual(['ms-python.python', 'golang.go']);
    });

    it('prefers customizations.vscode.extensions over legacy format', () => {
      const config = {
        customizations: {
          vscode: {
            extensions: ['new.extension'],
          },
        },
        extensions: ['old.extension'],
      };

      expect(extractExtensionIds(config)).toEqual(['new.extension']);
    });

    it('returns empty array when no extensions are specified', () => {
      const config = { image: 'node:18' };
      expect(extractExtensionIds(config)).toEqual([]);
    });

    it('returns empty array when customizations exists but no vscode key', () => {
      const config = {
        customizations: {
          other: { extensions: ['something'] },
        },
      };

      expect(extractExtensionIds(config)).toEqual([]);
    });

    it('returns empty array when customizations.vscode exists but no extensions', () => {
      const config = {
        customizations: {
          vscode: { settings: {} },
        },
      };

      expect(extractExtensionIds(config)).toEqual([]);
    });

    it('filters out non-string values from extensions array', () => {
      const config = {
        customizations: {
          vscode: {
            extensions: ['valid.ext', 123, null, 'another.ext', undefined],
          },
        },
      };

      expect(extractExtensionIds(config)).toEqual(['valid.ext', 'another.ext']);
    });

    it('returns empty array when extensions field is not an array', () => {
      const config = {
        extensions: 'not-an-array',
      };

      expect(extractExtensionIds(config)).toEqual([]);
    });
  });
});