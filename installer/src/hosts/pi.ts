import path from 'node:path';
import { PI_SOURCE, REPO, isSameRepo, redact } from '../source.js';
import type { System } from '../system.js';
import { failed, guard, mustRun, parseJson } from './shared.js';
import { type Host, result } from './types.js';

const NEXT = 'Restart Pi, or run `/reload` in an open session, for the change to take effect.',
    GIT_PREFIX = /^git:/,
    GIT_REF = /@[^@/:]+$/;

type PackageEntry = string | { source?: string };

function agentDir (system: System): string {
    const dir = system.env.PI_CODING_AGENT_DIR;

    if (!dir) {
        return path.join(system.home, '.pi', 'agent');
    }

    return dir === '~' || dir.startsWith('~/') ? path.join(system.home, dir.slice(1)) : dir;
}

// Pi keys an npm package by its name, so a pinned `npm:@postman/postman-plugin@x` is this
// package too. A git install of this repo is another package loading the same skills.
const settingsFile = (system: System) => path.join(agentDir(system), 'settings.json'),
    isOurPackage = (source: string) => source === PI_SOURCE || source.startsWith(`${PI_SOURCE}@`),
    isRepoClone = (source: string) => !source.startsWith('npm:') && isSameRepo(source.replace(GIT_PREFIX, '').replace(GIT_REF, ''), REPO);

/** Every package source in Pi's user settings, or `null` when the file can't be parsed. */
async function packageSources (system: System): Promise<string[] | null> {
    const text = await system.readFile(settingsFile(system));

    if (text === null) {
        return [];
    }

    // Pi parses the file the same way, so a file that fails here fails in `pi` too.
    const settings = parseJson<{ packages?: PackageEntry[] }>(text.replace(/^\uFEFF/, ''));

    if (!settings || (settings.packages !== undefined && !Array.isArray(settings.packages))) {
        return null;
    }

    return (settings.packages ?? [])
        .map((entry) => (typeof entry === 'string' ? entry : entry?.source))
        .filter((source): source is string => typeof source === 'string');
}

async function readableSources (system: System): Promise<string[]> {
    return (await packageSources(system)) ?? failed(`${settingsFile(system)} is not valid JSON; fix it and re-run`);
}

export const pi: Host = {
    id: 'pi',
    name: 'Pi',
    route: 'installer/package.json',

    async detect (system) {
        return (await system.which('pi')) !== null;
    },

    async status (system) {
        const sources = await packageSources(system);

        if (sources === null) {
            return { installed: null, detail: `could not read ${settingsFile(system)}`, notes: [] };
        }

        const ours = sources.find(isOurPackage),
            notes = [
                ...(ours && ours !== PI_SOURCE ? [`${ours} is pinned, so an update leaves it at that version`] : []),
                ...sources.filter(isRepoClone).map((source) => `${redact(source)} loads the same skills and will be removed`)
            ];

        return ours ?
            { installed: true, detail: `${ours} in ${settingsFile(system)}`, notes } :
            { installed: false, detail: 'not installed', notes };
    },

    install (system) {
        return guard(async () => {
            const sources = await readableSources(system),
                installed = sources.some(isOurPackage);

            // Replacement first: if it fails, a git copy of this repo is still a working one.
            await mustRun(system, 'pi', [installed ? 'update' : 'install', PI_SOURCE]);

            for (const source of sources.filter(isRepoClone)) {
                await mustRun(system, 'pi', ['remove', source]);
            }

            return result('done', `${installed ? 'updated' : 'installed'} ${PI_SOURCE} in ${settingsFile(system)}`, NEXT);
        });
    },

    remove (system) {
        return guard(async () => {
            const sources = await readableSources(system),
                targets = [...(sources.some(isOurPackage) ? [PI_SOURCE] : []), ...sources.filter(isRepoClone)];

            if (!targets.length) {
                return result('skipped', 'not installed');
            }

            for (const source of targets) {
                await mustRun(system, 'pi', ['remove', source]);
            }

            return result('done', `removed ${targets.map(redact).join(', ')}`, NEXT);
        });
    }
};
