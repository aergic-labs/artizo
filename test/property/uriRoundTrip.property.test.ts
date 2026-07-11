/*
 * Copyright (c) 2026 Aergic Labs, LLC
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, it, expect, vi } from 'vitest';
import vscodeMock from '../__mocks__/vscode';

vi.mock('vscode', () => ({ default: vscodeMock, ...vscodeMock }));

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