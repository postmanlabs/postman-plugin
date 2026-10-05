import { createHash } from 'node:crypto';
import path from 'node:path';
import { OPENCODE_MINIMUM, OPENCODE_SHIM, OPENCODE_SPEC, REPO, isSameRepo, redact } from '../source.js';
import type { System } from '../system.js';
import { parseJsonc, withoutArrayString } from './opencode-config.js';
import { assertCloneRemovable, blocked, failed, guard, mustRun, removeClone } from './shared.js';
import { type Host, result } from './types.js';

type Version = { major: number; text: string };
type Entry = { file: string; key: string; spec: string };

// OpenCode 1 lists its plugins under `plugin`, OpenCode 2 under `plugins`; either may sit in `.json` or `.jsonc`.
const KEYS = ['plugin', 'plugins'],
    CONFIG_FILES = ['opencode.json', 'opencode.jsonc'],
    NPM_NAME = '@postman/postman-plugin',
    NEXT = 'Restart OpenCode for the change to take effect.',
    // Installs a branch, tag or commit of this repo instead of its default branch, for testing a change before it merges.
    REF_VARIABLE = 'POSTMAN_PLUGIN_OPENCODE_REF',
    specToInstall = (system: System) => (system.env[REF_VARIABLE] ? `${OPENCODE_SPEC}#${system.env[REF_VARIABLE]}` : OPENCODE_SPEC),
    configDir = (system: System) => path.join(system.env.XDG_CONFIG_HOME || path.join(system.home, '.config'), 'opencode'),
    // `opencode plugin add` writes to OPENCODE_CONFIG_DIR instead when it is set.
    configDirs = (system: System) => [...new Set([system.env.OPENCODE_CONFIG_DIR, configDir(system)].filter((dir): dir is string => Boolean(dir)))],
    // OpenCode 2 keeps one cached copy of each git plugin here, named `git-<repo>-<first 12 hex of sha256(spec)>`.
    cachedCopy = (system: System, spec: string) => path.join(
        system.env.XDG_CACHE_HOME || path.join(system.home, '.cache'),
        'opencode',
        'npm',
        `git-${REPO.split('/')[1]}-${createHash('sha256').update(spec).digest('hex').slice(0, 12)}`
    ),
    // `plugin add` and `plugin remove` act on OPENCODE_CONFIG_DIR when it is set, wherever our entry was found.
    // Compared as paths, not strings: Windows spells the same directory with either slash, in any case.
    inConfigOf = (system: System, entry: Entry) => (system.env.OPENCODE_CONFIG_DIR && path.relative(system.env.OPENCODE_CONFIG_DIR, path.dirname(entry.file)) !== '' ?
        { env: { OPENCODE_CONFIG_DIR: path.dirname(entry.file) } } :
        undefined),
    // The older install: a clone of this repo next to a one-line loader file that imports it.
    cloneDir = (system: System) => path.join(configDir(system), 'postman-plugin'),
    shimFile = (system: System) => path.join(configDir(system), 'plugins', 'postman.ts'),
    shimTarget = (system: System) => path.join(cloneDir(system), 'opencode', 'src', 'index.ts');

/** This repo through `github:`, a git URL or npm, at any ref or version. */
function isOurSpec (spec: string): boolean {
    const bare = spec.split('#')[0];

    if (bare === NPM_NAME || bare.startsWith(`${NPM_NAME}@`)) {
        return true;
    }

    return bare.startsWith('github:') ? isSameRepo(bare.slice('github:'.length), REPO) : isSameRepo(bare.replace(/^git\+/, ''), REPO);
}

/** True when the dotted version `found` precedes `minimum`. */
function isBefore (found: number[], minimum: number[]): boolean {
    const differing = found.findIndex((part, at) => part !== minimum[at]);

    return differing !== -1 && found[differing] < minimum[differing];
}

