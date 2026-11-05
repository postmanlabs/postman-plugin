import { REPO, isSameRepo, redact } from '../source.js';
import type { System } from '../system.js';
import { blocked, failed, guard, mustProbeJson, mustRun, parseJson } from './shared.js';
import { type Host, result } from './types.js';

// Anthropic's catalog entry is the Claude Code install; our own marketplace
// would register the same skills a second time under `postman@postman`.
const MARKETPLACE = { name: 'claude-plugins-official', repo: 'anthropics/claude-plugins-official' },
    PLUGIN_ID = `postman@${MARKETPLACE.name}`,
    SHADOW_IDS = ['postman@postman'],
    // This repo's own marketplace, which the README once had users add; no release of the installer added it.
    OWN_MARKETPLACE = 'postman',
    SCOPE = 'user',
    NEXT = 'Restart Claude Code for the change to take effect.';

type Marketplace = { name: string; source?: string; repo?: string; url?: string; path?: string };
type InstalledPlugin = { id: string; scope: string; version?: string; projectPath?: string };

const isOurs = (plugin: InstalledPlugin) => plugin.id === PLUGIN_ID || SHADOW_IDS.includes(plugin.id);

// A `url` source fetches one marketplace.json instead of cloning, so a URL names the repo only in a `git` source.
function isOfficialSource (marketplace: Marketplace): boolean {
    return isSameRepo(marketplace.repo, MARKETPLACE.repo) ||
        (marketplace.source === 'git' && isSameRepo(marketplace.url, MARKETPLACE.repo));
}

function listPlugins (system: System): Promise<InstalledPlugin[]> {
    return mustProbeJson<InstalledPlugin[]>(system, 'claude', ['plugin', 'list', '--json']);
}

function otherScopeNotes (plugins: InstalledPlugin[]): string[] {
    const projects = new Map<string, Set<string>>();

    for (const plugin of plugins.filter((entry) => isOurs(entry) && entry.scope !== SCOPE)) {
        projects.set(plugin.id, (projects.get(plugin.id) ?? new Set()).add(plugin.projectPath ?? plugin.scope));
    }

    return [...projects].map(([id, paths]) =>
        `${id} is also installed at project or local scope in ${paths.size} project${paths.size === 1 ? '' : 's'}; left alone`);
}

async function refreshMarketplace (system: System): Promise<void> {
    const marketplaces = await mustProbeJson<Marketplace[]>(system, 'claude', ['plugin', 'marketplace', 'list', '--json']),
        registered = marketplaces.find((marketplace) => marketplace.name === MARKETPLACE.name);

    if (!registered) {
        await mustRun(system, 'claude', ['plugin', 'marketplace', 'add', MARKETPLACE.repo, '--scope', SCOPE]);

        return;
    }

    if (!isOfficialSource(registered)) {
        const source = registered.repo ?? registered.url ?? registered.path;

        blocked(`marketplace ${MARKETPLACE.name} is registered from ${source ? redact(source) : 'an unknown source'}, not ${MARKETPLACE.repo}`);
    }

    await mustRun(system, 'claude', ['plugin', 'marketplace', 'update', MARKETPLACE.name]);
}

async function uninstallAtUserScope (system: System, plugins: InstalledPlugin[], ids: string[]): Promise<void> {
    for (const id of ids) {
        if (plugins.some((plugin) => plugin.id === id && plugin.scope === SCOPE)) {
            await mustRun(system, 'claude', ['plugin', 'uninstall', id, '--scope', SCOPE, '--json']);
        }
    }
}

/**
 * Removes this repo's own marketplace from user settings once no plugin at any scope comes from it.
 * `marketplace remove` leaves the records of plugins still installed from it behind (anthropics/claude-code#17061).
 */
