import path from 'node:path';
import { CODEX_REF, GIT_URL, REPO, isSameRepo, redact } from '../source.js';
import type { System } from '../system.js';
import { StepFailed, blocked, failed, guard, mustProbeJson, mustRun, parseJson } from './shared.js';
import { type Host, result } from './types.js';

// Codex names the marketplace after `.claude-plugin/marketplace.json`'s `name`.
// `npx plugins add` installs a second copy under its own `plugins-cli` marketplace.
const MARKETPLACE = 'postman',
    PLUGIN_ID = `postman@${MARKETPLACE}`,
    SHADOW_IDS = ['postman@plugins-cli'],
    NEXT = 'Restart Codex for the change to take effect.';

type Marketplace = { name: string; marketplaceSource?: { sourceType?: string; source?: string } };
/** A marketplace's ref in Codex's user config: `null` when it has none, `undefined` when it has no table there or its ref can't be read. */
type Ref = string | null | undefined;
type InstalledPlugin = { pluginId: string; installed?: boolean; version?: string };

function isInstalled (plugins: InstalledPlugin[], id: string): boolean {
    return plugins.some((plugin) => plugin.pluginId === id && plugin.installed !== false);
}

async function listPlugins (system: System): Promise<InstalledPlugin[]> {
    return (await mustProbeJson<{ installed?: InstalledPlugin[] }>(system, 'codex', ['plugin', 'list', '--json'])).installed ?? [];
}

const configFile = (system: System) => path.join(system.env.CODEX_HOME || path.join(system.home, '.codex'), 'config.toml');

/** Indexes of the lines matching `header`, skipping lines inside a `"""` or `'''` multi-line string. */
function headerLines (lines: string[], header: RegExp): number[] {
    const found: number[] = [];
    let open: string | null = null;

    lines.forEach((line, index) => {
        if (open === null && header.test(line)) {
            found.push(index);
        }

        for (const delimiter of ['"""', "'''"]) {
            if ((open === null || open === delimiter) && line.split(delimiter).length % 2 === 0) {
                open = open === null ? delimiter : null;
            }
        }
    });

    return found;
}

/** Reads `ref` from the `[marketplaces.<name>]` table Codex writes; `marketplace list --json` doesn't report it. Fails closed on any other TOML form. */
export function marketplaceRef (toml: string, name: string): Ref {
    const header = new RegExp(`^\\s*\\[\\s*marketplaces\\s*\\.\\s*(["']?)${name}\\1\\s*\\]\\s*(#.*)?$`),
        lines = toml.split(/\r?\n/),
        headers = headerLines(lines, header),
        [start] = headers;

    // A second match means one sits in text this line reader can't tell from a table.
    if (headers.length !== 1) {
        return undefined;
    }

    for (const line of lines.slice(start + 1)) {
        if (/^\s*\[/.test(line)) {
            break;
        }

        const ref = line.match(/^\s*ref\s*=\s*(?:"([^"\\]*)"|'([^']*)')\s*(#.*)?$/);

        if (ref) {
            return ref[1] ?? ref[2];
        }

        // A quoted key, a multi-line string or an escape: some ref is set, so `null` would replace it.
        if (/^\s*(?:ref|"ref"|'ref')\s*[=.]/.test(line)) {
            return undefined;
        }
    }

    return null;
}

async function addMarketplace (system: System): Promise<void> {
    await mustRun(system, 'codex', ['plugin', 'marketplace', 'add', REPO, '--ref', CODEX_REF, '--json']);
    // `add` records no revision, so without this Codex's next startup refetches the plugin and asks for approval again.
    await mustRun(system, 'codex', ['plugin', 'marketplace', 'upgrade', MARKETPLACE, '--json']);
}

/** Adds or upgrades the marketplace, except one registered with no ref, which it leaves for `migrate`. */
async function refreshMarketplace (system: System): Promise<'pinned' | 'unpinned'> {
    const listing = await mustProbeJson<{ marketplaces?: Marketplace[] }>(system, 'codex', ['plugin', 'marketplace', 'list', '--json']),
        existing = listing.marketplaces?.find((marketplace) => marketplace.name === MARKETPLACE);

    if (!existing) {
        await addMarketplace(system);

        return 'pinned';
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

        return 'pinned';
    }

    if (ref === undefined) {
        blocked(`can't read which ref marketplace ${MARKETPLACE} tracks from ${file}; to move it to ${CODEX_REF}, run \`codex plugin marketplace remove ${MARKETPLACE}\` and re-run`);
    }

    if (ref !== null) {
        blocked(`marketplace ${MARKETPLACE} tracks ${ref}, not ${CODEX_REF}; run \`codex plugin marketplace remove ${MARKETPLACE}\` and re-run`);
    }

    return 'unpinned';
}

/** Re-registers the previous, unpinned marketplace and its plugin; true when every step exits 0. */
async function restoreUnpinned (system: System, wasInstalled: boolean): Promise<boolean> {
    // Exits non-zero when the failed step left nothing registered, which is the state wanted here.
    await system.run('codex', ['plugin', 'marketplace', 'remove', MARKETPLACE, '--json']);

    const steps = [['plugin', 'marketplace', 'add', REPO, '--json'], ...(wasInstalled ? [['plugin', 'add', PLUGIN_ID, '--json']] : [])];

    for (const args of steps) {
        if ((await system.run('codex', args)).code !== 0) {
            return false;
        }
    }

    return true;
}

/**
 * Moves a marketplace registered with no ref, which tracks main, to CODEX_REF, then adds the plugin. `remove`
 * uninstalls Postman too, so a failure after it puts the previous registration back.
 */
async function migrate (system: System, wasInstalled: boolean): Promise<void> {
    const reach = await system.probe('git', ['ls-remote', '--exit-code', GIT_URL, `refs/heads/${CODEX_REF}`]);

    if (reach.code !== 0) {
        failed(`can't reach ${CODEX_REF} in ${REPO}, so marketplace ${MARKETPLACE} was left tracking main`);
    }

    await mustRun(system, 'codex', ['plugin', 'marketplace', 'remove', MARKETPLACE, '--json']);

    try {
        await addMarketplace(system);
        await mustRun(system, 'codex', ['plugin', 'add', PLUGIN_ID, '--json']);
    }
    catch (error) {
        if (!(error instanceof StepFailed)) {
            throw error;
        }

        const restored = await restoreUnpinned(system, wasInstalled);

        failed(`${error.outcome.message}\n${restored ?
            `restored marketplace ${MARKETPLACE} tracking main${wasInstalled ? ` and ${PLUGIN_ID}` : ''}` :
            `could not restore it either; run \`codex plugin marketplace add ${REPO} --ref ${CODEX_REF}\` and \`codex plugin add ${PLUGIN_ID}\``}`);
    }
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

            // `add` is idempotent and is also how Codex updates an installed plugin. It runs
            // before the duplicate is removed, so a failed add still leaves a working copy.
            if (await refreshMarketplace(system) === 'unpinned') {
                await migrate(system, wasInstalled);
            }
            else {
                await mustRun(system, 'codex', ['plugin', 'add', PLUGIN_ID, '--json']);
            }
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
