/*
 * Copyright (c) 2026 Aergic Labs, LLC
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, it, expect } from 'vitest';
import { parseCliOutputLine, formatEventForTerminal, type CliOutputEvent } from '../../src/terminal/outputParser';

describe('parseCliOutputLine', () => {
  it('returns null for empty lines', () => {
    expect(parseCliOutputLine('')).toBeNull();
    expect(parseCliOutputLine('   ')).toBeNull();
    expect(parseCliOutputLine('\t')).toBeNull();
  });

  it('parses a text event', () => {
    const line = JSON.stringify({ type: 'text', level: 3, timestamp: 1700000000000, text: 'Building image...' });
    const result = parseCliOutputLine(line);
    expect(result).toEqual({
      type: 'text',
      level: 3,
      timestamp: 1700000000000,
      text: 'Building image...',
    });
  });

  it('parses a raw event', () => {
    const line = JSON.stringify({ type: 'raw', level: 1, timestamp: 1700000001000, text: 'Step 1/5: FROM node:18' });
    const result = parseCliOutputLine(line);
    expect(result).toEqual({
      type: 'raw',
      level: 1,
      timestamp: 1700000001000,
      text: 'Step 1/5: FROM node:18',
    });
  });

  it('parses a start event', () => {
    const line = JSON.stringify({ type: 'start', level: 2, timestamp: 1700000002000, text: 'Building container' });
    const result = parseCliOutputLine(line);
    expect(result).toEqual({
      type: 'start',
      level: 2,
      timestamp: 1700000002000,
      text: 'Building container',
    });
  });

  it('parses a stop event with startTimestamp', () => {
    const line = JSON.stringify({
      type: 'stop',
      level: 2,
      timestamp: 1700000005000,
      text: 'Building container',
      startTimestamp: 1700000002000,
    });
    const result = parseCliOutputLine(line);
    expect(result).toEqual({
      type: 'stop',
      level: 2,
      timestamp: 1700000005000,
      text: 'Building container',
      startTimestamp: 1700000002000,
    });
  });

  it('parses a progress event', () => {
    const line = JSON.stringify({ type: 'progress', level: 2, timestamp: 1700000003000, text: 'Downloading layer 3/7' });
    const result = parseCliOutputLine(line);
    expect(result).toEqual({
      type: 'progress',
      level: 2,
      timestamp: 1700000003000,
      text: 'Downloading layer 3/7',
    });
  });

  it('returns raw event for non-JSON lines', () => {
    const result = parseCliOutputLine('This is plain text output');
    expect(result).not.toBeNull();
    expect(result!.type).toBe('raw');
    expect(result!.text).toBe('This is plain text output');
  });

  it('returns raw event for JSON without recognized type', () => {
    const line = JSON.stringify({ outcome: 'success', containerId: 'abc123' });
    const result = parseCliOutputLine(line);
    expect(result).not.toBeNull();
    expect(result!.type).toBe('raw');
    expect(result!.text).toBe(line);
  });

  it('returns raw event for JSON with unknown type', () => {
    const line = JSON.stringify({ type: 'unknown', level: 1, timestamp: 1700000000000, text: 'hello' });
    const result = parseCliOutputLine(line);
    expect(result).not.toBeNull();
    expect(result!.type).toBe('raw');
  });

  it('defaults level to 0 when missing', () => {
    const line = JSON.stringify({ type: 'text', timestamp: 1700000000000, text: 'no level' });
    const result = parseCliOutputLine(line);
    expect(result).not.toBeNull();
    expect(result!.level).toBe(0);
  });

  it('defaults text to empty string when missing', () => {
    const line = JSON.stringify({ type: 'text', level: 1, timestamp: 1700000000000 });
    const result = parseCliOutputLine(line);
    expect(result).not.toBeNull();
    expect(result!.text).toBe('');
  });

  it('defaults startTimestamp to 0 for stop events when missing', () => {
    const line = JSON.stringify({ type: 'stop', level: 1, timestamp: 1700000005000, text: 'done' });
    const result = parseCliOutputLine(line);
    expect(result).not.toBeNull();
    expect(result!.type).toBe('stop');
    if (result!.type === 'stop') {
      expect(result!.startTimestamp).toBe(0);
    }
  });

  it('handles lines with leading/trailing whitespace', () => {
    const line = `  ${JSON.stringify({ type: 'text', level: 1, timestamp: 1700000000000, text: 'padded' })}  `;
    const result = parseCliOutputLine(line);
    expect(result).toEqual({
      type: 'text',
      level: 1,
      timestamp: 1700000000000,
      text: 'padded',
    });
  });

  it('handles bash error lines as raw events', () => {
    const result = parseCliOutputLine('bash: type:text: command not found');
    expect(result).not.toBeNull();
    expect(result!.type).toBe('raw');
    expect(result!.text).toBe('bash: type:text: command not found');
  });

  it('handles the final outcome JSON line as raw (no recognized type)', () => {
    const line = JSON.stringify({
      outcome: 'success',
      containerId: 'abc123def456',
      remoteUser: 'vscode',
      remoteWorkspaceFolder: '/workspaces/project',
    });
    const result = parseCliOutputLine(line);
    expect(result).not.toBeNull();
    expect(result!.type).toBe('raw');
    // The raw text preserves the JSON so it can still be parsed for metadata
    expect(result!.text).toContain('abc123def456');
  });
});

describe('formatEventForTerminal', () => {
  it('formats text events as plain text with newline', () => {
    const event: CliOutputEvent = { type: 'text', level: 1, timestamp: 1700000000000, text: 'Hello world' };
    expect(formatEventForTerminal(event)).toBe('Hello world\r\n');
  });

  it('formats raw events as plain text with newline', () => {
    const event: CliOutputEvent = { type: 'raw', level: 0, timestamp: 1700000000000, text: 'raw output' };
    expect(formatEventForTerminal(event)).toBe('raw output\r\n');
  });

  it('formats start events with arrow prefix', () => {
    const event: CliOutputEvent = { type: 'start', level: 2, timestamp: 1700000000000, text: 'Building image' };
    expect(formatEventForTerminal(event)).toBe('▶ Building image\r\n');
  });

  it('formats stop events with checkmark and elapsed time', () => {
    const event: CliOutputEvent = {
      type: 'stop',
      level: 2,
      timestamp: 1700000003500,
      text: 'Building image',
      startTimestamp: 1700000000000,
    };
    expect(formatEventForTerminal(event)).toBe('✓ Building image (3.5s)\r\n');
  });

  it('formats progress events with ellipsis prefix', () => {
    const event: CliOutputEvent = { type: 'progress', level: 2, timestamp: 1700000000000, text: 'Downloading...' };
    expect(formatEventForTerminal(event)).toBe('… Downloading...\r\n');
  });

  it('handles zero elapsed time in stop events', () => {
    const event: CliOutputEvent = {
      type: 'stop',
      level: 1,
      timestamp: 1700000000000,
      text: 'Quick step',
      startTimestamp: 1700000000000,
    };
    expect(formatEventForTerminal(event)).toBe('✓ Quick step (0.0s)\r\n');
  });

  it('handles empty text in events', () => {
    const event: CliOutputEvent = { type: 'text', level: 1, timestamp: 1700000000000, text: '' };
    expect(formatEventForTerminal(event)).toBe('\r\n');
  });
});