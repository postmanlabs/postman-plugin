#!/usr/bin/env node
/**
 * Says which plugin routes need a version bump, and writes the bumps, by the rule in
 * .claude/skills/release-installer/SKILL.md's "Route versions". Pi is left out: its
 * version is the installer's, which that skill's `bump` sets.
 *
 *   node scripts/route-versions.js                         each route's version and what it needs
 *   node scripts/route-versions.js --write [<id>=<x.y.z>]  bump every stale route, to the version given or the one proposed
 *   node scripts/route-versions.js --check [--base <ref>]  exit 1 while a route is stale; with --base, only when
 *                                                         HEAD moves a version since <ref>, which makes it a release
 */
'use strict';

const fs = require('fs'),
    path = require('path'),
    { execFileSync, spawnSync } = require('child_process'),
    { MANIFEST_ROUTES, PACKAGE_ROUTES } = require('./routes.js');

// What every route delivers: a change here is a release for each route whose agent updates by version.
const SHARED = ['skills', 'hooks', 'manifest.json'],
    DEFAULT_KEYS = { serverKey: 'mcpServers', headerKey: 'headers' },
    VERSION = /^(\d+)\.(\d+)\.(\d+)$/,
    ROOT = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();

function git (...args) {
    return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim();
}

const readJson = (file) => JSON.parse(fs.readFileSync(path.join(ROOT, file), 'utf8')),
    writeJson = (file, value) => fs.writeFileSync(path.join(ROOT, file), `${JSON.stringify(value, null, 2)}\n`),
    isShared = (file) => SHARED.some((shared) => file === shared || file.startsWith(`${shared}/`));

/** The manifest's `version` at `rev`, or undefined where the file is missing. */
function versionAt (rev, file) {
    const shown = spawnSync('git', ['show', `${rev}:${file}`], { cwd: ROOT, encoding: 'utf8' });

    return shown.status === 0 ? JSON.parse(shown.stdout).version : undefined;
}

/** The newest commit that changed the manifest's `version` value; reformatting the line doesn't count. */
function lastVersionChange (manifest) {
    for (const line of git('log', '--format=%H %P', '--', manifest).split('\n').filter(Boolean)) {
        const [sha, parent] = line.split(' ');

        if (!parent || versionAt(sha, manifest) !== versionAt(parent, manifest)) {
            return sha;
        }
    }

    return '';
}

/** Every file the manifest names, such as a logo or an apps file, short of the content all routes share. */
function referencedFiles (manifest) {
    const found = [],
        walk = (value) => {
            if (typeof value === 'string' && value.startsWith('./')) {
                found.push(path.posix.normalize(value).replace(/\/$/, ''));
            }
            else if (value && typeof value === 'object') {
                Object.values(value).forEach(walk);
            }
        };

    walk(readJson(manifest));

    return found.filter((file) => !isShared(file));
}

function manifestRoute ([dir, route]) {
    const manifest = `${dir}/plugin.json`,
        keys = { ...DEFAULT_KEYS, ...route },
        declared = readJson(manifest)[keys.serverKey],
        mcpConfig = route.mcpConfig || (typeof declared === 'string' ? declared.replace(/^\.\//, '') : null),
        owns = [...new Set([dir, mcpConfig, ...referencedFiles(manifest), ...(route.owns || [])].filter(Boolean))];

    return { manifest, mcpConfig, keys, updatesBy: route.updatesBy, owns, mirrors: [] };
}

function packageRoute (route) {
    return {
        manifest: route.manifest,
        mcpConfig: route.mcpConfig,
        keys: { ...DEFAULT_KEYS, ...route.keys },
        updatesBy: route.updatesBy,
        owns: [route.manifest, route.mcpConfig, ...(route.owns || [])],
        mirrors: route.mirrors || []
    };
}

/** The servers whose headers carry this route's version, and the file holding them: inline in Kimi's manifest. */
function serversOf (route, manifest) {
    const file = route.mcpConfig || route.manifest,
        config = file === route.manifest ? manifest : readJson(file);

    return { file, config, servers: Object.values(config[route.keys.serverKey]) };
}

/** The bump the commits call for: conventional-commit prefixes, and a 0.x route never reaches 1.0.0 by itself. */
function levelOf (commits, major) {
    if (commits.some(({ subject, body }) => /^[a-z]+(\([^)]*\))?!:/.test(subject) || /^BREAKING CHANGE:/m.test(body))) {
        return major === 0 ? 'minor' : 'major';
    }

    return commits.some(({ subject }) => /^feat(\([^)]*\))?!?:/.test(subject)) ? 'minor' : 'patch';
}

function increment (version, level) {
    const [major, minor, patch] = version.match(VERSION).slice(1).map(Number);

    return { major: `${major + 1}.0.0`, minor: `${major}.${minor + 1}.0`, patch: `${major}.${minor}.${patch + 1}` }[level];
}

function compare (a, b) {
    const [x, y] = [a, b].map((version) => version.match(VERSION).slice(1).map(Number));

    return x[0] - y[0] || x[1] - y[1] || x[2] - y[2];
}

