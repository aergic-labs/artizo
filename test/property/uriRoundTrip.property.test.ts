/*
 * Copyright (c) 2026 Aergic Labs, LLC
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, it, expect, vi } from 'vitest';

vi.mock('vscode', () => ({
  window: { createTerminal: vi.fn().mockReturnValue({ show: vi.fn(), dispose: vi.fn() }), withProgress: vi.fn() },
  commands: { executeCommand: vi.fn() },
  EventEmitter: vi.fn().mockImplementation(() => ({ event: vi.fn(), fire: vi.fn(), dispose: vi.fn() })),
  ProgressLocation: { Notification: 15 },
  Uri: { parse: (s: string) => ({ toString: () => s }) },
  workspace: { workspaceFolders: [{ uri: { fsPath: '/test/workspace' } }] },
}));

import * as fc from 'fast-check';
import { encodeAuthority, decodeAuthority } from '../../src/utils/uriUtils';

describe('Property 1: Authority URI Parsing Round-Trip', () => {
  it('encoding then decoding produces the original identifier', () => {
    fc.assert(
      fc.property(
        fc.stringOf(fc.char(), { minLength: 1 }),
        (id) => {
          const authority = encodeAuthority('dev-container', id);
          const decoded = decodeAuthority(authority);
          expect(decoded.scheme).toBe('dev-container');
          expect(decoded.id).toBe(id);
        }
      ),
      { numRuns: 200 }
    );
  });

  it('works with attached-container scheme', () => {
    fc.assert(
      fc.property(
        fc.stringOf(fc.char(), { minLength: 1 }),
        (id) => {
          const authority = encodeAuthority('attached-container', id);
          const decoded = decodeAuthority(authority);
          expect(decoded.scheme).toBe('attached-container');
          expect(decoded.id).toBe(id);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('handles paths with special characters', () => {
    fc.assert(
      fc.property(
        fc.stringOf(
          fc.oneof(fc.char(), fc.constantFrom('/', '\\', ' ', '.', '-', '_', ':', '@')),
          { minLength: 1 }
        ),
        (id) => {
          const authority = encodeAuthority('dev-container', id);
          const decoded = decodeAuthority(authority);
          expect(decoded.id).toBe(id);
        }
      ),
      { numRuns: 100 }
    );
  });
});