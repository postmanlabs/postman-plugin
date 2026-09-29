import type { System } from '../system.js';
import { blocked, guard, mustProbeJson, mustRun, parseJson } from './shared.js';
import { type Host, result } from './types.js';

// Anthropic's catalog entry is the Claude Code install; our own marketplace
// would register the same skills a second time under `postman@postman`.
const MARKETPLACE = { name: 'claude-plugins-official', repo: 'anthropics/claude-plugins-official' },
    PLUGIN_ID = `postman@${MARKETPLACE.name}`,
    SHADOW_IDS = ['postman@postman'],
    SCOPE = 'user',
    NEXT = 'Restart Claude Code for the change to take effect.';

type Marketplace = { name: string; source?: string; repo?: string; url?: string; path?: string };
type InstalledPlugin = { id: string; scope: string; version?: string; projectPath?: string };

const isOurs = (plugin: InstalledPlugin) => plugin.id === PLUGIN_ID || SHADOW_IDS.includes(plugin.id);

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
        existing = marketplaces.find((marketplace) => marketplace.name === MARKETPLACE.name);

    if (!existing) {
        await mustRun(system, 'claude', ['plugin', 'marketplace', 'add', MARKETPLACE.repo, '--scope', SCOPE]);

        return;
    }

    if (existing.repo !== MARKETPLACE.repo) {
        blocked(`marketplace ${MARKETPLACE.name} is registered from ${existing.repo ?? existing.url ?? existing.path ?? 'an unknown source'}, not ${MARKETPLACE.repo}`);
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

            await uninstallAtUserScope(system, plugins, SHADOW_IDS);

            await mustRun(system, 'claude', ['plugin', verb, PLUGIN_ID, '--scope', SCOPE, '--json']);

            return result('done', `${verb === 'update' ? 'updated' : 'installed'} ${PLUGIN_ID}`, NEXT);
        });
    },

    remove (system) {
        return guard(async () => {
            const plugins = await listPlugins(system),
                ids = [PLUGIN_ID, ...SHADOW_IDS].filter((id) => plugins.some((plugin) => plugin.id === id && plugin.scope === SCOPE));

            if (!ids.length) {
                return result('skipped', 'not installed at user scope');
            }

            await uninstallAtUserScope(system, plugins, ids);

            return result('done', `uninstalled ${ids.join(', ')}`, NEXT);
        });
    }
};
