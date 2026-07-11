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
  spawn?: (cmd: string, args: string[], opts?: Record<string, unknown>) => Promise<unknown>;
  fs?: unknown;
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
 * This replaces ssh -L when an ExecServer is available. The resolver
 * already authenticated, so no password prompt appears.
 */
export async function startExecServerBridge(
  execServer: ExecServer,
  remoteHost: string,
  remotePort: number,
): Promise<TunnelController> {
  log(`starting bridge to ${remoteHost}:${remotePort}`);
  const localPort = await pickFreePort();
  const connections = new Set<net.Socket>();
  let connId = 0;

  const server = net.createServer({
    pauseOnConnect: true,
  }, (localSocket) => {
    const id = ++connId;
    connections.add(localSocket);
    log(`conn ${id}: accepted from ${localSocket.remoteAddress}:${localSocket.remotePort}`);

    execServer
      .tcpConnect(remoteHost, remotePort)
      .then(({ stream, done }: { stream: ExecServerStream; done: Promise<void> }) => {
        log(`conn ${id}: tcpConnect succeeded`);
        let bytesIn = 0;
        let bytesOut = 0;

        // local -> remote
        localSocket.on("data", (chunk: Buffer) => {
          bytesOut += chunk.length;
          log(`conn ${id}: local->remote ${chunk.length}B (total out=${bytesOut})`);
          stream.write(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength));
        });
        // remote -> local
        stream.onDidReceiveMessage((data: Uint8Array) => {
          bytesIn += data.byteLength;
          log(`conn ${id}: remote->local ${data.byteLength}B (total in=${bytesIn})`);
          localSocket.write(Buffer.from(data.buffer, data.byteOffset, data.byteLength));
        });
        // cleanup
        localSocket.on("close", () => {
          log(`conn ${id}: local closed (in=${bytesIn} out=${bytesOut})`);
          try { stream.end(); } catch { /* best effort */ }
          connections.delete(localSocket);
        });
        localSocket.on("error", (err: Error) => {
          log(`conn ${id}: local error: ${err.message}`);
          try { stream.end(); } catch { /* best effort */ }
          connections.delete(localSocket);
        });
        // Resume now that listeners are attached. With pauseOnConnect, the
        // socket was paused since accept. Resuming before the "data" listener
        // exists would discard any data the client already sent.
        localSocket.resume();
        log(`conn ${id}: resumed local socket`);
        done.then(() => {
          log(`conn ${id}: remote stream ended (in=${bytesIn} out=${bytesOut})`);
          localSocket.destroy();
          connections.delete(localSocket);
        }).catch((err: unknown) => {
          log(`conn ${id}: remote stream error: ${err instanceof Error ? err.message : String(err)}`);
          localSocket.destroy();
          connections.delete(localSocket);
        });
      })
      .catch((err: unknown) => {
        log(`conn ${id}: tcpConnect failed: ${err instanceof Error ? err.message : String(err)}`);
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
