import path from 'node:path';

/**
 * An in-memory System. `probes` and `runs` map a command line to its result:
 * a string (stdout, exit 0), an `{ code, stdout, stderr }` object, or a
 * function of the fake returning either. A file whose content is an Error
 * exists but throws that error when read. `commands` records every change.
 */
export function fakeSystem ({
    home = '/home/user',
    platform = 'linux',
    env = {},
    dryRun = false,
    bins = [],
    files = {},
    dirs = [],
    probes = {},
    runs = {}
} = {}) {
    const system = {
        home,
        platform,
        env,
        dryRun,
        bins: new Set(bins),
        files: { ...files },
        dirs: new Set(dirs),
        probes: { ...probes },
        runs: { ...runs },
        commands: [],
        runEnv: {},
        lines: [],

        async which (command) {
            return system.bins.has(command) ? `/usr/bin/${command}` : null;
        },

        async exists (file) {
            const prefix = file + path.sep;

            return file in system.files || system.dirs.has(file) ||
                Object.keys(system.files).some((key) => key.startsWith(prefix)) ||
                [...system.dirs].some((dir) => dir.startsWith(prefix));
        },

        async readFile (file) {
            if (system.files[file] instanceof Error) {
                throw system.files[file];
            }

            return file in system.files ? system.files[file] : null;
        },

        async readDir (dir) {
            const prefix = dir + path.sep,
                names = new Set();

            for (const entry of [...Object.keys(system.files), ...system.dirs]) {
                if (entry.startsWith(prefix)) {
                    names.add(entry.slice(prefix.length).split(path.sep)[0]);
                }
            }

            return [...names];
        },

        async probe (command, args) {
            return respond(system.probes, [command, ...args].join(' '), { code: 1, stdout: '', stderr: 'no probe stubbed' });
        },

        async run (command, args, options = {}) {
            const line = [command, ...args].join(' ');

            system.commands.push(line);
            system.runEnv[line] = options.env;

            return dryRun ? { code: 0, stdout: '', stderr: '' } : respond(system.runs, line, { code: 0, stdout: '', stderr: '' });
        },

        async writeFile (file, content) {
            system.commands.push(`write ${file}`);

            if (!dryRun) {
                system.files[file] = content;
            }
        },

        async remove (file) {
            system.commands.push(`remove ${file}`);

            if (!dryRun) {
                const prefix = file + path.sep;

                for (const key of Object.keys(system.files)) {
                    if (key === file || key.startsWith(prefix)) {
                        delete system.files[key];
                    }
                }

                for (const dir of [...system.dirs]) {
                    if (dir === file || dir.startsWith(prefix)) {
                        system.dirs.delete(dir);
                    }
                }
            }
        },

        async rename (from, to) {
            system.commands.push(`rename ${from} ${to}`);

            if (!dryRun) {
                const prefix = from + path.sep;

                for (const key of Object.keys(system.files)) {
                    if (key === from || key.startsWith(prefix)) {
                        system.files[to + key.slice(from.length)] = system.files[key];
                        delete system.files[key];
                    }
                }

                for (const dir of [...system.dirs]) {
                    if (dir === from || dir.startsWith(prefix)) {
                        system.dirs.add(to + dir.slice(from.length));
                        system.dirs.delete(dir);
                    }
                }
            }
        },

        log (line) {
            system.lines.push(line);
        }
    };

    function respond (table, line, fallback) {
        let entry = table[line];

        if (typeof entry === 'function') {
            entry = entry(system);
        }

        if (entry === undefined) {
            return fallback;
        }

        return typeof entry === 'string' ? { code: 0, stdout: entry, stderr: '' } : { stdout: '', stderr: '', ...entry };
    }

    return system;
}
