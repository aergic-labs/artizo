// Copyright (c) 2026 Aergic Labs, LLC
// SPDX-License-Identifier: AGPL-3.0-only
//
// Artizo remote CLI agent.
//
// A tiny static binary that runs on the SSH host and holds child-process
// handles so the vendored devcontainers CLI's CLIHost can implement exec +
// terminate over the ExecServer (whose spawn has no pid).
//
// Launched once per workflow via ExecServer.spawn; speaks a length-prefixed
// frame protocol over stdin/stdout:
//
//	[u8 type][u32 id][u32 length][payload...]
//
// Client -> agent: EXEC, STDIN, STDIN_END, TERMINATE, DISPOSE, SHUTDOWN.
// Agent -> client: STDOUT, STDERR, EXIT, ERROR.
package main

import (
	"bufio"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"os/exec"
	"sync"
	"syscall"
	"time"
)

const (
	frameExec      byte = 1
	frameStdin     byte = 2
	frameStdinEnd  byte = 3
	frameTerminate byte = 4
	frameDispose   byte = 5
	frameShutdown  byte = 6

	frameStdout byte = 101
	frameStderr byte = 102
	frameExit   byte = 103
	frameError  byte = 104
)

// How long TERMINATE waits for a process to exit on SIGTERM before SIGKILL.
const terminateGrace = 2 * time.Second

type execRequest struct {
	Cmd  string            `json:"cmd"`
	Args []string          `json:"args"`
	Cwd  string            `json:"cwd"`
	Env  map[string]string `json:"env"`
}

type exitInfo struct {
	// Code is null when the process was killed by a signal; Signal then
	// carries the name. Node's child_process convention (code null + signal).
	Code   *int   `json:"code"`
	Signal string `json:"signal,omitempty"`
}

type process struct {
	cmd  *exec.Cmd
	in   io.WriteCloser
	mu   sync.Mutex
	done bool
}

// terminate asks the process to stop, then kills it if it hasn't exited
// within terminateGrace. Watchers and servers get a clean shutdown window.
func (p *process) terminate() {
	p.mu.Lock()
	if p.done || p.cmd.Process == nil {
		p.mu.Unlock()
		return
	}
	proc := p.cmd.Process
	p.mu.Unlock()

	if err := proc.Signal(syscall.SIGTERM); err != nil {
		_ = proc.Kill()
		return
	}
	go func() {
		time.Sleep(terminateGrace)
		p.mu.Lock()
		done := p.done
		p.mu.Unlock()
		if !done {
			_ = proc.Kill()
		}
	}()
}

// exitSignalName maps a Unix signal to the name Node's child_process uses.
func exitSignalName(s syscall.Signal) string {
	switch s {
	case syscall.SIGTERM:
		return "SIGTERM"
	case syscall.SIGKILL:
		return "SIGKILL"
	case syscall.SIGINT:
		return "SIGINT"
	case syscall.SIGHUP:
		return "SIGHUP"
	default:
		return fmt.Sprintf("SIG%d", int(s))
	}
}

var (
	outMu  sync.Mutex
	procMu sync.Mutex
	procs  = map[uint32]*process{}
)

func writeFrame(w io.Writer, typ byte, id uint32, payload []byte) {
	outMu.Lock()
	defer outMu.Unlock()
	hdr := make([]byte, 9)
	hdr[0] = typ
	binary.BigEndian.PutUint32(hdr[1:5], id)
	binary.BigEndian.PutUint32(hdr[5:9], uint32(len(payload)))
	if _, err := w.Write(hdr); err != nil {
		return
	}
	if len(payload) > 0 {
		_, _ = w.Write(payload)
	}
}

