import path from 'node:path';
import { CODEX_REF, REPO, isSameRepo, redact } from '../source.js';
import type { System } from '../system.js';
import { blocked, failed, guard, mustProbeJson, mustRun, parseJson } from './shared.js';
import { type Host, result } from './types.js';

// Codex names the marketplace after `.claude-plugin/marketplace.json`'s `name`.
// `npx plugins add` installs a second copy under its own `plugins-cli` marketplace.
const MARKETPLACE = 'postman',
    PLUGIN_ID = `postman@${MARKETPLACE}`,
    SHADOW_IDS = ['postman@plugins-cli'],
    NEXT = 'Restart Codex for the change to take effect.';

type Marketplace = { name: string; marketplaceSource?: { sourceType?: string; source?: string } };
/** A marketplace's ref as Codex's user config records it: `null` when it has none, `undefined` when it has no table there. */
type Ref = string | null | undefined;
type InstalledPlugin = { pluginId: string; installed?: boolean; version?: string };

function isInstalled (plugins: InstalledPlugin[], id: string): boolean {
    return plugins.some((plugin) => plugin.pluginId === id && plugin.installed !== false);
}

async function listPlugins (system: System): Promise<InstalledPlugin[]> {
    return (await mustProbeJson<{ installed?: InstalledPlugin[] }>(system, 'codex', ['plugin', 'list', '--json'])).installed ?? [];
}

const configFile = (system: System) => path.join(system.env.CODEX_HOME || path.join(system.home, '.codex'), 'config.toml');

/** Reads `ref` from the `[marketplaces.<name>]` table Codex writes. `marketplace list --json` doesn't report it. */
export function marketplaceRef (toml: string, name: string): Ref {
    const header = new RegExp(`^\\s*\\[\\s*marketplaces\\s*\\.\\s*(["']?)${name}\\1\\s*\\]\\s*(#.*)?$`),
        lines = toml.split(/\r?\n/),
        start = lines.findIndex((line) => header.test(line));

    if (start === -1) {
        return undefined;
    }

    for (const line of lines.slice(start + 1)) {
        if (/^\s*\[/.test(line)) {
            break;
        }

        const ref = line.match(/^\s*ref\s*=\s*(?:"([^"]*)"|'([^']*)')\s*(#.*)?$/);

        if (ref) {
            return ref[1] ?? ref[2];
        }
    }

    return null;
}

async function addMarketplace (system: System): Promise<void> {
    await mustRun(system, 'codex', ['plugin', 'marketplace', 'add', REPO, '--ref', CODEX_REF, '--json']);
    // `add` records no revision, so without this Codex's next startup refetches the plugin and asks for approval again.
    await mustRun(system, 'codex', ['plugin', 'marketplace', 'upgrade', MARKETPLACE, '--json']);
}

async function refreshMarketplace (system: System): Promise<void> {
    const listing = await mustProbeJson<{ marketplaces?: Marketplace[] }>(system, 'codex', ['plugin', 'marketplace', 'list', '--json']),
        existing = listing.marketplaces?.find((marketplace) => marketplace.name === MARKETPLACE);

    if (!existing) {
        await addMarketplace(system);

        return;
    }

    // A local marketplace can carry any path text, so only a git source counts as this repo.
    const { sourceType, source } = existing.marketplaceSource ?? {};

    if (sourceType !== 'git' || !isSameRepo(source, REPO)) {
        const from = source ? `${sourceType ?? 'unknown'} source ${redact(source)}` : 'an unknown source';

        blocked(`marketplace ${MARKETPLACE} is registered from ${from}, not ${REPO}`);
    }

    const file = configFile(system),
        text = await system.readFile(file),
        ref = text === null ? undefined : marketplaceRef(text, MARKETPLACE);

    if (ref === CODEX_REF) {
        await mustRun(system, 'codex', ['plugin', 'marketplace', 'upgrade', MARKETPLACE, '--json']);

        return;
    }

    if (ref === undefined) {
        blocked(`marketplace ${MARKETPLACE} is registered outside ${file}, so its ref can't be checked; register it there and re-run`);
    }

    if (ref !== null) {
        blocked(`marketplace ${MARKETPLACE} tracks ${ref}, not ${CODEX_REF}; run \`codex plugin marketplace remove ${MARKETPLACE}\` and re-run`);
    }

    // Registered before the ref: it tracks main, whose every commit makes Codex ask to approve the hook again.
    await mustRun(system, 'codex', ['plugin', 'marketplace', 'remove', MARKETPLACE, '--json']);
    await addMarketplace(system);
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
            notes = SHADOW_IDS.filter((id) => isInstalled(plugins, id)).map((id) => `${id} duplicates it and will be removed`),
            config = await system.readFile(configFile(system));

        if (installed && config !== null && marketplaceRef(config, MARKETPLACE) === null) {
            notes.push(`marketplace ${MARKETPLACE} tracks main and will be re-added at ${CODEX_REF}; Codex then asks once to approve the hook`);
        }

        return installed ?
            { installed: true, detail: `${PLUGIN_ID} ${installed.version ?? ''}`.trim(), notes } :
            { installed: false, detail: 'not installed', notes };
    },

    install (system) {
        return guard(async () => {
            // Listed first: re-registering the marketplace uninstalls its plugins.
            const plugins = await listPlugins(system),
                wasInstalled = isInstalled(plugins, PLUGIN_ID);

            await refreshMarketplace(system);

            // `add` is idempotent and is also how Codex updates an installed plugin. It runs
            // before the duplicate is removed, so a failed add still leaves a working copy.
            await mustRun(system, 'codex', ['plugin', 'add', PLUGIN_ID, '--json']);
            await removeInstalled(system, plugins, SHADOW_IDS);

            return result('done', `${wasInstalled ? 'updated' : 'installed'} ${PLUGIN_ID}`, NEXT);
        });
    },

    remove (system) {
        return guard(async () => {
            const removed = await removeInstalled(system, await listPlugins(system), [PLUGIN_ID, ...SHADOW_IDS]);

            // status() sees only our ID, so the duplicate's removal is confirmed here.
            if (removed.length && !system.dryRun) {
                const after = await listPlugins(system),
                    left = removed.filter((id) => isInstalled(after, id));

                if (left.length) {
                    failed(`remove exited 0, but ${left.join(', ')} is still installed`);
                }
            }

            return removed.length ?
                result('done', `removed ${removed.join(', ')}`, NEXT) :
                result('skipped', 'not installed');
        });
    }
};
