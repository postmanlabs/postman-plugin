#!/usr/bin/env node
/**
 * PreToolUse guard: refuses a `git commit` while the vendor routes disagree.
 * Silent when consistent; exits 2 with the reason when not.
 *
 * Vendor key spellings and per-route invariants are documented in
 * .claude/skills/add-marketplace/references/validation.md.
 */
'use strict';

const fs = require('fs'),
    path = require('path'),
    { execFileSync } = require('child_process');

// Each of these keys is read by one set of vendors and ignored without an error
// by the rest, so the wrong spelling leaves a route that loads, connects and
// reports nothing. Both spellings are checked for so that failure is loud.
const SERVER_KEYS = ['mcpServers', 'mcp'],
    HEADER_KEYS = ['headers', 'http_headers'],
    DEFAULT_ROUTE_KEYS = { serverKey: 'mcpServers', headerKey: 'headers' },

    // Every manifest route, with its deviations from DEFAULT_ROUTE_KEYS. An
    // unlisted `.*-plugin/` directory is reported, not checked against guesses.
    MANIFEST_ROUTES = {
        '.claude-plugin': {},
        '.codex-plugin': { headerKey: 'http_headers' },
        '.cursor-plugin': {},
        '.kimi-plugin': {}
    },
    MANIFEST_DIR_PATTERN = /^\..+-plugin$/,

    // Routes with no manifest for MANIFEST_DIR_PATTERN to match. A route missing
    // here is never checked, which looks exactly like passing.
    CONFIG_ONLY_ROUTES = [{ file: 'opencode.json', keys: { serverKey: 'mcp' } }],

    X_SOURCE_FORMAT = /^postman-[a-z0-9-]+-plugin$/;

const ROOT = repoRootOrExit();

if (!isThisRepo()) {
    process.exit(0);
}

const errors = [],
    sources = new Map();

try {
    runChecks();
}
catch (e) {
    // Only exit 2 blocks the commit; a crash exits 1 and lets it through.
    errors.push(`the guard itself failed (${e.message}) - blocking rather than letting an unchecked commit through`);
}

report();

function runChecks () {
    // Every later check reads files this one validates, so a parse error stops
    // here rather than surfacing as a crash inside the next check.
    everyTrackedJsonParses();

    if (errors.length) {
        return;
    }

    // These accumulate, so one commit surfaces every problem at once. Uniqueness
    // runs last because the route checks are what populate `sources`.
    manifestIsInSyncWithSkillFiles();
    manifestRoutesAgreeWithTheirMcpConfig();
    configOnlyRoutesCarryTheirOwnAttribution();
    noTwoRoutesShareAnXSource();
}

function everyTrackedJsonParses () {
    for (const file of trackedJsonFiles()) {
        try {
            readJson(file);
        }
        catch (e) {
            errors.push(`${file}: invalid JSON - ${e.message}`);
        }
    }
}

function manifestIsInSyncWithSkillFiles () {
    try {
        execFileSync('node', [path.join(ROOT, 'scripts', 'build-manifest.js'), '--check'], {
            cwd: ROOT,
            stdio: ['ignore', 'ignore', 'pipe']
        });
    }
    catch (e) {
        errors.push('manifest.json is stale. Run `node scripts/build-manifest.js` and stage the result.');
    }
}

function manifestRoutesAgreeWithTheirMcpConfig () {
    for (const dir of manifestRouteDirs()) {
        const manifestRel = `${dir}/plugin.json`;

        if (!Object.hasOwn(MANIFEST_ROUTES, dir)) {
            errors.push(`${manifestRel}: unregistered route - add '${dir}' to MANIFEST_ROUTES in this guard, with the server and header keys this vendor reads`);
            continue;
        }

        const manifest = readJson(manifestRel);

        checkRoute(manifest, manifestRel, routeKeys(MANIFEST_ROUTES[dir]), manifest && manifest.version);
    }
}

function configOnlyRoutesCarryTheirOwnAttribution () {
    for (const route of CONFIG_ONLY_ROUTES.filter((r) => exists(r.file))) {
        checkRoute(readJson(route.file), route.file, routeKeys(route.keys), null);
    }
}

function routeKeys (overrides) {
    return Object.assign({}, DEFAULT_ROUTE_KEYS, overrides);
}

/** `manifestVersion` is null for a route whose format carries no version key:
 *  with no field to compare against, the headers are checked against each other. */