function withState (route) {
    const manifest = readJson(route.manifest),
        { servers } = serversOf(route, manifest),
        since = lastVersionChange(route.manifest),
        watched = route.updatesBy === 'version' ? [...SHARED, ...route.owns] : route.owns,
        log = git('log', '--no-merges', '--format=%h%x1f%s%x1f%b%x00', since ? `${since}..HEAD` : 'HEAD', '--', ...watched),
        commits = log.split('\0').map((entry) => entry.trim()).filter(Boolean)
            .map((entry) => entry.split('\x1f')).map(([sha, subject, body = '']) => ({ sha, subject, body })),
        level = commits.length ? levelOf(commits, Number(manifest.version.split('.')[0])) : null;

    return {
        ...route,
        id: servers[0][route.keys.headerKey]['X-Source'].replace(/^postman-(.+)-plugin$/, '$1'),
        version: manifest.version,
        since: since.slice(0, 7) || 'its first commit',
        commits,
        level,
        proposed: level && increment(manifest.version, level)
    };
}

function routes () {
    return [
        ...Object.entries(MANIFEST_ROUTES).map(manifestRoute),
        ...PACKAGE_ROUTES.filter((route) => route.updatesBy !== 'installer').map(packageRoute)
    ].map(withState);
}

function describe (route) {
    const head = `${route.id.padEnd(12)} ${route.version.padEnd(7)} updates by ${route.updatesBy.padEnd(7)}`;

    if (!route.commits.length) {
        return `${head} current`;
    }

    return `${head} ${route.commits.length} change(s) since ${route.since} -> ${route.proposed} (${route.level})\n` +
        route.commits.map(({ sha, subject }) => `    ${sha} ${subject}`).join('\n');
}

function setVersion (route, version) {
    const manifest = readJson(route.manifest),
        { file, config, servers } = serversOf(route, manifest);

    manifest.version = version;

    for (const server of servers) {
        const headers = server[route.keys.headerKey];

        headers['X-Plugin-Version'] = version;
        headers['User-Agent'] = `${headers['X-Source']}/${version}`;
    }

    writeJson(route.manifest, manifest);

    if (file !== route.manifest) {
        writeJson(file, config);
    }

    for (const mirror of route.mirrors) {
        writeJson(mirror, { ...readJson(mirror), version });
    }

    const lock = path.join(path.dirname(route.manifest), 'package-lock.json');

    if (route.manifest.endsWith('package.json') && fs.existsSync(path.join(ROOT, lock))) {
        const content = readJson(lock);

        content.version = version;
        content.packages[''].version = version;
        writeJson(lock, content);
    }
}

function write (overrides) {
    const all = routes(),
        chosen = new Map();

    for (const override of overrides) {
        const [id, version] = override.split('='),
            route = all.find((entry) => entry.id === id);

        if (!route || !VERSION.test(version || '')) {
            throw new Error(`${override}: expected <id>=<x.y.z>, with an id of ${all.map((entry) => entry.id).join(', ')}`);
        }

        // An agent may still hold an older payload cached under a version that is reused.
        if (compare(version, route.version) <= 0) {
            throw new Error(`${override}: ${route.id} is at ${route.version}, and a bump must move it forward`);
        }

        chosen.set(route, version);
    }

    for (const route of all.filter((entry) => entry.proposed && !chosen.has(entry))) {
        chosen.set(route, route.proposed);
    }

    for (const [route, version] of chosen) {
        setVersion(route, version);
        console.log(`${route.id}: ${route.version} -> ${version}`);
    }

    if (!chosen.size) {
        console.log('every route is current');
    }
}

/** True when HEAD moves a route's or the installer's version since `base`: a release pull request. */
function movesAVersion (base) {
    const manifests = [...Object.keys(MANIFEST_ROUTES).map((dir) => `${dir}/plugin.json`), ...PACKAGE_ROUTES.map((route) => route.manifest)];

    return manifests.some((manifest) => versionAt(base, manifest) !== versionAt('HEAD', manifest));
}

function check (base) {
    if (base && !movesAVersion(base)) {
        console.log(`no version moves since ${base}, so this is not a release; nothing to check`);

        return;
    }

    const all = routes(),
        stale = all.filter((route) => route.commits.length),
        // A version moved back is read as a bump, so it must fail here as --write refuses it.
        lowered = base ? all.filter((route) => {
            const before = versionAt(base, route.manifest);

            return before && route.version !== before && compare(route.version, before) < 0;
        }) : [];

    for (const route of lowered) {
        console.log(`FAIL ${route.id} moves back from ${versionAt(base, route.manifest)} to ${route.version}; a bump must move it forward`);
    }

    for (const route of stale) {
        console.log(`FAIL ${describe(route)}`);
    }

    if (lowered.length) {
        process.exitCode = 1;
    }

    if (stale.length) {
        console.log('A release bumps every stale route. Run `node scripts/route-versions.js --write`, with ' +
            '<id>=<x.y.z> for any route whose proposed version is wrong, and commit the result.');
        process.exitCode = 1;

        return;
    }

    if (!lowered.length) {
        console.log('every route is current');
    }
}

const [command, ...args] = process.argv.slice(2);

try {
    if (command === undefined) {
        routes().forEach((route) => console.log(describe(route)));
    }
    else if (command === '--write') {
        write(args);
    }
    else if (command === '--check' && (args.length === 0 || (args[0] === '--base' && args[1] && args.length === 2))) {
        check(args[1]);
    }
    else {
        console.error('usage: route-versions.js [--write [<id>=<x.y.z>...] | --check [--base <ref>]]');
        process.exitCode = 2;
    }
}
catch (error) {
    console.error(error.message);
    process.exitCode = 2;
}
