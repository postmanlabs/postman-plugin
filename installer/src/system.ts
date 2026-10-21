import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { redact } from './source.js';

export type ExecResult = { code: number; stdout: string; stderr: string };
export type ExecOptions = { env?: Record<string, string> };
/** A JSON-RPC request, or with `notify` a notification, which gets no reply. */
export type RpcCall = { method: string; params?: unknown; notify?: boolean };
export type RpcReply = { result?: unknown; error?: { code?: number; message?: string } };

/**
 * Everything a host adapter may do to the machine. `probe` is for read-only
 * commands and always runs; `run`, `writeFile` and `remove` change state, so a
 * dry run prints them instead.
 */
export interface System {
    readonly home: string;
    readonly platform: NodeJS.Platform;
    readonly env: NodeJS.ProcessEnv;
    readonly dryRun: boolean;
    which (command: string): Promise<string | null>;
    /** `false` only when the path does not exist; any other error is thrown, like `readFile`. */
    exists (file: string): Promise<boolean>;
    /** `null` only when the file does not exist; any other read error is thrown, not read as "absent". */
    readFile (file: string): Promise<string | null>;
    /** The names in a directory; empty when it is missing or not a directory, and any other error is thrown, like `readFile`. */
    readDir (dir: string): Promise<string[]>;
    probe (command: string, args: string[]): Promise<ExecResult>;
    /**
     * Starts a JSON-RPC server on stdio, sends each call in turn and returns the requests' replies, or `null` when the
     * server fails to start, exits or stops answering first. For read-only calls: it always runs, like `probe`.
     */
    rpc (command: string, args: string[], calls: RpcCall[]): Promise<RpcReply[] | null>;
    run (command: string, args: string[], options?: ExecOptions): Promise<ExecResult>;
    writeFile (file: string, content: string): Promise<void>;
    remove (file: string): Promise<void>;
    /** Moves a file or directory; a dry run prints it instead. */
    rename (from: string, to: string): Promise<void>;
    log (line: string): void;
}

// A missing file, or a path through something that isn't a directory. Anything else,
// such as a file that exists but can't be read, must not pass for "absent".
const ABSENT = ['ENOENT', 'ENOTDIR'];

// Nothing is ever written to a command's stdin, so it gets EOF at once: a CLI that
// stops to ask something fails instead of waiting forever for an answer.
const STDIO: ['ignore', 'pipe', 'pipe'] = ['ignore', 'pipe', 'pipe'];

// npm installs agent CLIs on Windows as `.cmd` shims, which only cmd.exe can start.
function needsShell (file: string): boolean {
    return /\.(cmd|bat)$/i.test(file);
}

function quoteForCmd (arg: string): string {
    return /^[\w@./:=-]+$/.test(arg) ? arg : `"${arg}"`;
}

function execute (file: string, args: string[], env: NodeJS.ProcessEnv): Promise<ExecResult> {
    return new Promise((resolve) => {
        const shell = needsShell(file),
            child = shell ?
                spawn(quoteForCmd(file), args.map(quoteForCmd), { env, shell: true, stdio: STDIO, windowsHide: true }) :
                spawn(file, args, { env, stdio: STDIO, windowsHide: true });
        let stdout = '',
            stderr = '';

        // Decodes across chunks, so a multi-byte character split between two isn't mangled.
        child.stdout.setEncoding('utf8');
        child.stderr.setEncoding('utf8');
        child.stdout.on('data', (chunk) => { stdout += chunk; });
        child.stderr.on('data', (chunk) => { stderr += chunk; });
        child.on('error', (error) => resolve({ code: 127, stdout, stderr: stderr + error.message }));
        child.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr }));
    });
}

// Long enough for an agent's server to load its config; a hung one must not hang the installer.
const RPC_TIMEOUT_MS = 30000;

