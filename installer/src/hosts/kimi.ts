import { commandsFor } from '../agent-commands.js';
import path from 'node:path';
import type { System } from '../system.js';
import { blocked, guard, mustRun, parseJson } from './shared.js';
import { type Host, result } from './types.js';

const COMMANDS = commandsFor('kimi');

// Kimi Code installs plugins only from its TUI (`/plugins install`), so the
// `plugins` CLI writes its plugin store instead. Kimi records it as a local path.
const PLUGIN_ID = 'postman',
    NEXT = 'Restart Kimi Code for the change to take effect.',
    kimiHome = (system: System) => system.env.KIMI_CODE_HOME || path.join(system.home, '.kimi-code'),
    installedFile = (system: System) => path.join(kimiHome(system), 'plugins', 'installed.json'),
    binary = (system: System) => `kimi${system.platform === 'win32' ? '.exe' : ''}`,
    // How Kimi Code's installer (https://code.kimi.com/kimi-code/install.sh) tells a shim of the archived Python kimi-cli:
    // this marker in the first 4096 bytes of the file a `kimi` resolves to.
    LEGACY_CLI_MARKER = 'kimi_cli',
    LEGACY_CLI_SNIFF_BYTES = 4096;

// The same places `plugins` looks, so both agree on whether Kimi is here.
function binaryCandidates (system: System): string[] {
    return [
        path.join(kimiHome(system), 'bin', binary(system)),
        path.join(system.home, '.local', 'bin', binary(system)),
        path.join(system.home, '.kimi', 'bin', binary(system))
    ];
}

/**
 * True for a Kimi Code binary, false for a missing file or for the archived Python kimi-cli, which shares the `kimi`
 * name but loads no plugins. Like Kimi Code's installer, nothing under its own home counts as kimi-cli.
 */
async function isKimiCode (system: System, file: string): Promise<boolean> {
    const relative = path.relative(kimiHome(system), file);

    if (relative && !relative.startsWith('..') && !path.isAbsolute(relative)) {
        return system.exists(file);
    }

    const head = await system.readHead(file, LEGACY_CLI_SNIFF_BYTES);

    return head !== null && !head.includes(LEGACY_CLI_MARKER);
}

export const kimi: Host = {
    id: 'kimi',
    name: 'Kimi Code',
    route: '.kimi-plugin',

    async detect (system) {
        const onPath = await system.which('kimi');

        for (const candidate of [...(onPath ? [onPath] : []), ...binaryCandidates(system)]) {
            if (await isKimiCode(system, candidate)) {
                return true;
            }
        }

        return false;
    },

    async status (system) {
        const text = await system.readFile(installedFile(system));

        if (text === null) {
            return { installed: false, detail: 'not installed', notes: [] };
        }

        const plugins = parseJson<{ plugins?: Array<{ id: string }> }>(text)?.plugins;

        if (!Array.isArray(plugins)) {
            return { installed: null, detail: `could not read ${installedFile(system)}`, notes: [] };
        }

        return plugins.some((plugin) => plugin.id === PLUGIN_ID) ?
            { installed: true, detail: `${PLUGIN_ID} in ${installedFile(system)}`, notes: [] } :
            { installed: false, detail: 'not installed', notes: [] };
    },

    install (system) {
        return guard(async () => {
            if (!(await system.which('npx'))) {
                blocked('npx is not on PATH');
            }

            // Only picks the verb: an unreadable store must not stop the install that could repair it.
            const installed = await kimi.status(system).then((status) => status.installed, () => null);

            // An explicit --package outranks the npm_config_package an outer `npx -p` exports to us.
            await mustRun(system, 'npx', COMMANDS.install, {
                env: { DISABLE_TELEMETRY: '1', DO_NOT_TRACK: '1' }
            });

            return result('done', `${installed ? 'updated' : 'installed'} ${PLUGIN_ID} in ${kimiHome(system)}`, NEXT);
        });
    },

    async remove (system) {
        const { installed } = await kimi.status(system);

        return installed === false ?
            result('skipped', 'not installed') :
            result('manual', 'Kimi Code has no shell command to uninstall a plugin', 'Run `/plugins remove postman` inside Kimi Code.');
    }
};
