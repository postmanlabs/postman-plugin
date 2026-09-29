import { REPO, isSameRepo } from '../source.js';
import type { System } from '../system.js';
import { blocked, guard, mustProbeJson, mustRun, parseJson } from './shared.js';
import { type Host, result } from './types.js';

// Codex names the marketplace after `.claude-plugin/marketplace.json`'s `name`.
// `npx plugins add` installs a second copy under its own `plugins-cli` marketplace.
const MARKETPLACE = 'postman',
    PLUGIN_ID = `postman@${MARKETPLACE}`,
    SHADOW_IDS = ['postman@plugins-cli'],
    NEXT = 'Restart Codex for the change to take effect.';

type Marketplace = { name: string; marketplaceSource?: { sourceType?: string; source?: string } };
type InstalledPlugin = { pluginId: string; installed?: boolean; version?: string };

function isInstalled (plugins: InstalledPlugin[], id: string): boolean {
    return plugins.some((plugin) => plugin.pluginId === id && plugin.installed !== false);
}

async function listPlugins (system: System): Promise<InstalledPlugin[]> {
    return (await mustProbeJson<{ installed?: InstalledPlugin[] }>(system, 'codex', ['plugin', 'list', '--json'])).installed ?? [];
}

async function refreshMarketplace (system: System): Promise<void> {
    const listing = await mustProbeJson<{ marketplaces?: Marketplace[] }>(system, 'codex', ['plugin', 'marketplace', 'list', '--json']),
        existing = listing.marketplaces?.find((marketplace) => marketplace.name === MARKETPLACE);

    if (!existing) {
        await mustRun(system, 'codex', ['plugin', 'marketplace', 'add', REPO, '--json']);

        return;
    }

    const source = existing.marketplaceSource?.source;

    if (!isSameRepo(source, REPO)) {
        blocked(`marketplace ${MARKETPLACE} is registered from ${source ?? 'an unknown source'}, not ${REPO}`);
    }

    await mustRun(system, 'codex', ['plugin', 'marketplace', 'upgrade', MARKETPLACE, '--json']);
}

async function removeInstalled (system: System, plugins: InstalledPlugin[], ids: string[]): Promise<string[]> {
    const present = ids.filter((id) => isInstalled(plugins, id));

    for (const id of present) {
        await mustRun(system, 'codex', ['plugin', 'remove', id, '--json']);
    }

    return present;
}

export const codex: Host = {
    id: 'codex',
    name: 'Codex',
    route: '.codex-plugin',

    async detect (system) {
        return (await system.which('codex')) !== null;
    },

    async status (system) {
        const exec = await system.probe('codex', ['plugin', 'list', '--json']),
            plugins = exec.code === 0 ? parseJson<{ installed?: InstalledPlugin[] }>(exec.stdout)?.installed : null;

        if (!Array.isArray(plugins)) {
            return { installed: null, detail: 'could not read `codex plugin list --json`', notes: [] };
        }

        const installed = plugins.find((plugin) => plugin.pluginId === PLUGIN_ID && plugin.installed !== false),
            notes = SHADOW_IDS.filter((id) => isInstalled(plugins, id)).map((id) => `${id} duplicates it and will be removed`);

        return installed ?
            { installed: true, detail: `${PLUGIN_ID} ${installed.version ?? ''}`.trim(), notes } :
            { installed: false, detail: 'not installed', notes };
    },

    install (system) {
        return guard(async () => {
            await refreshMarketplace(system);

            const plugins = await listPlugins(system),
                wasInstalled = isInstalled(plugins, PLUGIN_ID);

            await removeInstalled(system, plugins, SHADOW_IDS);
            // `add` is idempotent and is also how Codex updates an installed plugin.
            await mustRun(system, 'codex', ['plugin', 'add', PLUGIN_ID, '--json']);

            return result('done', `${wasInstalled ? 'updated' : 'installed'} ${PLUGIN_ID}`, NEXT);
        });
    },

    remove (system) {
        return guard(async () => {
            const removed = await removeInstalled(system, await listPlugins(system), [PLUGIN_ID, ...SHADOW_IDS]);

            return removed.length ?
                result('done', `removed ${removed.join(', ')}`, NEXT) :
                result('skipped', 'not installed');
        });
    }
};