/** The release `opencode` is, refusing one older than the first of its major that installs Postman with `opencode plugin`. */
async function installableVersion (system: System): Promise<Version> {
    const probe = await system.probe('opencode', ['--version']),
        match = probe.stdout.match(/(\d+)\.(\d+)\.(\d+)/);

    if (probe.code !== 0 || !match) {
        return failed('could not read the version `opencode --version` prints');
    }

    const found = match.slice(1).map(Number),
        major = found[0],
        minimum = OPENCODE_MINIMUM[major],
        older = minimum !== undefined && isBefore(found, minimum);

    if (major < 1 || older) {
        return blocked(`OpenCode ${match[0]} is older than ${(minimum ?? OPENCODE_MINIMUM[1]).join('.')}, the first ${major}.x release that installs Postman with \`opencode plugin\`; update OpenCode and re-run`);
    }

    return { major, text: match[0] };
}

const addArgs = (version: Version, spec: string) => (version.major >= 2 ? ['plugin', 'add', spec] : ['plugin', '--global', spec]);

/** Our entries in OpenCode's global config, and the config files that could not be read. */
async function configured (system: System): Promise<{ entries: Entry[]; unreadable: string[] }> {
    const entries: Entry[] = [],
        unreadable: string[] = [];

    for (const file of configDirs(system).flatMap((dir) => CONFIG_FILES.map((name) => path.join(dir, name)))) {
        const text = await system.readFile(file);

        if (text === null) {
            continue;
        }

        const config = parseJsonc<Record<string, unknown>>(text);

        if (!config || typeof config !== 'object') {
            unreadable.push(file);
            continue;
        }

        for (const key of KEYS) {
            const list = config[key];

            for (const item of Array.isArray(list) ? list : []) {
                const spec = typeof item === 'string' ? item : (item as { package?: unknown } | null)?.package;

                if (typeof spec === 'string' && isOurSpec(spec)) {
                    entries.push({ file, key, spec });
                }
            }
        }
    }

    return { entries, unreadable };
}

async function readableEntries (system: System): Promise<Entry[]> {
    const { entries, unreadable } = await configured(system);

    return unreadable.length ? failed(`${unreadable[0]} is not valid JSON; fix it and re-run`) : entries;
}

async function legacyState (system: System) {
    const cloned = await system.exists(cloneDir(system)),
        shim = await system.readFile(shimFile(system));

    return { cloned, shim, loadable: cloned && await system.exists(shimTarget(system)) };
}

/** Throws `blocked` when the older install cannot be deleted whole, changing nothing. */
async function preflightLegacy (system: System): Promise<void> {
    const { cloned, shim } = await legacyState(system);

    // A loader we didn't write may still import the clone; deleting it would break that file.
    if (cloned && shim !== null && shim !== OPENCODE_SHIM) {
        blocked(`${shimFile(system)} has other contents and may load ${cloneDir(system)}; move it aside and re-run`);
    }

    await assertCloneRemovable(system, cloneDir(system));
}

/** Deletes the clone and loader of the older install, refusing anything that is not ours. */
async function removeLegacy (system: System): Promise<string[]> {
    const { cloned, shim } = await legacyState(system);

    if (!cloned && shim !== OPENCODE_SHIM) {
        return [];
    }

    // A loader we didn't write may still import the clone; deleting it would break that file.
    if (shim !== null && shim !== OPENCODE_SHIM) {
        blocked(`${shimFile(system)} has other contents and may load ${cloneDir(system)}; move it aside and re-run`);
    }

    const removed = cloned ? [cloneDir(system)] : [];

    // The clone is checked before anything is deleted, so a refusal leaves both in place.
    await removeClone(system, cloneDir(system));

    if (shim === OPENCODE_SHIM) {
        await system.remove(shimFile(system));
        removed.push(shimFile(system));
    }

    return removed;
}

/** Takes an entry out of OpenCode 1's config, which has no command for it. */
async function removeFromConfig (system: System, entry: Entry): Promise<void> {
    const text = await system.readFile(entry.file),
        edited = text === null ? null : withoutArrayString(text, entry.key, entry.spec);

    if (edited === null) {
        blocked(`could not remove ${entry.spec} from ${entry.file} without rewriting it; delete that entry yourself and re-run`);
    }

    await system.writeFile(entry.file, edited);
}

/**
 * OpenCode 2 caches a git plugin by its spec and `plugin add` reuses the cache, so a moved branch only
 * arrives when the cached copy is gone; `plugin update` would do it but needs OpenCode's background
 * service, which a second instance or a cold start answers wrongly. The copy is moved aside, not deleted,
 * so a failed fetch leaves the plugin as it was. OpenCode 1 re-resolves on a forced re-run.
 */
