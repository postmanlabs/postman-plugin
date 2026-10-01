import { GIT_URL, REPO, isSameRepo, redact } from '../source.js';
import type { System } from '../system.js';
import { blocked, guard, mustProbeText, mustRun } from './shared.js';
import { type Host, result } from './types.js';

const MARKETPLACE = 'postman-plugin',
    PLUGIN_ID = `postman@${MARKETPLACE}`,
    SCOPE = 'user',
    NEXT = 'Restart Droid for the change to take effect.';

function hasInstalledPlugin (text: string): boolean {
    return text.split('\n').some((line) => new RegExp(`^${PLUGIN_ID}\\s+\\[${SCOPE}\\]`).test(line.trimStart()));
}

function marketplaceSource (text: string): string | null {
    for (const line of text.split('\n')) {
        const match = /^\s*(\S+)\s+\(\d+ plugins?\)\s+(.+?)(?:\s+"[^"]*")?\s*$/.exec(line);

        if (match && match[1] === MARKETPLACE) {
            return match[2];
        }
    }

    return null;
}

function sourceWithoutFactoryPrefix (source: string): string {
    return source.replace(/^(?:github|url):/, '');
}

async function listPlugins (system: System): Promise<string> {
    return mustProbeText(system, 'droid', ['plugin', 'list', '--scope', SCOPE]);
}

async function refreshMarketplace (system: System): Promise<void> {
    const source = marketplaceSource(await mustProbeText(system, 'droid', ['plugin', 'marketplace', 'list']));

    if (!source) {
        await mustRun(system, 'droid', ['plugin', 'marketplace', 'add', GIT_URL]);

        return;
    }

    if (!isSameRepo(sourceWithoutFactoryPrefix(source), REPO)) {
        blocked(`marketplace ${MARKETPLACE} is registered from ${redact(source)}, not ${REPO}`);
    }

    await mustRun(system, 'droid', ['plugin', 'marketplace', 'update', MARKETPLACE]);
}

export const factory: Host = {
    id: 'factory',
    name: 'Factory Droid',
    route: '.factory-plugin',

    async detect (system) {
        return (await system.which('droid')) !== null;
    },

    async status (system) {
        const exec = await system.probe('droid', ['plugin', 'list', '--scope', SCOPE]);

        if (exec.code !== 0) {
            return { installed: null, detail: 'could not read `droid plugin list --scope user`', notes: [] };
        }

        return hasInstalledPlugin(exec.stdout) ?
            { installed: true, detail: PLUGIN_ID, notes: [] } :
            { installed: false, detail: 'not installed', notes: [] };
    },

    install (system) {
        return guard(async () => {
            await refreshMarketplace(system);

            const wasInstalled = hasInstalledPlugin(await listPlugins(system)),
                verb = wasInstalled ? 'update' : 'install';

            await mustRun(system, 'droid', ['plugin', verb, PLUGIN_ID, '--scope', SCOPE]);

            return result('done', `${wasInstalled ? 'updated' : 'installed'} ${PLUGIN_ID}`, NEXT);
        });
    },

    remove (system) {
        return guard(async () => {
            if (!hasInstalledPlugin(await listPlugins(system))) {
                return result('skipped', 'not installed');
            }

            await mustRun(system, 'droid', ['plugin', 'uninstall', PLUGIN_ID, '--scope', SCOPE]);

            return result('done', `uninstalled ${PLUGIN_ID}`, NEXT);
        });
    }
};
