import { REPO, isSameRepo, redact } from '../source.js';
import type { System } from '../system.js';
import { guard, mustProbeJson, mustRun, parseJson } from './shared.js';
import { type Host, result } from './types.js';

// Copilot CLI is deprecating direct installs (repos, URLs, local paths), so this installs from this
// repo as a marketplace, which Copilot reads from `.claude-plugin/marketplace.json`. Once Postman is
// listed in awesome-copilot, which Copilot ships registered, `postman@awesome-copilot` replaces it.
const PLUGIN_NAME = 'postman',
    MARKETPLACE = 'postman',
    PLUGIN_ID = `${PLUGIN_NAME}@${MARKETPLACE}`,
    NEXT = 'Restart Copilot CLI (or run /restart) for the change to take effect.';

// `copilot plugin list --json` rows, per the Copilot CLI plugin reference.
type InstalledPlugin = { name: string; marketplace?: string; version?: string; enabled?: boolean; source?: string };

// `source` reads like `GitHub: owner/repo` in Copilot CLI 1.0.
type Marketplace = { name: string; source?: string };

const isOurs = (plugin: InstalledPlugin) => plugin.name === PLUGIN_NAME,
    // A direct install has no marketplace; it would load the same skills a second time.
    isDirect = (plugin: InstalledPlugin) => isOurs(plugin) && !plugin.marketplace;

/** Unregisters this repo's marketplace once nothing installed comes from it; without `--force` Copilot refuses otherwise too. */
async function removeMarketplace (system: System, plugins: InstalledPlugin[]): Promise<boolean> {
    const marketplaces = await mustProbeJson<Marketplace[]>(system, 'copilot', ['plugin', 'marketplace', 'list', '--json']),
        registered = marketplaces.find((marketplace) => marketplace.name === MARKETPLACE);

    if (!registered) {
        return false;
    }

    const source = registered.source?.replace(/^GitHub:\s*/i, '');

    if (!isSameRepo(source, REPO)) {
        system.log(`  note: marketplace ${MARKETPLACE} is registered from ${source ? redact(source) : 'an unknown source'}, not ${REPO}; left alone`);

        return false;
    }

    const serving = plugins.filter((plugin) => plugin.marketplace === MARKETPLACE);

    if (serving.length) {
        system.log(`  note: marketplace ${MARKETPLACE} still serves ${serving.map((plugin) => plugin.name).join(', ')}; left alone`);

        return false;
    }

    await mustRun(system, 'copilot', ['plugin', 'marketplace', 'remove', MARKETPLACE]);

    return true;
}

export const copilot: Host = {
    id: 'copilot',
    name: 'GitHub Copilot CLI',
    route: '.github/plugin',

    async detect (system) {
        return (await system.which('copilot')) !== null;
    },

    async status (system) {
        const exec = await system.probe('copilot', ['plugin', 'list', '--json']),
            plugins = exec.code === 0 ? parseJson<InstalledPlugin[]>(exec.stdout) : null;

        if (!Array.isArray(plugins)) {
            return { installed: null, detail: 'could not read `copilot plugin list --json`', notes: [] };
        }

        const installed = plugins.find(isOurs);

        if (!installed) {
            return { installed: false, detail: 'not installed', notes: [] };
        }

        return {
            installed: true,
            detail: `${PLUGIN_NAME} ${installed.version ?? ''}`.trim(),
            notes: installed.enabled === false ? ['installed but disabled; run `copilot plugin enable postman`'] : []
        };
    },

    install (system) {
        return guard(async () => {
            const plugins = await mustProbeJson<InstalledPlugin[]>(system, 'copilot', ['plugin', 'list', '--json']),
                marketplaces = await mustProbeJson<Marketplace[]>(system, 'copilot', ['plugin', 'marketplace', 'list', '--json']),
                current = plugins.some((plugin) => isOurs(plugin) && plugin.marketplace === MARKETPLACE);

            if (marketplaces.some((marketplace) => marketplace.name === MARKETPLACE)) {
                await mustRun(system, 'copilot', ['plugin', 'marketplace', 'update', MARKETPLACE]);
            }
            else {
                await mustRun(system, 'copilot', ['plugin', 'marketplace', 'add', REPO]);
            }

            // The same name can't be installed twice, so a direct install goes first.
            if (plugins.some(isDirect)) {
                await mustRun(system, 'copilot', ['plugin', 'uninstall', PLUGIN_NAME]);
            }

            await mustRun(system, 'copilot', current ? ['plugin', 'update', PLUGIN_NAME] : ['plugin', 'install', PLUGIN_ID]);

            return result('done', `${current ? 'updated' : 'installed'} ${PLUGIN_ID}`, NEXT);
        });
    },

    remove (system) {
        return guard(async () => {
            const plugins = await mustProbeJson<InstalledPlugin[]>(system, 'copilot', ['plugin', 'list', '--json']),
                wasInstalled = plugins.some(isOurs);
            let remaining = plugins.filter((plugin) => !isOurs(plugin));

            if (wasInstalled) {
                await mustRun(system, 'copilot', ['plugin', 'uninstall', PLUGIN_NAME]);

                if (!system.dryRun) {
                    remaining = await mustProbeJson<InstalledPlugin[]>(system, 'copilot', ['plugin', 'list', '--json']);
                }
            }

            const removals = [
                ...(wasInstalled ? [`uninstalled ${PLUGIN_NAME}`] : []),
                ...(await removeMarketplace(system, remaining) ? [`removed marketplace ${MARKETPLACE}`] : [])
            ];

            return removals.length ? result('done', removals.join(' and '), NEXT) : result('skipped', 'not installed');
        });
    }
};
