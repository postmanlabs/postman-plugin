import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

/** Resolve a working OpenCode CLI, preferring the version pinned by this repo. */
export function resolveOpenCodeExecutable (root) {
    const suffix = process.platform === 'win32' ? '.cmd' : '',
        local = path.join(root, 'node_modules', '.bin', `opencode${suffix}`),
        pathCandidates = (process.env.PATH || '')
            .split(path.delimiter)
            .filter(Boolean)
            .map((directory) => path.join(directory, `opencode${suffix}`)),
        candidates = [process.env.OPENCODE_BIN, local, ...pathCandidates]
            .filter(Boolean);

    for (const candidate of [...new Set(candidates)]) {
        if (!fs.existsSync(candidate)) {
            continue;
        }

        const probe = spawnSync(candidate, ['--version'], {
            encoding: 'utf8',
            timeout: 10000
        });

        if (probe.status === 0) {
            return candidate;
        }
    }

    throw new Error(
        'No working OpenCode executable found. Run `npm install` without `--ignore-scripts`, ' +
        'install OpenCode globally, or set OPENCODE_BIN.'
    );
}
