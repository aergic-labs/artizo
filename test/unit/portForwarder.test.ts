/*
 * Copyright (c) 2026 Aergic Labs, LLC
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import type { Server, Socket } from 'node:net';

vi.mock('node:child_process', () => ({
  spawn: vi.fn(),
}));

vi.mock('node:net', () => ({
  createServer: vi.fn(),
}));

import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { PortForwarder, type ForwardedPort } from '../../src/ports/portForwarder';

const mockSpawn = vi.mocked(spawn);
const mockCreateServer = vi.mocked(createServer);

/**
 * Creates a mock net.Server.
 */
function createMockServer(): {
  server: Server;
  emitter: EventEmitter;
  connectionHandler: ((socket: Socket) => void) | null;
} {
  const emitter = new EventEmitter();
  let connectionHandler: ((socket: Socket) => void) | null = null;

  const server = Object.assign(emitter, {
    listen: vi.fn((_port: number, _host: string, cb: () => void) => {
      setImmediate(cb);
      return server;
    }),
    close: vi.fn((cb?: () => void) => {
      if (cb) setImmediate(cb);
      return server;
    }),
    address: vi.fn(() => ({ address: '127.0.0.1', family: 'IPv4', port: 8080 })),
    getConnections: vi.fn(),
    ref: vi.fn(),
    unref: vi.fn(),
    maxConnections: 0,
    connections: 0,
    listening: true,
  }) as unknown as Server;

  // Capture the connection handler passed to createServer
  mockCreateServer.mockImplementation((handler: any) => {
    connectionHandler = handler;
    return server;
  });

  return { server, emitter, get connectionHandler() { return connectionHandler; } };
}

/**
 * Creates a mock ChildProcess for relay tunneling.
 */
function createMockChildProcess(): {
  process: ChildProcess;
  stdin: EventEmitter & { write: ReturnType<typeof vi.fn>; destroyed: boolean; end: ReturnType<typeof vi.fn> };
  stdout: EventEmitter & { pipe: ReturnType<typeof vi.fn> };
  emitter: EventEmitter;
} {
  const emitter = new EventEmitter();
  const stdout = Object.assign(new EventEmitter(), {
    pipe: vi.fn(),
  });
  const stdin = Object.assign(new EventEmitter(), {
    write: vi.fn(),
    destroyed: false,
    end: vi.fn(),
  });

  const process = Object.assign(emitter, {
    stdin,
    stdout,
    stderr: new EventEmitter(),
    pid: 99999,
    killed: false,
    connected: true,
    exitCode: null,
    signalCode: null,
    spawnargs: [],
    spawnfile: '',
    kill: vi.fn(() => true),
    send: vi.fn(),
    disconnect: vi.fn(),
    unref: vi.fn(),
    ref: vi.fn(),
    stdio: [stdin, stdout, null, null, null] as any,
    [Symbol.dispose]: vi.fn(),
  }) as unknown as ChildProcess;

  return { process, stdin, stdout, emitter };
}

/**
 * Creates a mock Socket.
 */
function createMockSocket(): Socket {
  const emitter = new EventEmitter();
  const socket = Object.assign(emitter, {
    pipe: vi.fn(),
    destroy: vi.fn(),
    write: vi.fn(),
    end: vi.fn(),
    connect: vi.fn(),
    setEncoding: vi.fn(),
    pause: vi.fn(),
    resume: vi.fn(),
    setTimeout: vi.fn(),
    setNoDelay: vi.fn(),
    setKeepAlive: vi.fn(),
    address: vi.fn(),
    unref: vi.fn(),
    ref: vi.fn(),
    remoteAddress: '127.0.0.1',
    remotePort: 54321,
    localAddress: '127.0.0.1',
    localPort: 8080,
    bytesRead: 0,
    bytesWritten: 0,
    connecting: false,
    destroyed: false,
    writable: true,
    readable: true,
  }) as unknown as Socket;

  return socket;
}

