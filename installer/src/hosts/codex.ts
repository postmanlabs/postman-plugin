import { BRANCH, GIT_URL, REPO, isSameRepo, redact } from '../source.js';
import type { System } from '../system.js';
import { StepFailed, blocked, failed, guard, mustProbeJson, mustRun, parseJson } from './shared.js';
import { type Host, result } from './types.js';
import { approvePostmanHook } from './codex-hooks.js';

// Codex names the marketplace after `.claude-plugin/marketplace.json`'s `name`.
// `npx plugins add` installs a second copy under its own `plugins-cli` marketplace.
const MARKETPLACE = 'postman',
    PLUGIN_ID = `postman@${MARKETPLACE}`,
    LEGACY_REF = 'codex-release',
    SHADOW_IDS = ['postman@plugins-cli'],
    NEXT = 'Restart Codex for the change to take effect.';

type Marketplace = { name: string; marketplaceSource?: { sourceType?: string; source?: string } };
/** A marketplace's ref: `null` when it has none, `undefined` when Codex can't report it. */
type Ref = string | null | undefined;
type InstalledPlugin = { pluginId: string; installed?: boolean; version?: string };

function isInstalled (plugins: InstalledPlugin[], id: string): boolean {
    return plugins.some((plugin) => plugin.pluginId === id && plugin.installed !== false);
}

async function listPlugins (system: System): Promise<InstalledPlugin[]> {
    return (await mustProbeJson<{ installed?: InstalledPlugin[] }>(system, 'codex', ['plugin', 'list', '--json'])).installed ?? [];
}

/** The marketplace's ref as Codex's own config reader reports it; `marketplace list --json` doesn't. */
export async function registeredRef (system: System): Promise<Ref> {
    const replies = await system.rpc('codex', ['app-server'], [
            { method: 'initialize', params: { clientInfo: { name: 'postman-plugin', version: '0' } } },
            { method: 'initialized', notify: true },
            { method: 'config/read', params: {} }
        ]),
        read = replies?.[1]?.result as { config?: { marketplaces?: Record<string, { ref?: unknown } | undefined> } } | undefined,
        entry = read?.config?.marketplaces?.[MARKETPLACE];

    if (!entry || typeof entry !== 'object') {
        return undefined;
    }

    return typeof entry.ref === 'string' ? entry.ref : entry.ref === null || entry.ref === undefined ? null : undefined;
}

async function addMarketplace (system: System): Promise<void> {
    await mustRun(system, 'codex', ['plugin', 'marketplace', 'add', REPO, '--ref', BRANCH, '--json']);
    // `add` records no revision, so without this Codex's next startup refetches the plugin and asks for approval again.
    await mustRun(system, 'codex', ['plugin', 'marketplace', 'upgrade', MARKETPLACE, '--json']);
}

/** Adds or upgrades the marketplace, leaving the old release branch for `migrate`. */
async function refreshMarketplace (system: System): Promise<'ready' | 'legacy' | 'deferred'> {
    const listing = await mustProbeJson<{ marketplaces?: Marketplace[] }>(system, 'codex', ['plugin', 'marketplace', 'list', '--json']),
        existing = listing.marketplaces?.find((marketplace) => marketplace.name === MARKETPLACE);

    if (!existing) {
        await addMarketplace(system);

        return 'ready';
    }

    // A local marketplace can carry any path text, so only a git source counts as this repo.
    const { sourceType, source } = existing.marketplaceSource ?? {};

    if (sourceType !== 'git' || !isSameRepo(source, REPO)) {
        const from = source ? `${sourceType ?? 'unknown'} source ${redact(source)}` : 'an unknown source';

        blocked(`marketplace ${MARKETPLACE} is registered from ${from}, not ${REPO}`);
    }

    if (system.dryRun) {
        system.log(`  note: Would ask Codex for marketplace ${MARKETPLACE}'s ref: upgrade it on ${BRANCH}, migrate ${LEGACY_REF} to ${BRANCH}, preserve an unreadable ref, or stop for a custom ref. App-server is deferred because its startup can refresh plugins.`);

        return 'deferred';
    }

    const ref = await registeredRef(system);

    if (ref === undefined) {
        system.log(`  note: Could not read marketplace ${MARKETPLACE}'s ref through codex app-server; keeping its registration and skipping ref migration.`);
    }

    if (ref === BRANCH || ref === null || ref === undefined) {
        await mustRun(system, 'codex', ['plugin', 'marketplace', 'upgrade', MARKETPLACE, '--json']);

        return 'ready';
    }

    if (ref !== LEGACY_REF) {
        blocked(`marketplace ${MARKETPLACE} tracks ${ref}, not ${BRANCH}; run \`codex plugin marketplace remove ${MARKETPLACE}\` and re-run`);
    }

    return 'legacy';
}

/** Re-registers the previous marketplace and its plugin; true when every step exits 0. */
async function restoreLegacy (system: System, wasInstalled: boolean): Promise<boolean> {
    // Exits non-zero when the failed step left nothing registered, which is the state wanted here.
    await system.run('codex', ['plugin', 'marketplace', 'remove', MARKETPLACE, '--json']);

    const steps = [['plugin', 'marketplace', 'add', REPO, '--ref', LEGACY_REF, '--json'], ...(wasInstalled ? [['plugin', 'add', PLUGIN_ID, '--json']] : [])];

    for (const args of steps) {
        if ((await system.run('codex', args)).code !== 0) {
            return false;
        }
    }

    return true;
}

/**
 * Moves a marketplace registered at the old release branch to main, then adds the plugin. `remove`
 * uninstalls Postman too, so a failure after it puts the previous registration back.
 */
async function migrate (system: System, wasInstalled: boolean): Promise<void> {
    const reach = await system.probe('git', ['ls-remote', '--exit-code', GIT_URL, `refs/heads/${BRANCH}`]);

    if (reach.code !== 0) {
        failed(`can't reach ${BRANCH} in ${REPO}, so marketplace ${MARKETPLACE} was left tracking ${LEGACY_REF}`);
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

        const restored = await restoreLegacy(system, wasInstalled);

        failed(`${error.outcome.message}\n${restored ?
            `restored marketplace ${MARKETPLACE} tracking ${LEGACY_REF}${wasInstalled ? ` and ${PLUGIN_ID}` : ''}` :
            `could not restore it either; run \`codex plugin marketplace remove ${MARKETPLACE}\`, \`codex plugin marketplace add ${REPO} --ref ${BRANCH}\`, \`codex plugin marketplace upgrade ${MARKETPLACE}\` and \`codex plugin add ${PLUGIN_ID}\``}`);
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
            notes = SHADOW_IDS.filter((id) => isInstalled(plugins, id)).map((id) => `${id} duplicates it and will be removed`);

        if (installed && await registeredRef(system) === LEGACY_REF) {
            notes.push(`marketplace ${MARKETPLACE} tracks ${LEGACY_REF} and will be re-added at ${BRANCH}; the installer then approves its session-start hook`);
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
            if (await refreshMarketplace(system) === 'legacy') {
                await migrate(system, wasInstalled);
            }
            else {
                await mustRun(system, 'codex', ['plugin', 'add', PLUGIN_ID, '--json']);
            }
            await removeInstalled(system, plugins, SHADOW_IDS);
            await approvePostmanHook(system);

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