async function refreshEntry (system: System, version: Version, entry: Entry): Promise<void> {
    if (version.major < 2) {
        await mustRun(system, 'opencode', ['plugin', '--global', '--force', entry.spec], inConfigOf(system, entry));

        return;
    }

    const copy = cachedCopy(system, entry.spec),
        previous = `${copy}.previous`,
        cached = await system.exists(copy);

    if (cached) {
        await system.remove(previous);
        await system.rename(copy, previous);
    }

    try {
        await mustRun(system, 'opencode', ['plugin', 'add', entry.spec], inConfigOf(system, entry));
    }
    catch (error) {
        if (cached) {
            await system.remove(copy);
            await system.rename(previous, copy);
        }

        throw error;
    }

    if (cached) {
        await system.remove(previous);
    }
}

function summary (action: string, spec: string, removed: string[]): string {
    return `${action} ${spec}${removed.length ? `; removed the older install at ${removed.join(' and ')}` : ''}`;
}

export const opencode: Host = {
    id: 'opencode',
    name: 'OpenCode',
    route: 'opencode/package.json',

    async detect (system) {
        return (await system.which('opencode')) !== null;
    },

    async status (system) {
        const { entries, unreadable } = await configured(system),
            { cloned, shim, loadable } = await legacyState(system),
            legacy = loadable && shim === OPENCODE_SHIM,
            notes = [
                ...(legacy ? [`${cloneDir(system)} loads the same skills and will be removed`] : []),
                ...(shim !== null && shim !== OPENCODE_SHIM ? [`${shimFile(system)} has other contents; install will refuse to remove it`] : []),
                ...(cloned && !loadable ? [`${cloneDir(system)} exists but has no opencode/src/index.ts for a loader to import`] : [])
            ];

        if (entries.length) {
            return { installed: true, detail: `${redact(entries[0].spec)} in ${entries[0].file}`, notes };
        }

        if (unreadable.length) {
            return { installed: null, detail: `could not read ${unreadable[0]}`, notes };
        }

        return legacy ?
            { installed: true, detail: `clone at ${cloneDir(system)}`, notes } :
            { installed: false, detail: 'not installed', notes };
    },

    install (system) {
        return guard(async () => {
            const version = await installableVersion(system),
                entries = await readableEntries(system),
                refresh = entries.length > 0;

            // npm keeps its own record of what it installed, which this installer does not know how to refresh.
            if (refresh && entries[0].spec.split('#')[0].startsWith(NPM_NAME)) {
                return result('manual', `${entries[0].spec} was installed from npm`, `Run \`opencode plugin update\`, or on OpenCode 1 \`opencode plugin --global --force ${entries[0].spec}\`.`);
            }

            // Both copies would load the same skills, so an older install that cannot be deleted whole stops us before the new one goes in.
            await preflightLegacy(system);

            // Replacement first: if it fails, the older install is still a working one.
            if (refresh) {
                await refreshEntry(system, version, entries[0]);
            }
            else {
                await mustRun(system, 'opencode', addArgs(version, specToInstall(system)));
            }

            const removed = await removeLegacy(system);

            return result('done', summary(refresh ? 'updated' : 'installed', refresh ? redact(entries[0].spec) : specToInstall(system), removed), NEXT);
        });
    },

    remove (system) {
        return guard(async () => {
            const entries = await readableEntries(system),
                { cloned, shim } = await legacyState(system);

            if (!entries.length && !cloned && shim !== OPENCODE_SHIM) {
                return result('skipped', 'not installed');
            }

            // Everything that can refuse is checked before anything is removed, so a refusal leaves no half-removed state.
            await preflightLegacy(system);

            const removed: string[] = [];

            for (const entry of entries) {
                // OpenCode 2 lists plugins under `plugins` and removes them itself; OpenCode 1 has no command for it.
                if (entry.key === 'plugins') {
                    await mustRun(system, 'opencode', ['plugin', 'remove', entry.spec], inConfigOf(system, entry));
                }
                else {
                    await removeFromConfig(system, entry);
                }

                removed.push(redact(entry.spec));
            }

            removed.push(...await removeLegacy(system));

            return result('done', `removed ${removed.join(' and ')}`, NEXT);
        });
    }
};
