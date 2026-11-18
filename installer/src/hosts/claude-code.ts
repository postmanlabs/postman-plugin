import path from 'node:path';
import { commandsFor } from '../agent-commands.js';
import { BRANCH, REPO, isSameRepo, redact } from '../source.js';
import type { System } from '../system.js';
import { blocked, failed, guard, mustProbeJson, mustRun, parseJson } from './shared.js';
import { type Host, result } from './types.js';

const COMMANDS = commandsFor('claude-code');

// This repo's own marketplace, so a route release reaches users without waiting on a bump in Anthropic's catalog.
const MARKETPLACE = { name: 'postman', repo: REPO },
    PLUGIN_ID = `postman@${MARKETPLACE.name}`,
    // Anthropic's catalog entry, installed by earlier releases. Two enabled copies load every skill twice and drop one copy's hooks.
    SHADOW_IDS = ['postman@claude-plugins-official'],
    SCOPE = 'user',
    NEXT = 'Restart Claude Code for the change to take effect.';

type MarketplaceSource = { source?: string; repo?: string; url?: string; ref?: string };
type Marketplace = MarketplaceSource & { name: string; path?: string };
type InstalledPlugin = { id: string; scope: string; version?: string; projectPath?: string };
type MarketplaceEntry = { source?: MarketplaceSource; autoUpdate?: boolean };
type ClaudeSettings = { extraKnownMarketplaces?: Record<string, MarketplaceEntry> };

const isOurs = (plugin: InstalledPlugin) => plugin.id === PLUGIN_ID || SHADOW_IDS.includes(plugin.id);

// A `url` source fetches one marketplace.json instead of cloning, so a URL names the repo only in a `git` source.
function isOurSource (marketplace: MarketplaceSource): boolean {
    return isSameRepo(marketplace.repo, MARKETPLACE.repo) ||
        (marketplace.source === 'git' && isSameRepo(marketplace.url, MARKETPLACE.repo));
}

function assertTracksMain (source: MarketplaceSource, location: string): void {
    if (source.ref && source.ref !== BRANCH && source.ref !== `refs/heads/${BRANCH}`) {
        blocked(`marketplace ${MARKETPLACE.name} is pinned to ${JSON.stringify(redact(source.ref))} in ${location}, not ${BRANCH}; ` +
            `set extraKnownMarketplaces.${MARKETPLACE.name}.source.ref to ${BRANCH} (or remove the ref) in the settings that declare it, ` +
            'start a Claude Code session to refresh the marketplace, then re-run');
    }
}

function describeSource (marketplace: { repo?: string; url?: string; path?: string }): string {
    const source = marketplace.repo ?? marketplace.url ?? marketplace.path;

    return source ? redact(source) : 'an unknown source';
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
    const marketplaces = await mustProbeJson<Marketplace[]>(system, 'claude', COMMANDS.listMarketplaces),
        registered = marketplaces.find((marketplace) => marketplace.name === MARKETPLACE.name);

    if (registered) {
        if (!isOurSource(registered)) {
            blocked(`marketplace ${MARKETPLACE.name} is registered from ${describeSource(registered)}, not ${MARKETPLACE.repo}`);
        }

        assertTracksMain(registered, 'the registered source');
    }

    // Settings can declare a different ref before Claude's next session reconciles the cached registration.
    const file = settingsFile(system),
        text = await system.readFile(file),
        source = text === null ? undefined : parseJson<ClaudeSettings>(text)?.extraKnownMarketplaces?.[MARKETPLACE.name]?.source;

    if (source) {
        if (!isOurSource(source)) {
            blocked(`marketplace ${MARKETPLACE.name} is declared in ${file} from ${describeSource(source)}, not ${MARKETPLACE.repo}`);
        }

        assertTracksMain(source, file);
    }

    await mustRun(system, 'claude', registered ? COMMANDS.updateMarketplace : COMMANDS.addMarketplace);
}

function settingsFile (system: System): string {
    return path.join(system.env.CLAUDE_CONFIG_DIR || path.join(system.home, '.claude'), 'settings.json');
}

/**
 * Third-party marketplaces don't auto-update by default and marketplace.json can't change that, so this sets
 * `autoUpdate` on the entry `marketplace add` wrote: the same key the /plugin Marketplaces toggle writes.
 * A value the user already chose is kept.
 */
