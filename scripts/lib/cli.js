// Starts an agent CLI the same way on every OS. npm installs one on Windows as a `.cmd` shim,
// which Node runs only through cmd.exe (EINVAL otherwise) and finds on PATH only by extension.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const windows = process.platform === 'win32';

// Windows names are case-insensitive, but only process.env itself knows it: a copy keeps `Path`.
// Of `Path` and `PATH` both, Node gives the child the first in sorted order, so this reads that one.
const variable = (env, name) => env[Object.keys(env).filter((key) => key.toUpperCase() === name).sort()[0]];

function onPath (command, env) {
    if (!windows || path.extname(command) || command.includes(path.sep) || command.includes('/')) {
        return command;
    }

    for (const dir of (variable(env, 'PATH') || '').split(path.delimiter).filter(Boolean)) {
        for (const extension of (variable(env, 'PATHEXT') || '.EXE;.CMD;.BAT').split(';')) {
            if (fs.existsSync(path.join(dir, command + extension))) {
                return path.join(dir, command + extension);
            }
        }
    }

    return command;
}

const quoteForCmd = (arg) => (/^[\w@./:=\\-]+$/.test(arg) ? arg : `"${arg}"`);

// Resolved on the PATH the child gets, which a caller may have narrowed.
function invocation (command, args, env = process.env) {
    const file = onPath(command, env);

    // One string, not an args array: Node deprecates (DEP0190) passing both with `shell`.
    return /\.(cmd|bat)$/i.test(file) ?
        [[file, ...args].map(quoteForCmd).join(' '), [], { shell: true }] :
        [file, args, {}];
}

export function spawnCliSync (command, args, options = {}) {
    const [file, argv, extra] = invocation(command, args, options.env);

    return spawnSync(file, argv, { ...options, ...extra });
}

export function spawnCli (command, args, options = {}) {
    const [file, argv, extra] = invocation(command, args, options.env);

    return spawn(file, argv, { ...options, ...extra });
}
