import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

export interface JsonRpc {
    request<T = unknown> (method: string, params: unknown): Promise<T>;
    notify (method: string, params?: unknown): void;
}

export class JsonRpcError extends Error {
    constructor (readonly reply: { code?: number; message?: string }) {
        super(`app-server RPC error ${reply.code ?? ''}: ${reply.message ?? 'unknown error'}`);
    }
}

/** One stdio session with a deadline for each request. */
export async function withJsonRpc<T> (
    file: string, args: string[], env: NodeJS.ProcessEnv, use: (rpc: JsonRpc) => Promise<T>, timeoutMs: number
): Promise<T> {
    // npm's Windows launchers need cmd.exe, just as System.run's launchers do.
    const quote = (arg: string) => /^[\w@./:=-]+$/.test(arg) ? arg : `"${arg}"`,
        shell = /\.(cmd|bat)$/i.test(file),
        child = shell ?
            spawn(quote(file), args.map(quote), { env, shell: true, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true }) :
            spawn(file, args, { env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true }),
        lines = createInterface({ input: child.stdout }),
        pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
    let nextId = 0,
        failure: Error | undefined;

    function fail (error: Error): void {
        failure = error;

        for (const entry of pending.values()) {
            clearTimeout(entry.timer);
            entry.reject(error);
        }

        pending.clear();
    }

    child.on('error', fail);
    child.stdin.on('error', fail);
    // Drain diagnostics without putting arbitrary app-server output into installer logs.
    child.stderr.resume();
    const closed = new Promise<void>((resolve) => child.once('close', (code) => {
        fail(new Error(`app-server closed (exit ${code ?? 'signal'})`));
        resolve();
    }));

    lines.on('line', (line) => {
        let message;

        try {
            message = JSON.parse(line);
        }
        catch {
            fail(new Error('app-server returned invalid JSON'));

            return;
        }

        // Notifications are not replies. A server request is unsupported by this client.
        if (message && typeof message.method === 'string') {
            if (message.id !== undefined) {
                child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Method not found' } }) + '\n');
            }

            return;
        }

        const entry = pending.get(message?.id);

        if (!entry) {
            return;
        }

        clearTimeout(entry.timer);
        pending.delete(message.id);

        if (message.error) {
            entry.reject(new JsonRpcError(message.error));
        }
        else if ('result' in message) {
            entry.resolve(message.result);
        }
        else {
            entry.reject(new Error('app-server reply has no result'));
        }
    });

    try {
        return await use({
            request<R> (method: string, params: unknown): Promise<R> {
                if (failure) {
                    return Promise.reject(failure);
                }

                const id = ++nextId;

                return new Promise((resolve, reject) => {
                    const timer = setTimeout(() => fail(new Error(`app-server timed out waiting for ${method}`)), timeoutMs);

                    pending.set(id, { resolve: (value) => resolve(value as R), reject, timer });
                    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
                });
            },
            notify (method, params) {
                if (failure) {
                    throw failure;
                }

                child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
            }
        });
    }
    finally {
        fail(new Error('app-server session ended'));
        lines.close();
        child.stdin.end();

        if (child.exitCode === null && child.signalCode === null) {
            if (shell && process.platform === 'win32' && child.pid) {
                // Killing cmd.exe alone leaves its Codex child holding the pipes open.
                spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore', windowsHide: true }).on('error', () => child.kill());
            }
            else {
                child.kill();
            }
        }

        let force: NodeJS.Timeout | undefined;
        const forced = new Promise<void>((resolve) => {
            force = setTimeout(() => {
                child.kill('SIGKILL');
                // A descendant retaining a pipe must not hold the installer open.
                child.stdin.destroy();
                child.stdout.destroy();
                child.stderr.destroy();
                resolve();
            }, 1000);
        });

        await Promise.race([closed, forced]);
        clearTimeout(force);
    }
}
