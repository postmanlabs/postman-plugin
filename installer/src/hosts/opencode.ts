import { createHash } from 'node:crypto';
import path from 'node:path';
import { OPENCODE_MINIMUM, OPENCODE_SHIM, OPENCODE_SPEC, REPO, isSameRepo, redact } from '../source.js';
import type { ExecOptions, System } from '../system.js';
import { parseJsonc, withoutArrayString } from './opencode-config.js';
import { assertCloneRemovable, blocked, failed, guard, mustRun, removeClone } from './shared.js';
import { type Host, result } from './types.js';

type Version = { major: number; text: string };
// `form` is how the list holds it: a bare string, OpenCode 1's `[spec, options]` tuple or OpenCode 2's `{ package }`.
// `shadowed`: OpenCode 1 never reads it, since the `plugin` list in opencode.jsonc beside it replaces opencode.json's.
type Entry = { dir: string; file: string; key: string; spec: string; form: 'string' | 'tuple' | 'object'; shadowed: boolean };

// OpenCode 1 lists its plugins under `plugin`, OpenCode 2 under `plugins`. OpenCode 2's `plugin add` and `plugin remove`
// edit the first of these that exists in the config directory (`resolveConfigPath` in its packages/cli).
const KEYS = ['plugin', 'plugins'],
    CONFIG_FILES = ['opencode.json', 'opencode.jsonc', path.join('.opencode', 'opencode.json'), path.join('.opencode', 'opencode.jsonc')],
    samePath = (a: string, b: string) => path.relative(a, b) === '',
    NEXT = 'Restart OpenCode for the change to take effect.',
    // Installs another spec instead, such as a copy of a change before it merges.
    SPEC_VARIABLE = 'POSTMAN_PLUGIN_OPENCODE_SPEC',
    configDir = (system: System) => path.join(system.env.XDG_CONFIG_HOME || path.join(system.home, '.config'), 'opencode'),
    // OpenCode 2 reads only OPENCODE_CONFIG_DIR when it is set (`Global` in its packages/util/src/global.ts); OpenCode 1
    // reads it as well as the default directory. `major` is null where an entry anywhere matters, as for remove.
    configDirs = (system: System, major: number | null) => (major !== null && major >= 2 && system.env.OPENCODE_CONFIG_DIR ?
        [system.env.OPENCODE_CONFIG_DIR] :
        [system.env.OPENCODE_CONFIG_DIR, configDir(system)])
        .filter((dir): dir is string => Boolean(dir))
        .filter((dir, at, dirs) => dirs.findIndex((other) => samePath(other, dir)) === at),
    // OpenCode 2 keeps one cached copy of each git plugin here, named `git-<slug>-<first 12 hex of sha256(spec)>`.
    cachedCopy = (system: System, spec: string) => path.join(
        system.env.XDG_CACHE_HOME || path.join(system.home, '.cache'),
        'opencode',
        'npm',
        `git-${gitSlug(spec)}-${createHash('sha256').update(spec).digest('hex').slice(0, 12)}`
    ),
    // `plugin add` and `plugin remove` act on OPENCODE_CONFIG_DIR when it is set, wherever our entry was found.
    // Compared as paths, not strings: Windows spells the same directory with either slash, in any case.
    inConfigOf = (system: System, entry: Entry) => (system.env.OPENCODE_CONFIG_DIR && !samePath(system.env.OPENCODE_CONFIG_DIR, entry.dir) ?
        { env: { OPENCODE_CONFIG_DIR: entry.dir } } :
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

/** What this run installs: `OPENCODE_SPEC`, or the spec POSTMAN_PLUGIN_OPENCODE_SPEC names. */
const specToInstall = (system: System) => system.env[SPEC_VARIABLE] || OPENCODE_SPEC;

/** The plugin's repository through `github:` or a git URL at any ref or range, or the spec POSTMAN_PLUGIN_OPENCODE_SPEC installs. */
function isOurSpec (system: System, spec: string): boolean {
    const bare = spec.split('#')[0];

    if (spec === system.env[SPEC_VARIABLE]) {
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

/** Our entries in OpenCode's global config, and the config files that could not be read. */
async function configured (system: System, major: number | null): Promise<{ entries: Entry[]; unreadable: string[] }> {
    const entries: Entry[] = [],
        unreadable: string[] = [],
        jsoncLists = new Set<string>();

    for (const [dir, file] of configDirs(system, major).flatMap((dir) => CONFIG_FILES.map((name) => [dir, path.join(dir, name)]))) {
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
                    entries.push({ dir, file, key, spec, form, shadowed: false });
                }
            }
        }

        if (path.basename(file) === 'opencode.jsonc' && Array.isArray(config.plugin)) {
            jsoncLists.add(dir);
        }
    }

    // OpenCode 1 merges its global opencode.json and then opencode.jsonc with a merge that replaces arrays.
    for (const entry of entries) {
        entry.shadowed = entry.key === 'plugin' && path.basename(entry.file) === 'opencode.json' && jsoncLists.has(entry.dir);
    }

    return { entries, unreadable };
}

