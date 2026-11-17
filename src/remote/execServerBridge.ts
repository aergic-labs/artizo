/*
 * Copyright (c) 2026 Aergic Labs, LLC
 * SPDX-License-Identifier: AGPL-3.0-only
 */

/** Local TCP bridge that forwards connections to an ExecServer's tcpConnect(). */

import * as net from "node:net";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { pickFreePort, type TunnelController } from "./sshTunnel";

/** Minimal interface for the ExecServer stream returned by tcpConnect(). */
interface ExecServerStream {
  write(data: Uint8Array): void;
  end(): void;
  onDidReceiveMessage(cb: (data: Uint8Array) => void): void;
}

/** Minimal interface for the proposed ExecServer API. */
export interface ExecServer {
  tcpConnect(host: string, port: number): Promise<{
    stream: ExecServerStream;
    done: Promise<void>;
  }>;
  spawn?: (
    cmd: string,
    args: string[],
    opts?: Record<string, unknown>,
  ) => Promise<SpawnedCommand>;
  env?: () => Promise<{
    env: Record<string, string>;
    osPlatform: string;
    osRelease?: string;
  }>;
  fs?: RemoteFs;
}

/** Process handle from `ExecServer.spawn`. */
export interface SpawnedCommand {
  stdin: { write(data: Uint8Array): void; end(): void };
  stdout: {
    onDidReceiveMessage(cb: (d: Uint8Array) => void): void;
    onEnd: Promise<void>;
  };
  stderr: {
    onDidReceiveMessage(cb: (d: Uint8Array) => void): void;
    onEnd: Promise<void>;
  };
  onExit: Promise<{ status: number; message?: string }>;
}

/** Remote file system from `ExecServer.fs`. */
export interface RemoteFs {
  mkdirp(path: string): Promise<void>;
  write(path: string): Promise<{
    stream: { write(data: Uint8Array): void; end(): void };
    done: Promise<void>;
  }>;
  read(path: string): Promise<{
    onDidReceiveMessage(cb: (d: Uint8Array) => void): void;
    onEnd: Promise<void>;
  }>;
  stat(path: string): Promise<{ type: number; size: number; mtime: number; ctime: number }>;
  rm(path: string): Promise<void>;
  rename(fromPath: string, toPath: string): Promise<void>;
  readdir(path: string): Promise<Array<{ name: string; type: number }>>;
}

/** File-based logger for the bridge. */
function log(msg: string): void {
  try {
    const logFile = path.join(os.tmpdir(), "artizo-resolver.log");
    fs.appendFileSync(logFile, `[${new Date().toISOString()}] [Bridge] ${msg}\n`);
  } catch {
    /* diagnostics only */
  }
}

/**
 * Creates a local TCP server that bridges incoming connections to
 * execServer.tcpConnect(host, port). Each accepted connection gets a
 * new tcpConnect stream; data is piped bidirectionally.
 *
 * The resolver already authenticated, so no password prompt appears.
 */
export async function startExecServerBridge(
  execServer: ExecServer,
  remoteHost: string,
  remotePort: number,
): Promise<TunnelController> {
  return startBridge(`tcp:${remoteHost}:${remotePort}`, () =>
    execServer.tcpConnect(remoteHost, remotePort),
  );
}

async function startBridge(
  label: string,
  connect: () => Promise<{ stream: ExecServerStream; done: Promise<void> }>,
): Promise<TunnelController> {
  log(`starting bridge to ${label}`);
  const localPort = await pickFreePort();
  const connections = new Set<net.Socket>();
  let connId = 0;

  const server = net.createServer({
    pauseOnConnect: true,
  }, (localSocket) => {
    const id = ++connId;
    connections.add(localSocket);

    connect()
      .then(({ stream, done }: { stream: ExecServerStream; done: Promise<void> }) => {
        // local -> remote
        localSocket.on("data", (chunk: Buffer) => {
          stream.write(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength));
        });
        // remote -> local
        stream.onDidReceiveMessage((data: Uint8Array) => {
          localSocket.write(Buffer.from(data.buffer, data.byteOffset, data.byteLength));
        });
        // cleanup
        localSocket.on("close", () => {
          try { stream.end(); } catch { /* best effort */ }
          connections.delete(localSocket);
        });
        localSocket.on("error", () => {
          try { stream.end(); } catch { /* best effort */ }
          connections.delete(localSocket);
        });
        // Resume now that listeners are attached. With pauseOnConnect, the
        // socket was paused since accept. Resuming before the "data" listener
        // exists would discard any data the client already sent.
        localSocket.resume();
        done.then(() => {
          localSocket.destroy();
          connections.delete(localSocket);
        }).catch((err: unknown) => {
          log(`conn ${id}: remote stream error: ${err instanceof Error ? err.message : String(err)}`);
          localSocket.destroy();
          connections.delete(localSocket);
        });
      })
      .catch((err: unknown) => {
        log(`conn ${id}: connect failed: ${err instanceof Error ? err.message : String(err)}`);
        localSocket.destroy();
        connections.delete(localSocket);
      });
  });

  await new Promise<void>((resolve, reject) => {
    server.listen(localPort, "127.0.0.1", () => resolve());
    server.once("error", reject);
  });

  log(`listening on 127.0.0.1:${localPort}`);

  let stopped = false;

  return {
    localPort,
    isAlive: () => !stopped,
    stop(): void {
      if (stopped) return;
      stopped = true;
      log(`stopping bridge on port ${localPort} (${connections.size} active connections)`);
      for (const conn of connections) {
        try { conn.destroy(); } catch { /* best effort */ }
      }
      connections.clear();
      try { server.close(); } catch { /* best effort */ }
      log("bridge stopped");
    },
  };
}