describe('PortForwarder', () => {
  let forwarder: PortForwarder;
  let mockServer: ReturnType<typeof createMockServer>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockServer = createMockServer();
    forwarder = new PortForwarder({ containerId: 'test-container' });
  });

  afterEach(() => {
    forwarder.dispose();
  });

  describe('forwardPort', () => {
    it('creates a local server listening on the specified port', async () => {
      await forwarder.forwardPort(3000, 3000);

      expect(mockCreateServer).toHaveBeenCalledTimes(1);
      expect(mockServer.server.listen).toHaveBeenCalledWith(
        3000,
        '127.0.0.1',
        expect.any(Function)
      );
    });

    it('uses containerPort as localPort when localPort is not specified', async () => {
      await forwarder.forwardPort(8080);

      expect(mockServer.server.listen).toHaveBeenCalledWith(
        8080,
        '127.0.0.1',
        expect.any(Function)
      );
    });

    it('returns a ForwardedPort object with correct properties', async () => {
      const result = await forwarder.forwardPort(3000, 4000, 'My App');

      expect(result).toEqual({
        containerPort: 3000,
        localPort: 4000,
        label: 'My App',
        protocol: 'tcp',
        source: 'user',
      });
    });

    it('throws if port is already forwarded', async () => {
      await forwarder.forwardPort(3000);

      await expect(forwarder.forwardPort(3000)).rejects.toThrow(
        'Port 3000 is already forwarded'
      );
    });

    it('throws if forwarder is disposed', async () => {
      forwarder.dispose();

      await expect(forwarder.forwardPort(3000)).rejects.toThrow(
        'PortForwarder has been disposed'
      );
    });

    it('emits didForwardPort event', async () => {
      const listener = vi.fn();
      forwarder.onDidForwardPort(listener);

      await forwarder.forwardPort(3000, 4000, 'Test');

      expect(listener).toHaveBeenCalledWith({
        containerPort: 3000,
        localPort: 4000,
        label: 'Test',
        protocol: 'tcp',
        source: 'user',
      });
    });

    it('rejects if server fails to listen', async () => {
      // Override the mock to emit an error
      mockCreateServer.mockImplementation(() => {
        const emitter = new EventEmitter();
        const server = Object.assign(emitter, {
          listen: vi.fn((_port: number, _host: string, _cb: () => void) => {
            setImmediate(() => emitter.emit('error', new Error('EADDRINUSE')));
            return server;
          }),
          close: vi.fn(),
          address: vi.fn(),
          getConnections: vi.fn(),
          ref: vi.fn(),
          unref: vi.fn(),
          maxConnections: 0,
          connections: 0,
          listening: false,
        }) as unknown as Server;
        return server;
      });

      await expect(forwarder.forwardPort(3000)).rejects.toThrow('EADDRINUSE');
    });

    it('uses custom docker path', async () => {
      const customForwarder = new PortForwarder({
        containerId: 'test-container',
        dockerPath: '/usr/local/bin/docker',
      });

      await customForwarder.forwardPort(3000);

      // Simulate a connection to verify docker path is used
      const mockChild = createMockChildProcess();
      mockSpawn.mockReturnValue(mockChild.process);

      const socket = createMockSocket();
      mockServer.connectionHandler!(socket);

      expect(mockSpawn).toHaveBeenCalledWith(
        '/usr/local/bin/docker',
        expect.arrayContaining(['exec', '-i', 'test-container', 'node', '-e', expect.stringContaining('createConnection(3000')]),
        { stdio: ['pipe', 'pipe', 'pipe'] }
      );

      customForwarder.dispose();
    });
  });

  describe('unforwardPort', () => {
    it('closes the local server', async () => {
      await forwarder.forwardPort(3000);
      await forwarder.unforwardPort(3000);

      expect(mockServer.server.close).toHaveBeenCalled();
    });

    it('removes the port from forwarded ports list', async () => {
      await forwarder.forwardPort(3000);
      expect(forwarder.getForwardedPorts()).toHaveLength(1);

      await forwarder.unforwardPort(3000);
      expect(forwarder.getForwardedPorts()).toHaveLength(0);
    });

    it('does nothing if port is not forwarded', async () => {
      // Should not throw
      await forwarder.unforwardPort(9999);
    });

    it('emits didUnforwardPort event', async () => {
      const listener = vi.fn();
      forwarder.onDidUnforwardPort(listener);

      await forwarder.forwardPort(3000);
      await forwarder.unforwardPort(3000);

      expect(listener).toHaveBeenCalledWith(3000);
    });

    it('kills active relay processes on unforward', async () => {
      await forwarder.forwardPort(3000);

      // Simulate a connection
      const mockChild = createMockChildProcess();
      mockSpawn.mockReturnValue(mockChild.process);

      const socket = createMockSocket();
      mockServer.connectionHandler!(socket);

      // Now unforward - should kill the relay process
      await forwarder.unforwardPort(3000);

      expect(mockChild.process.kill).toHaveBeenCalledWith('SIGTERM');
      expect(socket.destroy).toHaveBeenCalled();
    });
  });

  describe('getForwardedPorts', () => {
    it('returns empty array initially', () => {
      expect(forwarder.getForwardedPorts()).toEqual([]);
    });

    it('returns all forwarded ports', async () => {
      // Need separate mock servers for each forwardPort call
      const mockServer2 = createMockServer();

      await forwarder.forwardPort(3000, 3000, 'Web');

      // Reset for second call
      mockCreateServer.mockImplementation((handler: any) => {
        return mockServer2.server;
      });
      (mockServer2.server.listen as any).mockImplementation((_port: number, _host: string, cb: () => void) => {
        setImmediate(cb);
        return mockServer2.server;
      });

      await forwarder.forwardPort(5432, 5432, 'DB');

      const ports = forwarder.getForwardedPorts();
      expect(ports).toHaveLength(2);
      expect(ports[0].containerPort).toBe(3000);
      expect(ports[1].containerPort).toBe(5432);
    });
  });

  describe('connection handling', () => {
    it('spawns docker exec relay on incoming connection', async () => {
      await forwarder.forwardPort(3000);

      const mockChild = createMockChildProcess();
      mockSpawn.mockReturnValue(mockChild.process);

      const socket = createMockSocket();
      mockServer.connectionHandler!(socket);

      expect(mockSpawn).toHaveBeenCalledWith(
        'docker',
        expect.arrayContaining(['exec', '-i', 'test-container', 'node', '-e', expect.stringContaining('createConnection(3000')]),
        { stdio: ['pipe', 'pipe', 'pipe'] }
      );
    });

    it('pipes local socket to docker exec stdin', async () => {
      await forwarder.forwardPort(3000);

      const mockChild = createMockChildProcess();
      mockSpawn.mockReturnValue(mockChild.process);

      const socket = createMockSocket();
      mockServer.connectionHandler!(socket);

      expect(socket.pipe).toHaveBeenCalledWith(mockChild.stdin);
    });

    it('pipes docker exec stdout to local socket', async () => {
      await forwarder.forwardPort(3000);

      const mockChild = createMockChildProcess();
      mockSpawn.mockReturnValue(mockChild.process);

      const socket = createMockSocket();
      mockServer.connectionHandler!(socket);

      expect(mockChild.stdout.pipe).toHaveBeenCalledWith(socket);
    });

    it('kills relay process when socket closes', async () => {
      await forwarder.forwardPort(3000);

      const mockChild = createMockChildProcess();
      mockSpawn.mockReturnValue(mockChild.process);

      const socket = createMockSocket();
      mockServer.connectionHandler!(socket);

      // Simulate socket close
      (socket as any).emit('close');

      expect(mockChild.process.kill).toHaveBeenCalledWith('SIGTERM');
    });

    it('destroys socket when relay process exits', async () => {
      await forwarder.forwardPort(3000);

      const mockChild = createMockChildProcess();
      mockSpawn.mockReturnValue(mockChild.process);

      const socket = createMockSocket();
      mockServer.connectionHandler!(socket);

      // Simulate process exit
      mockChild.emitter.emit('exit', 0, null);

      expect(socket.destroy).toHaveBeenCalled();
    });

    it('destroys socket on socket error', async () => {
      await forwarder.forwardPort(3000);

      const mockChild = createMockChildProcess();
      mockSpawn.mockReturnValue(mockChild.process);

      const socket = createMockSocket();
      mockServer.connectionHandler!(socket);

      // Simulate socket error
      (socket as any).emit('error', new Error('ECONNRESET'));

      expect(mockChild.process.kill).toHaveBeenCalledWith('SIGTERM');
    });

    it('destroys socket on process error', async () => {
      await forwarder.forwardPort(3000);

      const mockChild = createMockChildProcess();
      mockSpawn.mockReturnValue(mockChild.process);

      const socket = createMockSocket();
      mockServer.connectionHandler!(socket);

      // Simulate process error
      mockChild.emitter.emit('error', new Error('spawn failed'));

      expect(socket.destroy).toHaveBeenCalled();
    });
  });

  describe('dispose', () => {
    it('closes all servers and kills all processes', async () => {
      await forwarder.forwardPort(3000);

      // Simulate a connection
      const mockChild = createMockChildProcess();
      mockSpawn.mockReturnValue(mockChild.process);

      const socket = createMockSocket();
      mockServer.connectionHandler!(socket);

      forwarder.dispose();

      expect(mockChild.process.kill).toHaveBeenCalledWith('SIGTERM');
      expect(mockServer.server.close).toHaveBeenCalled();
    });

    it('is idempotent', async () => {
      await forwarder.forwardPort(3000);

      forwarder.dispose();
      forwarder.dispose(); // Should not throw
    });
  });
});