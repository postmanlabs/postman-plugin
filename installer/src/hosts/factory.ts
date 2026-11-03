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

export function installedPlugins (droidPluginList: string): string[] {
    const bracketedScopes = droidPluginList.split(/\r?\n/)
        .map((line) => /^\s*(\S+@\S+)\s+\[(\w+)\]/.exec(line))
        .filter((match) => match !== null)
        .map(([, plugin, scope]) => `${plugin} [${scope}]`);

    return bracketedScopes.length ?
        bracketedScopes :
        rowsOfWrappedTable(droidPluginList).map((row) => `${row.PLUGIN} [${row.SOURCE}]`);
}

function hasInstalledPlugin (text: string): boolean {
    return installedPlugins(text).includes(`${PLUGIN_ID} [${SCOPE}]`);
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
