import { GIT_URL, REPO, isSameRepo, redact } from '../source.js';
import type { System } from '../system.js';
import { blocked, guard, mustProbeText, mustRun } from './shared.js';
import { type Host, result } from './types.js';

const MARKETPLACE = 'postman-plugin',
    PLUGIN_ID = `postman@${MARKETPLACE}`,
    SCOPE = 'user',
    NEXT = 'Restart Droid for the change to take effect.';

type Row = Record<string, string>;

function rowsOfWrappedTable (text: string): Row[] {
    const lines = text.split(/\r?\n/),
        headerAt = lines.findIndex((line) => /^[A-Z]+(?: [A-Z]+)*(?: {2,}[A-Z]+(?: [A-Z]+)*)+\s*$/.test(line));

    if (headerAt === -1) {
        return [];
    }

    const columns = [...lines[headerAt].matchAll(/[A-Z]+(?: [A-Z]+)*/g)].map((match) => ({ name: match[0], start: match.index })),
        rows: Row[] = [];

    for (const line of lines.slice(headerAt + 1)) {
        const cells = columns.map(({ start }, i) => line.slice(start, columns[i + 1]?.start).trim()),
            previous = rows.at(-1),
            continuesPrevious = !cells[0];

        if (!continuesPrevious) {
            rows.push(Object.fromEntries(columns.map(({ name }, i) => [name, cells[i]])));
        }
        else if (previous) {
            columns.forEach(({ name }, i) => { previous[name] += cells[i]; });
        }
    }

    return rows;
}

type InstalledPlugin = { id: string; scope: string };

function parseInstalledPlugins (droidPluginList: string): InstalledPlugin[] {
    const bracketedScopes = droidPluginList.split(/\r?\n/)
        .map((line) => /^\s*(\S+@\S+)\s+\[(\w+)\]/.exec(line))
        .filter((match) => match !== null)
        .map(([, id, scope]) => ({ id, scope }));

    return bracketedScopes.length ?
        bracketedScopes :
        rowsOfWrappedTable(droidPluginList).map((row) => ({ id: row.PLUGIN, scope: row.SOURCE }));
}

const label = ({ id, scope }: InstalledPlugin) => `${id} [${scope}]`,
    isOurs = (plugin: InstalledPlugin) => plugin.id === PLUGIN_ID && plugin.scope === SCOPE;

export function installedPlugins (droidPluginList: string): string[] {
    return parseInstalledPlugins(droidPluginList).map(label);
}

function hasInstalledPlugin (text: string): boolean {
    return parseInstalledPlugins(text).some(isOurs);
}

function marketplaceSource (text: string): string | null {
    for (const line of text.split(/\r?\n/)) {
        const match = /^\s*(\S+)\s+\(\d+ plugins?\)\s+(.+?)(?:\s+"[^"]*")?\s*$/.exec(line);

        if (match && match[1] === MARKETPLACE) {
            return match[2];
        }
    }

    return rowsOfWrappedTable(text).find((row) => row.MARKETPLACE === MARKETPLACE)?.SOURCE ?? null;
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

/**
 * Removes this repo's marketplace once no plugin Droid can see comes from it. Droid removes a marketplace even
 * while its plugins are installed, leaving them with nothing to update from, so this checks first.
 */
async function removeMarketplace (system: System, wasInstalled: boolean): Promise<boolean> {
    const source = marketplaceSource(await mustProbeText(system, 'droid', ['plugin', 'marketplace', 'list']));

    if (!source) {
        return false;
    }

    if (!isSameRepo(sourceWithoutFactoryPrefix(source), REPO)) {
        system.log(`  note: marketplace ${MARKETPLACE} is registered from ${redact(source)}, not ${REPO}; left alone`);

        return false;
    }

    // Droid lists project scope only for the directory it runs in.
    const listings = await Promise.all(['user', 'project'].map((scope) => mustProbeText(system, 'droid', ['plugin', 'list', '--scope', scope]))),
        serving = listings.flatMap(parseInstalledPlugins)
            .filter((plugin) => plugin.id.endsWith(`@${MARKETPLACE}`))
            .filter((plugin) => !(system.dryRun && wasInstalled && isOurs(plugin)));

    if (serving.length) {
        system.log(`  note: marketplace ${MARKETPLACE} still serves ${serving.map(label).join(', ')}; left alone`);

        return false;
    }

    await mustRun(system, 'droid', ['plugin', 'marketplace', 'remove', MARKETPLACE]);
    system.log(`  note: Droid lists project installs only for this directory; one elsewhere from marketplace ${MARKETPLACE} keeps its copy, without updates`);

    return true;
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
            const wasInstalled = hasInstalledPlugin(await listPlugins(system));

            if (wasInstalled) {
                await mustRun(system, 'droid', ['plugin', 'uninstall', PLUGIN_ID, '--scope', SCOPE]);
            }

            const removals = [
                ...(wasInstalled ? [`uninstalled ${PLUGIN_ID}`] : []),
                ...(await removeMarketplace(system, wasInstalled) ? [`removed marketplace ${MARKETPLACE}`] : [])
            ];

            return removals.length ? result('done', removals.join(' and '), NEXT) : result('skipped', 'not installed');
        });
    }
};
