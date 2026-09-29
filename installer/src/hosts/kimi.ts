import path from 'node:path';
import { PLUGINS_CLI, REPO } from '../source.js';
import type { System } from '../system.js';
import { blocked, guard, mustRun, parseJson } from './shared.js';
import { type Host, result } from './types.js';

// Kimi Code installs plugins only from its TUI (`/plugins install`), so the
// `plugins` CLI writes its plugin store instead. Kimi records it as a local path.
const PLUGIN_ID = 'postman',
    NEXT = 'Restart Kimi Code for the change to take effect.',
    kimiHome = (system: System) => system.env.KIMI_CODE_HOME || path.join(system.home, '.kimi-code'),
    installedFile = (system: System) => path.join(kimiHome(system), 'plugins', 'installed.json'),
    binary = (system: System) => `kimi${system.platform === 'win32' ? '.exe' : ''}`;

// The same places `plugins` looks, so both agree on whether Kimi is here.
function binaryCandidates (system: System): string[] {
    return [
        path.join(kimiHome(system), 'bin', binary(system)),
        path.join(system.home, '.local', 'bin', binary(system)),
        path.join(system.home, '.kimi', 'bin', binary(system))
    ];
}

export const kimi: Host = {
    id: 'kimi',
    name: 'Kimi Code',
    route: '.kimi-plugin',

    async detect (system) {
        if (await system.which('kimi')) {
            return true;
        }

        for (const candidate of binaryCandidates(system)) {
            if (await system.exists(candidate)) {
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

            await mustRun(system, 'npx', ['-y', PLUGINS_CLI, 'add', REPO, '--target', 'kimi', '--yes'], {
                env: { DISABLE_TELEMETRY: '1', DO_NOT_TRACK: '1' }
            });

            return result('done', `installed ${PLUGIN_ID} into ${kimiHome(system)}`, NEXT);
        });
    },

    async remove (system) {
        const { installed } = await kimi.status(system);

        return installed === false ?
            result('skipped', 'not installed') :
            result('manual', 'Kimi Code has no shell command to uninstall a plugin', 'Run `/plugins remove postman` inside Kimi Code.');
    }
};