async function readableEntries (system: System, major: number | null): Promise<Entry[]> {
    const { entries, unreadable } = await configured(system, major);

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

/** The file OpenCode 2's `plugin add` and `plugin remove` edit in `dir`; `remove` exits 0 when the entry is in another one. */
async function editedFile (system: System, dir: string): Promise<string> {
    for (const name of CONFIG_FILES) {
        if (await system.exists(path.join(dir, name))) {
            return path.join(dir, name);
        }
    }

    return path.join(dir, CONFIG_FILES[0]);
}

/** The major of the `opencode` on PATH, or null when it can't say; only OpenCode 2 has `plugin remove`. */
async function cliMajor (system: System): Promise<number | null> {
    const probe = await system.probe('opencode', ['--version']),
        match = probe.code === 0 ? probe.stdout.match(/(\d+)\.\d+\.\d+/) : null;

    return match ? Number(match[1]) : null;
}

async function removedByOpenCode (system: System, entry: Entry): Promise<boolean> {
    return entry.key === 'plugins' && entry.form !== 'tuple' && samePath(entry.file, await editedFile(system, entry.dir));
}

/** The config without the entry, for an entry OpenCode has no command to remove; refuses one it can't take out cleanly. */
async function withoutEntry (system: System, entry: Entry): Promise<string> {
    const text = await system.readFile(entry.file),
        edited = text === null || entry.form !== 'string' ? null : withoutArrayString(text, entry.key, entry.spec);

    return edited ?? blocked(`could not remove ${redact(entry.spec)} from ${entry.file} without rewriting it; delete that entry yourself and re-run`);
}

/**
 * The file OpenCode's add writes. OpenCode 1's `plugin --global` writes its default config directory, whatever
 * OPENCODE_CONFIG_DIR says, and there the first of opencode.json and opencode.jsonc that exists (`patchOne` in its
 * plugin/install.ts).
 */
async function destination (system: System, version: Version, entry: Entry): Promise<string> {
    if (version.major >= 2) {
        return editedFile(system, entry.dir);
    }

    const json = path.join(configDir(system), CONFIG_FILES[0]),
        jsonc = path.join(configDir(system), CONFIG_FILES[1]);

    return (await system.exists(json)) || !(await system.exists(jsonc)) ? json : jsonc;
}

/** OpenCode 1 adds to opencode.json, but ignores that file's list when the opencode.jsonc beside it has one of its own. */
async function assertAddIsRead (system: System, version: Version): Promise<void> {
    const jsonc = path.join(configDir(system), CONFIG_FILES[1]);

    if (version.major >= 2 || !(await system.exists(path.join(configDir(system), CONFIG_FILES[0])))) {
        return;
    }

    const config = parseJsonc<Record<string, unknown>>((await system.readFile(jsonc)) ?? '{}');

    if (Array.isArray(config?.plugin)) {
        blocked(`OpenCode 1 would add Postman to ${path.join(configDir(system), CONFIG_FILES[0])}, but reads only the \`plugin\` list in ${jsonc}; add \`${redact(specToInstall(system))}\` to that list yourself, or merge the two files, and re-run`);
    }
}

/** Refuses an entry OpenCode's add would not write back to: it would register a second copy elsewhere instead. */
async function assertLands (system: System, version: Version, entry: Entry): Promise<void> {
    const target = await destination(system, version, entry);

    if (!samePath(entry.file, target)) {
        blocked(`${entry.file} registers ${redact(entry.spec)}, but OpenCode would write to ${target}; move the entry, with any options, there and re-run`);
    }
}

/** Refetches a git spec the entry already names. */
async function refreshInPlace (system: System, version: Version, entry: Entry): Promise<void> {
    await assertLands(system, version, entry);
    await addFresh(system, version, entry.spec, inConfigOf(system, entry), true);
}

/** Adds `spec`, then takes out the entry it supersedes; a refusal to take it out comes before anything is added. */
async function replaceEntry (system: System, version: Version, entry: Entry, spec: string): Promise<void> {
    // OpenCode 1 would add the new spec to another file and leave the old file's list overriding it.
    if (version.major < 2) {
        await assertLands(system, version, entry);
    }

    const byOpenCode = version.major >= 2 && await removedByOpenCode(system, entry);

    if (!byOpenCode) {
        await withoutEntry(system, entry);
    }

    // OpenCode 1 replaces an entry for the same package in place only when forced; unforced, it changes nothing.
    await addFresh(system, version, spec, inConfigOf(system, entry), true);

    // Either major may have replaced it in place already.
    if (!(await configured(system, version.major)).entries.some((left) => left.spec === entry.spec && left.key === entry.key && samePath(left.file, entry.file))) {
        return;
    }

    if (byOpenCode) {
        await mustRun(system, 'opencode', ['plugin', 'remove', entry.spec], inConfigOf(system, entry));
    }
    else {
        await system.writeFile(entry.file, await withoutEntry(system, entry));
    }
}

/**
 * OpenCode 2 caches a git plugin by its spec and `plugin add` reuses the cache, even one an earlier
 * `plugin remove` left behind, so a newer commit only arrives when the cached copy is gone; `plugin update`
 * would do it but needs OpenCode's background service, which a second instance or a cold start answers
 * wrongly. The copy is moved aside, not deleted, so a failed fetch leaves the plugin as it was. OpenCode 1
 * re-resolves a git spec on every add; `force` makes it replace an entry for the same package in place.
 */
async function addFresh (system: System, version: Version, spec: string, options?: ExecOptions, force = false): Promise<void> {
    if (version.major < 2) {
        await mustRun(system, 'opencode', ['plugin', '--global', ...(force ? ['--force'] : []), spec], options);

        return;
    }

    const copy = cachedCopy(system, spec),
        previous = `${copy}.previous`,
        cached = await system.exists(copy);

    if (cached) {
        await system.remove(previous);
        await system.rename(copy, previous);
    }

    try {
        await mustRun(system, 'opencode', ['plugin', 'add', spec], options);
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
        const { entries, unreadable } = await configured(system, await cliMajor(system)),
            { cloned, shim, loadable } = await legacyState(system),
            legacy = loadable && shim === OPENCODE_SHIM,
            notes = [
                ...(legacy ? [`${cloneDir(system)} loads the same skills and will be removed`] : []),
                ...(shim !== null && shim !== OPENCODE_SHIM ? [`${shimFile(system)} has other contents; install will refuse to remove it`] : []),
                ...(cloned && !loadable ? [`${cloneDir(system)} exists but has no opencode/src/index.ts for a loader to import`] : [])
            ];

        const read = entries.filter((entry) => !entry.shadowed),
            shadowed = entries.filter((entry) => entry.shadowed).map((entry) => `${entry.file} registers ${redact(entry.spec)}, but OpenCode 1 reads the opencode.jsonc beside it instead`);

        if (read.length) {
            return { installed: true, detail: `${redact(read[0].spec)} in ${read[0].file}`, notes: [...shadowed, ...notes] };
        }

        if (shadowed.length) {
            return { installed: false, detail: 'not loaded', notes: [...shadowed, ...notes] };
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
                entries = await readableEntries(system, version.major),
                spec = specToInstall(system),
                entry = entries[0];

            // Each would load the same skills, and refreshing one would leave the others loading the rest.
            if (entries.length > 1) {
                blocked(`found ${entries.length} entries for Postman (${entries.map((found) => `${redact(found.spec)} in ${found.file}`).join(', ')}); keep one, with any options, and re-run`);
            }

            if (entry?.shadowed) {
                blocked(`${entry.file} registers ${redact(entry.spec)}, but OpenCode 1 reads only the \`plugin\` list in the opencode.jsonc beside it; move the entry there and re-run`);
            }

            // Both copies would load the same skills, so an older install that cannot be deleted whole stops us before the new one goes in.
            await preflightLegacy(system);

            if (!entry) {
                await assertAddIsRead(system, version);
                await addFresh(system, version, spec);

                return result('done', summary('installed', redact(spec), await removeLegacy(system)), NEXT);
            }

            // An entry under the other major's list is moved over: refreshing it would add a second one under this major's.
            const refresh = entry.spec === spec && entry.key === (version.major >= 2 ? 'plugins' : 'plugin');

            if (refresh) {
                await refreshInPlace(system, version, entry);
            }
            else {
                await replaceEntry(system, version, entry, spec);
            }

            return result('done', summary(refresh ? 'updated' : `replaced ${redact(entry.spec)} under \`${entry.key}\` with`, redact(spec), await removeLegacy(system)), NEXT);
        });
    },

    remove (system) {
        return guard(async () => {
            const entries = await readableEntries(system, null),
                { cloned, shim } = await legacyState(system);

            if (!entries.length && !cloned && shim !== OPENCODE_SHIM) {
                return result('skipped', 'not installed');
            }

            // Everything that can refuse is checked before anything is removed, so a refusal leaves no half-removed state.
            await preflightLegacy(system);

            const hasRemove = ((await cliMajor(system)) ?? 0) >= 2,
                byOpenCode = await Promise.all(entries.map(async (entry) => hasRemove && removedByOpenCode(system, entry)));

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
