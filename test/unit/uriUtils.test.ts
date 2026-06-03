/*
 * Copyright (c) 2026 Aergic Labs, LLC
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, it, expect, vi } from 'vitest';

vi.mock('vscode', () => ({
  window: {
    createTerminal: vi.fn().mockReturnValue({ show: vi.fn(), dispose: vi.fn() }),
    withProgress: vi.fn(),
  },
  commands: { executeCommand: vi.fn() },
  EventEmitter: vi.fn().mockImplementation(() => ({ event: vi.fn(), fire: vi.fn(), dispose: vi.fn() })),
  ProgressLocation: { Notification: 15 },
  Uri: { parse: (s: string) => ({ toString: () => s }) },
  workspace: { workspaceFolders: [{ uri: { fsPath: '/test/workspace' } }] },
}));

import { encodeAuthority, decodeAuthority } from '../../src/utils/uriUtils';

describe('uriUtils', () => {
  describe('encodeAuthority', () => {
    it('encodes a simple string', () => {
      const result = encodeAuthority('dev-container', 'hello');
      expect(result).toBe('dev-container+68656c6c6f');
    });

    it('encodes a path with slashes', () => {
      const result = encodeAuthority('dev-container', '/home/user/project');
      expect(result).toMatch(/^dev-container\+[0-9a-f]+$/);
    });
  });

  describe('decodeAuthority', () => {
    it('decodes a valid authority', () => {
      const result = decodeAuthority('dev-container+68656c6c6f');
      expect(result).toEqual({ scheme: 'dev-container', id: 'hello' });
    });

    it('throws on missing separator', () => {
      expect(() => decodeAuthority('devcontainer68656c6c6f')).toThrow('missing \'+\' separator');
    });

    it('throws on empty identifier', () => {
      expect(() => decodeAuthority('dev-container+')).toThrow('empty identifier');
    });

    it('throws on non-hex characters', () => {
      expect(() => decodeAuthority('dev-container+xyz123')).toThrow('non-hex characters');
    });

    it('throws on odd-length hex', () => {
      expect(() => decodeAuthority('dev-container+abc')).toThrow('odd-length hex');
    });
  });
});