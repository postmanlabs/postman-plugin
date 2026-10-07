import { createHash } from 'node:crypto';
import path from 'node:path';
import { OPENCODE_MINIMUM, OPENCODE_REPO, OPENCODE_SHIM, OPENCODE_SPEC, isSameRepo, redact } from '../source.js';
import type { System } from '../system.js';
import { parseJsonc, withoutArrayString } from './opencode-config.js';
import { assertCloneRemovable, blocked, failed, guard, mustRun, removeClone } from './shared.js';
import { type Host, result } from './types.js';

type Version = { major: number; text: string };
// `form` is how the list holds it: a bare string, OpenCode 1's `[spec, options]` tuple or OpenCode 2's `{ package }`.
type Entry = { file: string; key: string; spec: string; form: 'string' | 'tuple' | 'object' };

// OpenCode 1 lists its plugins under `plugin`, OpenCode 2 under `plugins`; either may sit in `.json` or `.jsonc`.
const KEYS = ['plugin', 'plugins'],
    CONFIG_FILES = ['opencode.json', 'opencode.jsonc'],
    NPM_NAME = '@postman/opencode-plugin',
    NEXT = 'Restart OpenCode for the change to take effect.',
    // Installs another spec instead of the mirror's default branch, such as a mirror built from a change before it merges.
    SPEC_VARIABLE = 'POSTMAN_PLUGIN_OPENCODE_SPEC',
    specToInstall = (system: System) => system.env[SPEC_VARIABLE] || OPENCODE_SPEC,
    configDir = (system: System) => path.join(system.env.XDG_CONFIG_HOME || path.join(system.home, '.config'), 'opencode'),
    // `opencode plugin add` writes to OPENCODE_CONFIG_DIR instead when it is set.
    configDirs = (system: System) => [...new Set([system.env.OPENCODE_CONFIG_DIR, configDir(system)].filter((dir): dir is string => Boolean(dir)))],
    // OpenCode 2 keeps one cached copy of each git plugin here, named `git-<slug>-<first 12 hex of sha256(spec)>`.
    cachedCopy = (system: System, spec: string) => path.join(
        system.env.XDG_CACHE_HOME || path.join(system.home, '.cache'),
        'opencode',
        'npm',
        `git-${gitSlug(spec)}-${createHash('sha256').update(spec).digest('hex').slice(0, 12)}`
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

/** OpenCode 2's name for a git spec's cache: its last path segment, as `gitSlug` in packages/util/src/npm.ts derives it. */
function gitSlug (spec: string): string {
    let target = spec.split('#')[0];

    try {
        target = decodeURIComponent(target);
    }
    catch {
        // OpenCode falls back to the undecoded spec too.
    }

    return target.replace(/\.git$/i, '').split(/[/:\\]/).at(-1)?.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'repository';
}

/** The mirror through `github:`, a git URL or npm, at any ref or version, or the spec POSTMAN_PLUGIN_OPENCODE_SPEC installs. */
function isOurSpec (system: System, spec: string): boolean {
    const bare = spec.split('#')[0];

    if (spec === system.env[SPEC_VARIABLE] || bare === NPM_NAME || bare.startsWith(`${NPM_NAME}@`)) {
        return true;
    }

    return bare.startsWith('github:') ? isSameRepo(bare.slice('github:'.length), OPENCODE_REPO) : isSameRepo(bare.replace(/^git\+/, ''), OPENCODE_REPO);
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
                const form = typeof item === 'string' ? 'string' : Array.isArray(item) ? 'tuple' : 'object',
                    spec = form === 'string' ? item : form === 'tuple' ? item[0] : (item as { package?: unknown } | null)?.package;

                if (typeof spec === 'string' && isOurSpec(system, spec)) {
                    entries.push({ file, key, spec, form });
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

/**
 * OpenCode 2's `plugin add` and `plugin remove` edit the first of `opencode.json` and `opencode.jsonc` that exists
 * (`resolveConfigPath` in its packages/cli); `remove` exits 0 when the entry is in the other one.
 */
async function editedByOpenCode (system: System, file: string): Promise<boolean> {
    return path.basename(file) === CONFIG_FILES[0] || !(await system.exists(path.join(path.dirname(file), CONFIG_FILES[0])));
}

async function removedByOpenCode (system: System, entry: Entry): Promise<boolean> {
    return entry.key === 'plugins' && entry.form !== 'tuple' && editedByOpenCode(system, entry.file);
}

/** The config without the entry, for an entry OpenCode has no command to remove; refuses one it can't take out cleanly. */
async function withoutEntry (system: System, entry: Entry): Promise<string> {
    const text = await system.readFile(entry.file),
        edited = text === null || entry.form !== 'string' ? null : withoutArrayString(text, entry.key, entry.spec);

    return edited ?? blocked(`could not remove ${entry.spec} from ${entry.file} without rewriting it; delete that entry yourself and re-run`);
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

            // Both copies would load the same skills, so an older install that cannot be deleted whole stops us before the new one goes in.
            await preflightLegacy(system);

            // npm keeps its own record of what it installed, which this installer does not know how to refresh.
            if (refresh && entries[0].spec.split('#')[0].startsWith(NPM_NAME)) {
                const removed = await removeLegacy(system);

                // OpenCode 1 reuses its cached `<name>@latest`, so only a new version string fetches anything.
                return result('manual', summary('found', `${entries[0].spec}, installed from npm`, removed), version.major >= 2 ?
                    'Run `opencode plugin update`.' :
                    `Run \`opencode plugin --global --force ${NPM_NAME}@<version>\` with the version \`npm view ${NPM_NAME} version\` prints.`);
            }

            // `plugin add` would register a second copy in opencode.json rather than refresh this one.
            if (refresh && version.major >= 2 && !(await editedByOpenCode(system, entries[0].file))) {
                blocked(`${entries[0].file} registers ${redact(entries[0].spec)}, but \`opencode plugin add\` writes to the ${CONFIG_FILES[0]} beside it; move the entry, with any options, into ${CONFIG_FILES[0]} and re-run`);
            }

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

            const byOpenCode = await Promise.all(entries.map((entry) => removedByOpenCode(system, entry)));

            for (const [at, entry] of entries.entries()) {
                if (!byOpenCode[at]) {
                    await withoutEntry(system, entry);
                }
            }

            const removed: string[] = [];

            for (const [at, entry] of entries.entries()) {
                if (byOpenCode[at]) {
                    await mustRun(system, 'opencode', ['plugin', 'remove', entry.spec], inConfigOf(system, entry));
                }
                else {
                    await system.writeFile(entry.file, await withoutEntry(system, entry));
                }

                removed.push(redact(entry.spec));
            }

            removed.push(...await removeLegacy(system));

            return result('done', `removed ${removed.join(' and ')}`, NEXT);
        });
    }
};
