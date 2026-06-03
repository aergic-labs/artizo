/*
 * Copyright (c) 2026 Aergic Labs, LLC
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../src/utils/dockerUtils', () => ({
  dockerExec: vi.fn(),
}));

import { dockerExec } from '../../src/utils/dockerUtils';
import { PortDetector, parseProcNetTcp } from '../../src/ports/portDetector';

const mockDockerExec = vi.mocked(dockerExec);

// Sample /proc/net/tcp content
const SAMPLE_PROC_NET_TCP = `  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode
   0: 00000000:0050 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 12345 1 0000000000000000 100 0 0 10 0
   1: 0100007F:0CEA 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 23456 1 0000000000000000 100 0 0 10 0
   2: 00000000:1F90 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 34567 1 0000000000000000 100 0 0 10 0
   3: 0100007F:7A69 0100007F:0050 01 00000000:00000000 00:00000000 00000000  1000        0 45678 1 0000000000000000 100 0 0 10 0
   4: AC110002:9C40 AC110001:1F90 01 00000000:00000000 00:00000000 00000000  1000        0 56789 1 0000000000000000 100 0 0 10 0`;

describe('parseProcNetTcp', () => {
  it('extracts listening ports on all interfaces (00000000)', () => {
    const ports = parseProcNetTcp(SAMPLE_PROC_NET_TCP);
    // 0x0050 = 80, 0x1F90 = 8080 are on 00000000 with state 0A
    expect(ports).toContain(80);
    expect(ports).toContain(8080);
  });

  it('extracts listening ports on localhost (0100007F)', () => {
    const ports = parseProcNetTcp(SAMPLE_PROC_NET_TCP);
    // 0x0CEA = 3306 is on 0100007F with state 0A
    expect(ports).toContain(3306);
  });

  it('ignores non-LISTEN connections (state != 0A)', () => {
    const ports = parseProcNetTcp(SAMPLE_PROC_NET_TCP);
    // 0x7A69 = 31337 is state 01 (ESTABLISHED), should not be included
    expect(ports).not.toContain(31337);
    // 0x9C40 = 40000 is state 01, should not be included
    expect(ports).not.toContain(40000);
  });

  it('ignores ports on non-local addresses', () => {
    const content = `  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode
   0: AC110002:1F90 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 12345 1 0000000000000000 100 0 0 10 0`;
    const ports = parseProcNetTcp(content);
    // AC110002 = 172.17.0.2, not all-interfaces or localhost
    expect(ports).toHaveLength(0);
  });

  it('returns empty array for empty content', () => {
    expect(parseProcNetTcp('')).toEqual([]);
  });

  it('returns empty array for header-only content', () => {
    const content = `  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode`;
    expect(parseProcNetTcp(content)).toEqual([]);
  });

  it('handles malformed lines gracefully', () => {
    const content = `  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode
   0: bad_data
   1: 00000000:0050 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 12345 1 0000000000000000 100 0 0 10 0`;
    const ports = parseProcNetTcp(content);
    expect(ports).toEqual([80]);
  });

  it('parses multiple listening ports correctly', () => {
    const content = `  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode
   0: 00000000:0050 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 12345 1 0000000000000000 100 0 0 10 0
   1: 00000000:01BB 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 23456 1 0000000000000000 100 0 0 10 0
   2: 0100007F:6989 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 34567 1 0000000000000000 100 0 0 10 0`;
    const ports = parseProcNetTcp(content);
    // 0x0050 = 80, 0x01BB = 443, 0x6989 = 27017
    expect(ports).toContain(80);
    expect(ports).toContain(443);
    expect(ports).toContain(27017);
    expect(ports).toHaveLength(3);
  });
});

describe('PortDetector', () => {
  let detector: PortDetector;

  beforeEach(() => {
    vi.clearAllMocks();
    detector = new PortDetector({
      containerId: 'test-container',
      pollIntervalMs: 3000,
    });
  });

  afterEach(() => {
    detector.dispose();
  });

  describe('start and polling', () => {
    it('calls dockerExec with correct arguments on poll', async () => {
      mockDockerExec.mockResolvedValue({
        exitCode: 0,
        stdout: SAMPLE_PROC_NET_TCP,
        stderr: '',
      });

      // Use triggerPoll directly to test polling logic without timers
      await detector.triggerPoll();

      expect(mockDockerExec).toHaveBeenCalledWith(
        'test-container',
        ['cat', '/proc/net/tcp'],
        { dockerPath: 'docker' }
      );
    });

    it('emits didDetectPort for newly detected ports', async () => {
      mockDockerExec.mockResolvedValue({
        exitCode: 0,
        stdout: SAMPLE_PROC_NET_TCP,
        stderr: '',
      });

      const listener = vi.fn();
      detector.onDidDetectPort(listener);

      await detector.triggerPoll();

      // Should detect ports 80, 3306, 8080
      expect(listener).toHaveBeenCalledWith(80);
      expect(listener).toHaveBeenCalledWith(3306);
      expect(listener).toHaveBeenCalledWith(8080);
    });

    it('does not emit for already known ports', async () => {
      const detectorWithKnown = new PortDetector({
        containerId: 'test-container',
        pollIntervalMs: 3000,
        knownPorts: new Set([80, 3306]),
      });

      mockDockerExec.mockResolvedValue({
        exitCode: 0,
        stdout: SAMPLE_PROC_NET_TCP,
        stderr: '',
      });

      const listener = vi.fn();
      detectorWithKnown.onDidDetectPort(listener);

      await detectorWithKnown.triggerPoll();

      // Should only detect 8080 (80 and 3306 are already known)
      expect(listener).toHaveBeenCalledTimes(1);
      expect(listener).toHaveBeenCalledWith(8080);

      detectorWithKnown.dispose();
    });

    it('does not emit the same port twice across polls', async () => {
      mockDockerExec.mockResolvedValue({
        exitCode: 0,
        stdout: SAMPLE_PROC_NET_TCP,
        stderr: '',
      });

      const listener = vi.fn();
      detector.onDidDetectPort(listener);

      // First poll
      await detector.triggerPoll();
      const firstCallCount = listener.mock.calls.length;

      // Second poll with same data
      await detector.triggerPoll();

      // Should not emit again for the same ports
      expect(listener.mock.calls.length).toBe(firstCallCount);
    });

    it('start sets up interval and does initial poll', () => {
      mockDockerExec.mockResolvedValue({
        exitCode: 0,
        stdout: SAMPLE_PROC_NET_TCP,
        stderr: '',
      });

      // Just verify start doesn't throw and calls poll
      detector.start();

      // dockerExec should have been called (initial poll)
      expect(mockDockerExec).toHaveBeenCalledTimes(1);
    });

    it('start does nothing if already started', () => {
      mockDockerExec.mockResolvedValue({
        exitCode: 0,
        stdout: SAMPLE_PROC_NET_TCP,
        stderr: '',
      });

      detector.start();
      detector.start(); // Should not create a second interval

      // Only one initial poll
      expect(mockDockerExec).toHaveBeenCalledTimes(1);
    });
  });

  describe('stop', () => {
    it('clears the interval allowing restart', async () => {
      mockDockerExec.mockResolvedValue({
        exitCode: 0,
        stdout: SAMPLE_PROC_NET_TCP,
        stderr: '',
      });

      // Start and let the initial poll complete
      detector.start();
      // Wait a tick for the async poll to finish
      await Promise.resolve();
      await Promise.resolve();

      detector.stop();

      // After stop, start can be called again (proves interval was cleared)
      mockDockerExec.mockClear();
      detector.start();
      // start() calls poll() which calls dockerExec
      expect(mockDockerExec).toHaveBeenCalledTimes(1);
    });
  });

  describe('addKnownPort / removeKnownPort', () => {
    it('addKnownPort prevents detection of that port', async () => {
      detector.addKnownPort(80);

      mockDockerExec.mockResolvedValue({
        exitCode: 0,
        stdout: SAMPLE_PROC_NET_TCP,
        stderr: '',
      });

      const listener = vi.fn();
      detector.onDidDetectPort(listener);

      await detector.triggerPoll();

      // 80 should not be emitted since it was added as known
      const detectedPorts = listener.mock.calls.map((c) => c[0]);
      expect(detectedPorts).not.toContain(80);
      expect(detectedPorts).toContain(3306);
      expect(detectedPorts).toContain(8080);
    });

    it('removeKnownPort allows re-detection of that port', async () => {
      const detectorWithKnown = new PortDetector({
        containerId: 'test-container',
        pollIntervalMs: 3000,
        knownPorts: new Set([80]),
      });

      detectorWithKnown.removeKnownPort(80);

      mockDockerExec.mockResolvedValue({
        exitCode: 0,
        stdout: SAMPLE_PROC_NET_TCP,
        stderr: '',
      });

      const listener = vi.fn();
      detectorWithKnown.onDidDetectPort(listener);

      await detectorWithKnown.triggerPoll();

      const detectedPorts = listener.mock.calls.map((c) => c[0]);
      expect(detectedPorts).toContain(80);

      detectorWithKnown.dispose();
    });
  });

  describe('error handling', () => {
    it('silently handles docker exec failures', async () => {
      mockDockerExec.mockResolvedValue({
        exitCode: 1,
        stdout: '',
        stderr: 'container not running',
      });

      const listener = vi.fn();
      detector.onDidDetectPort(listener);

      await detector.triggerPoll();

      expect(listener).not.toHaveBeenCalled();
    });

    it('silently handles docker exec rejections', async () => {
      mockDockerExec.mockRejectedValue(new Error('spawn ENOENT'));

      const listener = vi.fn();
      detector.onDidDetectPort(listener);

      // Should not throw
      await detector.triggerPoll();

      expect(listener).not.toHaveBeenCalled();
    });

    it('continues polling after an error', async () => {
      const listener = vi.fn();
      detector.onDidDetectPort(listener);

      // First poll fails
      mockDockerExec.mockRejectedValueOnce(new Error('network error'));
      await detector.triggerPoll();
      expect(listener).not.toHaveBeenCalled();

      // Second poll succeeds
      mockDockerExec.mockResolvedValueOnce({
        exitCode: 0,
        stdout: SAMPLE_PROC_NET_TCP,
        stderr: '',
      });
      await detector.triggerPoll();

      expect(listener).toHaveBeenCalled();
    });
  });

  describe('dispose', () => {
    it('stops polling and removes listeners', async () => {
      mockDockerExec.mockResolvedValue({
        exitCode: 0,
        stdout: SAMPLE_PROC_NET_TCP,
        stderr: '',
      });

      const listener = vi.fn();
      detector.onDidDetectPort(listener);

      await detector.triggerPoll();
      listener.mockClear();

      detector.dispose();

      // After dispose, triggerPoll should not emit
      mockDockerExec.mockClear();
      await detector.triggerPoll();
      expect(mockDockerExec).not.toHaveBeenCalled();
      expect(listener).not.toHaveBeenCalled();
    });

    it('is idempotent', () => {
      detector.dispose();
      detector.dispose(); // Should not throw
    });

    it('prevents start after dispose', () => {
      detector.dispose();

      mockDockerExec.mockResolvedValue({
        exitCode: 0,
        stdout: SAMPLE_PROC_NET_TCP,
        stderr: '',
      });

      detector.start();

      expect(mockDockerExec).not.toHaveBeenCalled();
    });
  });

  describe('custom docker path', () => {
    it('passes custom docker path to dockerExec', async () => {
      const customDetector = new PortDetector({
        containerId: 'test-container',
        dockerPath: '/usr/local/bin/docker',
        pollIntervalMs: 3000,
      });

      mockDockerExec.mockResolvedValue({
        exitCode: 0,
        stdout: SAMPLE_PROC_NET_TCP,
        stderr: '',
      });

      await customDetector.triggerPoll();

      expect(mockDockerExec).toHaveBeenCalledWith(
        'test-container',
        ['cat', '/proc/net/tcp'],
        { dockerPath: '/usr/local/bin/docker' }
      );

      customDetector.dispose();
    });
  });
});