async function enableAutoUpdate (system: System): Promise<boolean> {
    const file = settingsFile(system),
        text = await system.readFile(file),
        settings = text === null ? null : parseJson<ClaudeSettings>(text),
        entry = settings?.extraKnownMarketplaces?.[MARKETPLACE.name],
        toggle = `turn it on under /plugin → Marketplaces → ${MARKETPLACE.name}`;

    if (!settings || !entry?.source || !isOurSource(entry.source)) {
        system.log(`  note: ${system.dryRun ? 'would turn on' : 'could not turn on'} auto-update in ${file}; ${toggle}`);

        return false;
    }

    if (entry.autoUpdate !== undefined) {
        if (!entry.autoUpdate) {
            system.log(`  note: auto-update for ${MARKETPLACE.name} is off in ${file}, as set there; ${toggle} to get new releases at session start`);
        }

        return entry.autoUpdate;
    }

    entry.autoUpdate = true;
    await system.writeFile(file, `${JSON.stringify(settings, null, 2)}\n`);

    return true;
}

async function uninstallAtUserScope (system: System, plugins: InstalledPlugin[], ids: string[]): Promise<void> {
    for (const id of ids) {
        if (plugins.some((plugin) => plugin.id === id && plugin.scope === SCOPE)) {
            await mustRun(system, 'claude', id === PLUGIN_ID ? COMMANDS.remove : ['plugin', 'uninstall', id, '--scope', SCOPE, '--json']);
        }
    }
}

/**
 * Removes this repo's marketplace from user settings once no plugin at any scope comes from it.
 * `marketplace remove` leaves the records of plugins still installed from it behind (anthropics/claude-code#17061).
 */
async function removeMarketplace (system: System, plugins: InstalledPlugin[]): Promise<boolean> {
    const marketplaces = await mustProbeJson<Marketplace[]>(system, 'claude', COMMANDS.listMarketplaces),
        registered = marketplaces.find((marketplace) => marketplace.name === MARKETPLACE.name);

    if (!registered) {
        return false;
    }

    if (!isOurSource(registered)) {
        system.log(`  note: marketplace ${MARKETPLACE.name} is registered from ${describeSource(registered)}, not ${REPO}; left alone`);

        return false;
    }

    const serving = plugins.filter((plugin) => plugin.id.endsWith(`@${MARKETPLACE.name}`));

    if (serving.length) {
        system.log(`  note: marketplace ${MARKETPLACE.name} still serves ${serving.map((plugin) => `${plugin.id} (${plugin.projectPath ?? plugin.scope})`).join(', ')}; left alone`);

        return false;
    }

    // User scope only: a project's settings are shared with everyone who works in it.
    const exec = await system.run('claude', ['plugin', 'marketplace', 'remove', MARKETPLACE.name, '--scope', SCOPE, '--json']);

    if (exec.code !== 0) {
        system.log(`  note: could not remove marketplace ${MARKETPLACE.name} from user settings, so it was left alone: ${(exec.stderr || exec.stdout).trim()}`);

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
            await mustRun(system, 'claude', COMMANDS[verb]);
            await uninstallAtUserScope(system, plugins, SHADOW_IDS);

            const autoUpdate = await enableAutoUpdate(system);

            return result('done', `${verb === 'update' ? 'updated' : 'installed'} ${PLUGIN_ID}${autoUpdate ? ', auto-update on' : ''}`, NEXT);
        });
    },

    remove (system) {
        return guard(async () => {
            const plugins = await listPlugins(system),
                ids = [PLUGIN_ID, ...SHADOW_IDS].filter((id) => plugins.some((plugin) => plugin.id === id && plugin.scope === SCOPE));
            let remaining = plugins.filter((plugin) => !(ids.includes(plugin.id) && plugin.scope === SCOPE));

            await uninstallAtUserScope(system, plugins, ids);

            // status() sees only our own ID, so the official copy's removal is confirmed here.
            if (ids.length && !system.dryRun) {
                remaining = await listPlugins(system);

                const left = ids.filter((id) => remaining.some((plugin) => plugin.id === id && plugin.scope === SCOPE));

                if (left.length) {
                    failed(`uninstall exited 0, but ${left.join(', ')} is still installed at user scope`);
                }
            }

            const removals = [
                ...(ids.length ? [`uninstalled ${ids.join(', ')}`] : []),
                ...(await removeMarketplace(system, remaining) ? [`removed marketplace ${MARKETPLACE.name}`] : [])
            ];

            return removals.length ?
                result('done', removals.join(' and '), NEXT) :
                result('skipped', 'not installed at user scope');
        });
    }
};
