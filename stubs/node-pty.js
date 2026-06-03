// node-pty stub — matches the real IPty interface from microsoft/node-pty
// Called only in ptyExec (interactive exec, lifecycle hooks) — dormant for our code paths
const EventEmitter = require('events');

function noopDisposable() { return { dispose() {} }; }

class StubPty extends EventEmitter {
    constructor(file, args, options) {
        super();
        this.pid = 9999;
        this.cols = (options && options.cols) || 80;
        this.rows = (options && options.rows) || 24;
        this.process = file || '';
        this.handleFlowControl = false;

        // IEvent pattern: onData(cb) returns IDisposable
        this.onData = (cb) => {
            this.on('data', cb);
            return noopDisposable();
        };
        this.onExit = (cb) => {
            this.on('exit', cb);
            return noopDisposable();
        };

        // Environment detection for VSCodium / test / standalone
        const isVSCode = typeof global !== 'undefined' && global.__vscodiumTerminalBridge__;
        const isTest = typeof process !== 'undefined'
            && (process.env.NODE_ENV === 'test' || global.__testStreamHook__);

        if (isVSCode) {
            global.__vscodiumTerminalBridge__.registerPty(this);
        } else if (isTest) {
            process.nextTick(() => this.emit('data', '[Mock PTY: Test Mode]\r\n'));
        }
    }

    write(data) {
        if (typeof global !== 'undefined' && global.__vscodiumTerminalBridge__) {
            global.__vscodiumTerminalBridge__.handleLibraryWrite(data);
        } else if (typeof global !== 'undefined' && global.__testStreamHook__) {
            global.__testStreamHook__(data);
        }
    }

    resize(cols, rows) { this.cols = cols; this.rows = rows; }
    kill(signal) { this.emit('exit', { exitCode: 0, signal: signal || 0 }); }
    clear() {}    // no-op (Windows/ConPTY only)
    pause() {}    // flow control — no-op
    resume() {}   // flow control — no-op
}

module.exports = { spawn: (file, args, options) => new StubPty(file, args, options) };