// A server that exits at end of input can drop a reply still in flight, so stdin stays open until the last reply.
function converse (file: string, args: string[], env: NodeJS.ProcessEnv, calls: RpcCall[]): Promise<RpcReply[] | null> {
    return new Promise((resolve) => {
        const child = needsShell(file) ?
                spawn(quoteForCmd(file), args.map(quoteForCmd), { env, shell: true, stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true }) :
                spawn(file, args, { env, stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true }),
            replies: RpcReply[] = [],
            queue = [...calls];
        let waiting: number | null = null,
            buffer = '',
            done = false;

        const finish = (value: RpcReply[] | null) => {
                if (!done) {
                    done = true;
                    clearTimeout(timer);
                    child.stdin.end();
                    child.kill();
                    resolve(value);
                }
            },
            timer = setTimeout(() => finish(null), RPC_TIMEOUT_MS),
            next = () => {
                while (queue.length) {
                    const { method, params, notify } = queue.shift() as RpcCall,
                        id = notify ? undefined : replies.length + 1;

                    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...(id ? { id } : {}), method, ...(params === undefined ? {} : { params }) })}\n`);

                    if (id) {
                        waiting = id;

                        return;
                    }
                }

                finish(replies);
            };

        child.stdout.setEncoding('utf8');
        child.stdout.on('data', (chunk) => {
            buffer += chunk;

            const lines = buffer.split('\n');

            buffer = lines.pop() ?? '';

            for (const line of lines) {
                let message: { id?: unknown; result?: unknown; error?: RpcReply['error'] };

                try {
                    message = JSON.parse(line);
                }
                catch {
                    continue;
                }

                if (waiting !== null && message.id === waiting) {
                    waiting = null;
                    replies.push(message.error ? { error: message.error } : { result: message.result });
                    next();
                }
            }
        });
        child.stdin.on('error', () => finish(null));
        child.on('error', () => finish(null));
        child.on('close', () => finish(null));
        next();
    });
}

/** Formats a command for logs and failure messages, with the user-info of any URL in it redacted. */
export function formatCommand (command: string, args: string[]): string {
    return [command, ...args].map((part) => redact(part)).map((part) => (/^[\w@./:=~-]+$/.test(part) ? part : JSON.stringify(part))).join(' ');
}

export function createSystem ({ dryRun = false, log = (line: string) => console.log(line) } = {}): System {
    const env = process.env,
        platform = process.platform;

    async function which (command: string): Promise<string | null> {
        const extensions = platform === 'win32' ? (env.PATHEXT || '.EXE;.CMD;.BAT').split(';') : [''];

        for (const dir of (env.PATH || '').split(path.delimiter).filter(Boolean)) {
            for (const extension of extensions) {
                const candidate = path.join(dir, command + extension);

                try {
                    await fs.access(candidate, fs.constants.X_OK);

                    if ((await fs.stat(candidate)).isFile()) {
                        return candidate;
                    }
                }
                catch {
                    // Not in this directory.
                }
            }
        }

        return null;
    }

    async function resolve (command: string): Promise<string> {
        return (await which(command)) || command;
    }

    return {
        home: os.homedir(),
        platform,
        env,
        dryRun,
        which,
        async exists (file) {
            try {
                await fs.access(file);

                return true;
            }
            catch (error) {
                if (ABSENT.includes((error as NodeJS.ErrnoException).code ?? '')) {
                    return false;
                }

                throw error;
            }
        },
        async readFile (file) {
            try {
                return await fs.readFile(file, 'utf8');
            }
            catch (error) {
                if (ABSENT.includes((error as NodeJS.ErrnoException).code ?? '')) {
                    return null;
                }

                throw error;
            }
        },
        async readDir (dir) {
            try {
                return await fs.readdir(dir);
            }
            catch (error) {
                if (ABSENT.includes((error as NodeJS.ErrnoException).code ?? '')) {
                    return [];
                }

                throw error;
            }
        },
        async probe (command, args) {
            return execute(await resolve(command), args, env);
        },
        async rpc (command, args, calls) {
            return converse(await resolve(command), args, env, calls);
        },
        async run (command, args, options = {}) {
            log(`  $ ${formatCommand(command, args)}`);

            if (dryRun) {
                return { code: 0, stdout: '', stderr: '' };
            }

            return execute(await resolve(command), args, { ...env, ...options.env });
        },
        async writeFile (file, content) {
            log(`  write ${file}`);

            if (!dryRun) {
                await fs.mkdir(path.dirname(file), { recursive: true });
                await fs.writeFile(file, content);
            }
        },
        async remove (file) {
            log(`  remove ${file}`);

            if (!dryRun) {
                await fs.rm(file, { recursive: true, force: true });
            }
        },
        async rename (from, to) {
            log(`  rename ${from} ${to}`);

            if (!dryRun) {
                await fs.rename(from, to);
            }
        },
        log
    };
}
