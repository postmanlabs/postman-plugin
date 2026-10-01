// Starts an agent CLI the same way on every OS. npm installs one on Windows as a `.cmd` shim,
// which Node runs only through cmd.exe (EINVAL otherwise) and finds on PATH only by extension.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const windows = process.platform === 'win32';

function onPath (command) {
    if (!windows || path.extname(command) || command.includes(path.sep) || command.includes('/')) {
        return command;
    }

    for (const dir of (process.env.PATH || '').split(path.delimiter).filter(Boolean)) {
        for (const extension of (process.env.PATHEXT || '.EXE;.CMD;.BAT').split(';')) {
            if (fs.existsSync(path.join(dir, command + extension))) {
                return path.join(dir, command + extension);
            }
        }
    }

    return command;
}

const quoteForCmd = (arg) => (/^[\w@./:=\\-]+$/.test(arg) ? arg : `"${arg}"`);

function invocation (command, args) {
    const file = onPath(command);

    return /\.(cmd|bat)$/i.test(file) ?
        [quoteForCmd(file), args.map(quoteForCmd), { shell: true }] :
        [file, args, {}];
}

export function spawnCliSync (command, args, options = {}) {
    const [file, argv, extra] = invocation(command, args);

    return spawnSync(file, argv, { ...options, ...extra });
}

export function spawnCli (command, args, options = {}) {
    const [file, argv, extra] = invocation(command, args);

    return spawn(file, argv, { ...options, ...extra });
}
