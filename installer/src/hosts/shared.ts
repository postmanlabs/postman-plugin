import path from 'node:path';
import { GIT_URL, REPO, isSameRepo } from '../source.js';
import { type ExecOptions, type ExecResult, type System, formatCommand } from '../system.js';
import { type Result, result } from './types.js';

export class StepFailed extends Error {
    constructor (readonly outcome: Result) {
        super(outcome.message);
    }
}

export function parseJson<T> (text: string): T | null {
    try {
        return JSON.parse(text) as T;
    }
    catch {
        return null;
    }
}

function lastLines (text: string, count = 5): string {
    return text.trim().split('\n').slice(-count).join('\n');
}

function describeFailure (command: string, args: string[], exec: ExecResult): string {
    const output = lastLines(exec.stderr) || lastLines(exec.stdout);

    return `\`${formatCommand(command, args)}\` exited ${exec.code}${output ? `:\n${output}` : ''}`;
}

/** Runs a state-changing command and throws `StepFailed` if it exits non-zero. */
export async function mustRun (system: System, command: string, args: string[], options?: ExecOptions): Promise<void> {
    const exec = await system.run(command, args, options);

    if (exec.code !== 0) {
        throw new StepFailed(result('failed', describeFailure(command, args, exec)));
    }
}

/** Runs a read-only JSON listing; throws `StepFailed` if it fails or does not parse. */
export async function mustProbeJson<T> (system: System, command: string, args: string[]): Promise<T> {
    const exec = await system.probe(command, args),
        parsed = exec.code === 0 ? parseJson<T>(exec.stdout) : null;

    if (parsed === null) {
        throw new StepFailed(result('failed', exec.code === 0 ?
            `\`${formatCommand(command, args)}\` printed output that is not JSON` :
            describeFailure(command, args, exec)));
    }

    return parsed;
}

export function blocked (message: string): never {
    throw new StepFailed(result('blocked', message));
}

async function cloneOrigin (system: System, dir: string): Promise<string | null> {
    const exec = await system.probe('git', ['-C', dir, 'remote', 'get-url', 'origin']);

    return exec.code === 0 ? exec.stdout.trim() : null;
}

/** Refuses to touch a directory at our path unless it is a clone of this repo. */
async function assertOurClone (system: System, dir: string): Promise<void> {
    if (!(await system.exists(path.join(dir, '.git')))) {
        blocked(`${dir} exists but is not a git clone; move it aside and re-run`);
    }

    const origin = await cloneOrigin(system, dir);

    if (!isSameRepo(origin ?? undefined, REPO)) {
        blocked(`${dir} is a clone of ${origin ?? 'an unknown remote'}, not ${REPO}; move it aside and re-run`);
    }
}

async function assertGit (system: System): Promise<void> {
    if (!(await system.which('git'))) {
        blocked('git is not on PATH');
    }
}

/** Clones this repo into `dir`, or fast-forwards an existing clone of it. */
export async function syncClone (system: System, dir: string): Promise<'cloned' | 'updated'> {
    await assertGit(system);

    if (await system.exists(dir)) {
        await assertOurClone(system, dir);
        await mustRun(system, 'git', ['-C', dir, 'pull', '--ff-only']);

        return 'updated';
    }

    await mustRun(system, 'git', ['clone', '--depth', '1', GIT_URL, dir]);

    return 'cloned';
}

export async function removeClone (system: System, dir: string): Promise<void> {
    if (!(await system.exists(dir))) {
        return;
    }

    await assertGit(system);
    await assertOurClone(system, dir);
    await system.remove(dir);
}

/** Converts a thrown `StepFailed` into its result; anything else is an unexpected failure. */
export async function guard (step: () => Promise<Result>): Promise<Result> {
    try {
        return await step();
    }
    catch (error) {
        if (error instanceof StepFailed) {
            return error.outcome;
        }

        return result('failed', error instanceof Error ? error.message : String(error));
    }
}
