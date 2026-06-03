/*
 * Copyright (c) 2026 Aergic Labs, LLC
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock vscode module
vi.mock('vscode', () => ({
    EventEmitter: vi.fn().mockImplementation(() => ({
        event: vi.fn(),
        fire: vi.fn(),
        dispose: vi.fn(),
    })),
}));

import { Logger, LogLevel, initLogger, getLogger } from '../../src/utils/logger';

// Mock LogOutputTerminal
function createMockTerminal() {
    return {
        info: vi.fn(),
        debug: vi.fn(),
        trace: vi.fn(),
        error: vi.fn(),
        warn: vi.fn(),
        write: vi.fn(),
        writeLine: vi.fn(),
        raw: vi.fn(),
        setLogLevel: vi.fn(),
        done: vi.fn(),
        end: vi.fn(),
        dispose: vi.fn(),
        onDidWrite: vi.fn(),
        onDidClose: vi.fn(),
        onDidInput: vi.fn(),
        open: vi.fn(),
        close: vi.fn(),
        handleInput: vi.fn(),
    };
}

describe('Logger', () => {
    let mockTerminal: ReturnType<typeof createMockTerminal>;
    let logger: Logger;

    beforeEach(() => {
        mockTerminal = createMockTerminal();
        logger = new Logger(mockTerminal as any);
    });

    describe('log levels', () => {
        it('calls terminal.info for info messages', () => {
            logger.info('test message');
            expect(mockTerminal.info).toHaveBeenCalledWith('test message');
        });

        it('calls terminal.debug for debug messages', () => {
            logger.debug('test message');
            expect(mockTerminal.debug).toHaveBeenCalledWith('test message');
        });

        it('calls terminal.warn for warn messages', () => {
            logger.warn('test warning');
            expect(mockTerminal.warn).toHaveBeenCalledWith('test warning');
        });

        it('calls terminal.error for error messages', () => {
            logger.error('test error');
            expect(mockTerminal.error).toHaveBeenCalled();
            expect(mockTerminal.error.mock.calls[0][0]).toContain('test error');
        });

        it('appends Error message to error log', () => {
            const err = new Error('boom');
            logger.error('something failed', err);
            expect(mockTerminal.error).toHaveBeenCalled();
            expect(mockTerminal.error.mock.calls[0][0]).toContain('boom');
        });

        it('appends string context to error log', () => {
            logger.error('failed', 'connection refused');
            expect(mockTerminal.error).toHaveBeenCalled();
            expect(mockTerminal.error.mock.calls[0][0]).toContain('connection refused');
        });
    });

    describe('setLevel', () => {
        it('delegates to terminal.setLogLevel', () => {
            logger.setLevel(LogLevel.Trace);
            expect(mockTerminal.setLogLevel).toHaveBeenCalledWith(LogLevel.Trace);
        });
    });
});

describe('initLogger / getLogger', () => {
    it('throws if getLogger called before initLogger', () => {
        // Clear any previous global
        vi.resetModules();
        expect(() => getLogger()).toThrow('Logger not initialized');
    });

    it('returns the logger after initLogger', () => {
        const terminal = createMockTerminal();
        const log = initLogger(terminal as any);
        expect(log).toBeInstanceOf(Logger);
        expect(getLogger()).toBe(log);
    });
});