async function removeOwnMarketplace (system: System, plugins: InstalledPlugin[]): Promise<boolean> {
    const marketplaces = await mustProbeJson<Marketplace[]>(system, 'claude', ['plugin', 'marketplace', 'list', '--json']),
        registered = marketplaces.find((marketplace) => marketplace.name === OWN_MARKETPLACE);

    if (!registered) {
        return false;
    }

    if (!isSameRepo(registered.repo, REPO) && !(registered.source === 'git' && isSameRepo(registered.url, REPO))) {
        const source = registered.repo ?? registered.url ?? registered.path;

        system.log(`  note: marketplace ${OWN_MARKETPLACE} is registered from ${source ? redact(source) : 'an unknown source'}, not ${REPO}; left alone`);

        return false;
    }

    const serving = plugins.filter((plugin) => plugin.id.endsWith(`@${OWN_MARKETPLACE}`));

    if (serving.length) {
        system.log(`  note: marketplace ${OWN_MARKETPLACE} still serves ${serving.map((plugin) => `${plugin.id} (${plugin.projectPath ?? plugin.scope})`).join(', ')}; left alone`);

        return false;
    }

    // User scope only: a project's settings are shared with everyone who works in it.
    const exec = await system.run('claude', ['plugin', 'marketplace', 'remove', OWN_MARKETPLACE, '--scope', SCOPE, '--json']);

    if (exec.code !== 0) {
        system.log(`  note: could not remove marketplace ${OWN_MARKETPLACE} from user settings, so it was left alone: ${(exec.stderr || exec.stdout).trim()}`);

        return false;
    }

    return true;
}

export const claudeCode: Host = {
    id: 'claude-code',
    name: 'Claude Code',
    route: '.claude-plugin',

    async detect (system) {
        return (await system.which('claude')) !== null;
    },

    async status (system) {
        const exec = await system.probe('claude', ['plugin', 'list', '--json']),
            plugins = exec.code === 0 ? parseJson<InstalledPlugin[]>(exec.stdout) : null;

        if (!Array.isArray(plugins)) {
            return { installed: null, detail: 'could not read `claude plugin list --json`', notes: [] };
        }

        const installed = plugins.find((plugin) => plugin.id === PLUGIN_ID && plugin.scope === SCOPE),
            shadows = plugins.filter((plugin) => SHADOW_IDS.includes(plugin.id) && plugin.scope === SCOPE),
            notes = [
                ...shadows.map((plugin) => `${plugin.id} (${SCOPE} scope) duplicates it and will be uninstalled`),
                ...otherScopeNotes(plugins)
            ];

        return installed ?
            { installed: true, detail: `${PLUGIN_ID} ${installed.version ?? ''}`.trim(), notes } :
            { installed: false, detail: 'not installed', notes };
    },

    install (system) {
        return guard(async () => {
            await refreshMarketplace(system);

            const plugins = await listPlugins(system),
                verb = plugins.some((plugin) => plugin.id === PLUGIN_ID && plugin.scope === SCOPE) ? 'update' : 'install';

            // Replacement first: if it fails, the duplicate is still a working copy.
            await mustRun(system, 'claude', ['plugin', verb, PLUGIN_ID, '--scope', SCOPE, '--json']);
            await uninstallAtUserScope(system, plugins, SHADOW_IDS);

            return result('done', `${verb === 'update' ? 'updated' : 'installed'} ${PLUGIN_ID}`, NEXT);
        });
    },

    remove (system) {
        return guard(async () => {
            const plugins = await listPlugins(system),
                ids = [PLUGIN_ID, ...SHADOW_IDS].filter((id) => plugins.some((plugin) => plugin.id === id && plugin.scope === SCOPE));
            let remaining = plugins.filter((plugin) => !(ids.includes(plugin.id) && plugin.scope === SCOPE));

            await uninstallAtUserScope(system, plugins, ids);

            // status() sees only the official ID, so the duplicate's removal is confirmed here.
            if (ids.length && !system.dryRun) {
                remaining = await listPlugins(system);

                const left = ids.filter((id) => remaining.some((plugin) => plugin.id === id && plugin.scope === SCOPE));

                if (left.length) {
                    failed(`uninstall exited 0, but ${left.join(', ')} is still installed at user scope`);
                }
            }

            const removals = [
                ...(ids.length ? [`uninstalled ${ids.join(', ')}`] : []),
                ...(await removeOwnMarketplace(system, remaining) ? [`removed marketplace ${OWN_MARKETPLACE}`] : [])
            ];

            return removals.length ?
                result('done', removals.join(' and '), NEXT) :
                result('skipped', 'not installed at user scope');
        });
    }
};
