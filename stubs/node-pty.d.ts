/**
 * Minimal type declarations for node-pty — satisfies the vendored CLI's
 * `import * as ptyType from 'node-pty'` without native compilation.
 *
 * Matches the surface used by @devcontainers/cli v0.87.0.
 * Acts as a canary: if the CLI starts using new IPty members, tsc will
 * fail and alert us that the stub needs updating.
 */
declare module 'node-pty' {
    export interface IPty {
        readonly pid: number;
        readonly cols: number;
        readonly rows: number;
        readonly process: string;
        handleFlowControl: boolean;
        onData: IEvent<string>;
        onExit: IEvent<{ exitCode: number; signal?: number }>;
        write(data: string | Buffer): void;
        resize(columns: number, rows: number, pixelSize?: { width: number; height: number }): void;
        kill(signal?: string): void;
        clear(): void;
        pause(): void;
        resume(): void;
    }

    export interface IEvent<T> {
        (listener: (e: T) => any): IDisposable;
    }

    export interface IDisposable {
        dispose(): void;
    }

    export function spawn(file: string, args: string[] | string, options: IPtyForkOptions | IWindowsPtyForkOptions): IPty;

    export interface IBasePtyForkOptions {
        name?: string;
        cols?: number;
        rows?: number;
        cwd?: string;
        env?: { [key: string]: string | undefined };
        encoding?: string | null;
        handleFlowControl?: boolean;
        flowControlPause?: string;
        flowControlResume?: string;
    }

    export interface IPtyForkOptions extends IBasePtyForkOptions {
        uid?: number;
        gid?: number;
    }

    export interface IWindowsPtyForkOptions extends IBasePtyForkOptions {
        useConpty?: boolean;
        useConptyDll?: boolean;
        conptyInheritCursor?: boolean;
    }
}