func main() {
	out := os.Stdout
	in := bufio.NewReaderSize(os.Stdin, 64*1024)
	for {
		hdr := make([]byte, 9)
		if _, err := io.ReadFull(in, hdr); err != nil {
			return
		}
		typ := hdr[0]
		id := binary.BigEndian.Uint32(hdr[1:5])
		n := binary.BigEndian.Uint32(hdr[5:9])
		var payload []byte
		if n > 0 {
			payload = make([]byte, n)
			if _, err := io.ReadFull(in, payload); err != nil {
				return
			}
		}

		switch typ {
		case frameExec:
			handleExec(out, id, payload)
		case frameStdin:
			if p := lookup(id); p != nil {
				p.mu.Lock()
				if !p.done {
					_, _ = p.in.Write(payload)
				}
				p.mu.Unlock()
			}
		case frameStdinEnd:
			if p := lookup(id); p != nil {
				p.mu.Lock()
				if !p.done {
					_ = p.in.Close()
				}
				p.mu.Unlock()
			}
		case frameTerminate:
			if p := lookup(id); p != nil {
				p.terminate()
			}
		case frameDispose:
			procMu.Lock()
			delete(procs, id)
			procMu.Unlock()
		case frameShutdown:
			return
		}
	}
}

func lookup(id uint32) *process {
	procMu.Lock()
	defer procMu.Unlock()
	return procs[id]
}

func handleExec(out io.Writer, id uint32, payload []byte) {
	var req execRequest
	if err := json.Unmarshal(payload, &req); err != nil {
		writeError(out, id, err)
		return
	}

	cmd := exec.Command(req.Cmd, req.Args...)
	if req.Cwd != "" {
		cmd.Dir = req.Cwd
	}
	if len(req.Env) > 0 {
		// Override in place: duplicate keys in envp are resolved by first
		// occurrence, so appending would not override os.Environ().
		env := os.Environ()
		index := make(map[string]int, len(env))
		for i, kv := range env {
			for j := 0; j < len(kv); j++ {
				if kv[j] == '=' {
					index[kv[:j]] = i
					break
				}
			}
		}
		for k, v := range req.Env {
			entry := k + "=" + v
			if i, ok := index[k]; ok {
				env[i] = entry
			} else {
				index[k] = len(env)
				env = append(env, entry)
			}
		}
		cmd.Env = env
	}

	stdin, err := cmd.StdinPipe()
	if err != nil {
		writeError(out, id, err)
		return
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		writeError(out, id, err)
		return
	}
	stderr, err := cmd.StderrPipe()
	if err != nil {
		writeError(out, id, err)
		return
	}

	if err := cmd.Start(); err != nil {
		writeError(out, id, err)
		return
	}

	p := &process{cmd: cmd, in: stdin}
	procMu.Lock()
	procs[id] = p
	procMu.Unlock()

	go pump(stdout, out, frameStdout, id)
	go pump(stderr, out, frameStderr, id)
	go func() {
		err := cmd.Wait()
		info := exitInfo{}
		if err != nil {
			if ee, ok := err.(*exec.ExitError); ok {
				if ws, ok := ee.Sys().(syscall.WaitStatus); ok && ws.Signaled() {
					// Killed by a signal: report signal, no code (Node convention).
					info.Signal = exitSignalName(ws.Signal())
				} else {
					code := ee.ExitCode()
					info.Code = &code
				}
			} else {
				code := 1
				info.Code = &code
			}
		} else {
			code := 0
			info.Code = &code
		}
		p.mu.Lock()
		p.done = true
		p.mu.Unlock()
		body, _ := json.Marshal(info)
		writeFrame(out, frameExit, id, body)
	}()
}

func writeError(out io.Writer, id uint32, err error) {
	body, _ := json.Marshal(map[string]string{"message": err.Error()})
	writeFrame(out, frameError, id, body)
}

func pump(r io.Reader, out io.Writer, typ byte, id uint32) {
	buf := make([]byte, 32*1024)
	for {
		n, err := r.Read(buf)
		if n > 0 {
			writeFrame(out, typ, id, buf[:n])
		}
		if err != nil {
			return
		}
	}
}
