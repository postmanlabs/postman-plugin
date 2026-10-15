import { REPO } from '../source.js';
import { guard, mustProbeJson, mustRun, parseJson } from './shared.js';
import { type Host, result } from './types.js';

// `agy plugin install` clones a git URL into ~/.gemini/config/plugins/<name>. It has no update
// command; installing again replaces the copy in place, so a re-run is the update.
const PLUGIN_NAME = 'postman',
    SOURCE = `https://github.com/${REPO}`,
    NEXT = 'Restart Antigravity for the change to take effect.';

// `agy plugin list --json` rows, as agy 1.3.5 prints them.
type InstalledPlugin = { name: string; enabled?: boolean; version?: string; path?: string };

const isOurs = (plugin: InstalledPlugin) => plugin.name === PLUGIN_NAME;

export const antigravity: Host = {
    id: 'antigravity',
    name: 'Antigravity',
    route: '.antigravity-plugin',

    async detect (system) {
        return (await system.which('agy')) !== null;
    },

    async status (system) {
        const exec = await system.probe('agy', ['plugin', 'list', '--json']),
            plugins = exec.code === 0 ? parseJson<InstalledPlugin[]>(exec.stdout) : null;

        if (!Array.isArray(plugins)) {
            return { installed: null, detail: 'could not read `agy plugin list --json`', notes: [] };
        }

        const installed = plugins.find(isOurs);

        if (!installed) {
            return { installed: false, detail: 'not installed', notes: [] };
        }

        return {
            installed: true,
            detail: `${PLUGIN_NAME} ${installed.version ?? ''}`.trim(),
            notes: installed.enabled === false ? ['installed but disabled; run `agy plugin enable postman`'] : []
        };
    },

    install (system) {
        return guard(async () => {
            const plugins = await mustProbeJson<InstalledPlugin[]>(system, 'agy', ['plugin', 'list', '--json']),
                current = plugins.some(isOurs);

            await mustRun(system, 'agy', ['plugin', 'install', SOURCE]);

            return result('done', `${current ? 'updated' : 'installed'} ${PLUGIN_NAME}`, NEXT);
        });
    },

    remove (system) {
        return guard(async () => {
            const plugins = await mustProbeJson<InstalledPlugin[]>(system, 'agy', ['plugin', 'list', '--json']);

            if (!plugins.some(isOurs)) {
                return result('skipped', 'not installed');
            }

            await mustRun(system, 'agy', ['plugin', 'uninstall', PLUGIN_NAME]);

            return result('done', `uninstalled ${PLUGIN_NAME}`, NEXT);
        });
    }
};