function checkRoute (config, where, keys, manifestVersion) {
    if (!isObject(config)) {
        errors.push(`${where}: expected a JSON object`);

        return;
    }

    const found = mcpServersOf(config, where, keys.serverKey);

    if (!found) {
        return;
    }

    const ignoredHeaderKey = theOtherKey(HEADER_KEYS, keys.headerKey);

    for (const [name, server] of Object.entries(found.servers)) {
        const at = `${found.where} (${name})`;

        if (!isObject(server)) {
            errors.push(`${at}: expected a server object`);
            continue;
        }

        const headers = isObject(server[keys.headerKey]) ? server[keys.headerKey] : {},
            declared = headers['X-Plugin-Version'],
            source = recordSource(headers, at, where),
            version = manifestVersion || declared;

        if (server[ignoredHeaderKey]) {
            errors.push(`${at}: headers are under \`${ignoredHeaderKey}\`, but this route reads \`${keys.headerKey}\` - the block is silently ignored and the traffic arrives unattributed`);
        }

        if (!version) {
            errors.push(`${at}: no X-Plugin-Version header, and ${where} declares no version either - this route's traffic is filed under no version at all`);
        }
        else if (declared !== version) {
            errors.push(`${at}: X-Plugin-Version is ${declared || '(unset)'} but ${where} declares version ${version}`);
        }

        if (source && version && headers['User-Agent'] !== `${source}/${version}`) {
            errors.push(`${at}: User-Agent is ${headers['User-Agent'] || '(unset)'}, expected ${source}/${version}`);
        }
    }
}

function noTwoRoutesShareAnXSource () {
    for (const [source, routes] of sources) {
        if (routes.size > 1) {
            errors.push(`X-Source "${source}" is reused by ${[...routes].join(' and ')} - each route needs its own, or their telemetry collapses into one bucket`);
        }
    }
}

/** Returns the X-Source and remembers which route claimed it, or null if absent.
 *  Keyed by route, so two servers in one route may share their route's value. */
function recordSource (headers, at, route) {
    const source = headers['X-Source'];

    if (!source) {
        errors.push(`${at}: no X-Source header - this route's MCP traffic cannot be attributed to it`);

        return null;
    }

    if (!X_SOURCE_FORMAT.test(source)) {
        errors.push(`${at}: X-Source "${source}" is not of the form postman-<vendor>-plugin`);
    }

    sources.set(source, (sources.get(source) || new Set()).add(route));

    return source;
}

/** This route's MCP servers and the file holding them - inline, or the file the
 *  manifest points at - or null when it declares none. The wrong key is what
 *  this looks hardest for: with no servers to iterate, every later check passes
 *  by doing nothing. */
function mcpServersOf (config, where, serverKey) {
    const ignored = theOtherKey(SERVER_KEYS, serverKey),
        declared = config[serverKey];

    if (declared === undefined) {
        if (config[ignored]) {
            errors.push(wrongServerKey(where, serverKey, ignored));
        }

        // Otherwise the route ships no MCP server, which is allowed.
        return null;
    }

    const found = typeof declared === 'string' ?
        externalMcpServers(declared, where, serverKey, ignored) :
        { servers: declared, where };

    if (found && !isObject(found.servers)) {
        errors.push(`${found.where}: \`${serverKey}\` must be an object of named servers`);

        return null;
    }

    if (found && !Object.keys(found.servers).length) {
        errors.push(`${found.where}: \`${serverKey}\` is empty - this route configures no MCP server`);

        return null;
    }

    return found;
}

function externalMcpServers (declaredPath, where, serverKey, ignored) {
    const file = declaredPath.replace(/^\.\//, '');

    if (!exists(file)) {
        errors.push(`${where}: ${serverKey} points at ${file}, which does not exist`);

        return null;
    }

    const external = readJson(file);

    if (!isObject(external)) {
        errors.push(`${file}: expected a JSON object`);

        return null;
    }

    if (external[serverKey] === undefined) {
        errors.push(external[ignored] ?
            wrongServerKey(file, serverKey, ignored) :
            `${file}: no \`${serverKey}\` block, but ${where} points here for one`);

        return null;
    }

    return { servers: external[serverKey], where: file };
}

function wrongServerKey (where, serverKey, ignored) {
    return `${where}: MCP servers are under \`${ignored}\`, but this route reads \`${serverKey}\` - the block is silently ignored and no server is configured`;
}

function isObject (value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function theOtherKey (pair, key) {
    return pair[0] === key ? pair[1] : pair[0];
}

function manifestRouteDirs () {
    return fs.readdirSync(ROOT)
        .filter((d) => MANIFEST_DIR_PATTERN.test(d) && exists(`${d}/plugin.json`))
        .sort();
}

function trackedJsonFiles () {
    try {
        return execFileSync('git', ['ls-files', '*.json'], { cwd: ROOT, encoding: 'utf8' })
            .split('\n')
            .filter(Boolean);
    }
    catch (e) {
        // A git hiccup should not block the commit.
        return [];
    }
}

function repoRootOrExit () {
    try {
        return execFileSync('git', ['rev-parse', '--show-toplevel'], {
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'ignore']
        }).trim();
    }
    catch (e) {
        process.exit(0);
    }
}

/** A `git commit` in any other repository is none of our business. */
function isThisRepo () {
    return exists(path.join('scripts', 'build-manifest.js'));
}

function exists (rel) {
    return fs.existsSync(path.join(ROOT, rel));
}

function readJson (rel) {
    return JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
}

function report () {
    if (!errors.length) {
        process.exit(0);
    }

    process.stderr.write(
        'Manifest validation failed - commit blocked:\n' +
        errors.map((e) => `  - ${e}`).join('\n') +
        '\nFix these, stage the result, then commit again.\n'
    );
    process.exit(2);
}
