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

// A route reads its MCP headers under exactly one of these. The other spelling
// is dropped without an error, leaving the traffic unattributed.
const HEADER_KEY_BY_MANIFEST_DIR = { '.codex-plugin': 'http_headers' },
    DEFAULT_HEADER_KEY = 'headers',
    MANIFEST_DIR_PATTERN = /^\..+-plugin$/,

    // Routes with no manifest for MANIFEST_DIR_PATTERN to match. A route in
    // neither set is never checked, which looks exactly like passing.
    CONFIG_ONLY_ROUTES = [
        { file: 'opencode.json', serverKey: 'mcp', ignoredServerKey: 'mcpServers', headerKey: 'headers' }
    ];

const ROOT = repoRootOrExit();

if (!isThisRepo()) {
    process.exit(0);
}

const errors = [],
    sources = new Map();

// Every later check reads files this one validates, so a parse error stops here
// rather than surfacing as a crash inside the next check.
everyTrackedJsonParses();

if (errors.length) {
    report();
}

// These accumulate, so one commit surfaces every problem at once. Uniqueness
// runs last because the route checks are what populate `sources`.
manifestIsInSyncWithSkillFiles();
manifestRoutesAgreeWithTheirMcpConfig();
configOnlyRoutesCarryTheirOwnAttribution();
noTwoRoutesShareAnXSource();

report();

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
        const manifestRel = `${dir}/plugin.json`,
            manifest = readJson(manifestRel),
            version = manifest.version;

        // The marketplace route declares no version on purpose, and a route may
        // legitimately ship no MCP server at all.
        if (!version || !manifest.mcpServers) {
            continue;
        }

        const resolved = resolveMcpServers(manifest.mcpServers, manifestRel);

        if (!resolved) {
            continue;
        }

        const headerKey = HEADER_KEY_BY_MANIFEST_DIR[dir] || DEFAULT_HEADER_KEY,
            ignoredHeaderKey = headerKey === DEFAULT_HEADER_KEY ? 'http_headers' : DEFAULT_HEADER_KEY;

        for (const [name, server] of Object.entries(resolved.servers || {})) {
            const at = `${resolved.where} (${name})`,
                headers = server[headerKey] || {},
                source = recordSource(headers, at);

            if (server[ignoredHeaderKey]) {
                errors.push(`${at}: headers are under \`${ignoredHeaderKey}\`, but this route reads \`${headerKey}\` - the block is silently ignored and the traffic arrives unattributed`);
            }

            if (headers['X-Plugin-Version'] !== version) {
                errors.push(`${at}: X-Plugin-Version is ${headers['X-Plugin-Version'] || '(unset)'} but ${manifestRel} declares version ${version}`);
            }

            if (source) {
                checkUserAgent(headers, at, source, version);
            }
        }
    }
}

function configOnlyRoutesCarryTheirOwnAttribution () {
    for (const route of CONFIG_ONLY_ROUTES.filter((r) => exists(r.file))) {
        const cfg = readJson(route.file);

        if (cfg[route.ignoredServerKey]) {
            errors.push(`${route.file}: MCP servers are under \`${route.ignoredServerKey}\`, but this route reads \`${route.serverKey}\` - the block is ignored and no server is configured`);
        }

        for (const [name, server] of Object.entries(cfg[route.serverKey] || {})) {
            const at = `${route.file} (${name})`,
                headers = server[route.headerKey] || {},
                source = recordSource(headers, at),
                version = headers['X-Plugin-Version'];

            // No manifest field to compare against, so the two header strings
            // are only checked against each other.
            if (!version) {
                errors.push(`${at}: no X-Plugin-Version header - this route carries the version nowhere else, so the traffic is filed under none`);
            }

            if (source && version) {
                checkUserAgent(headers, at, source, version);
            }
        }
    }
}

function noTwoRoutesShareAnXSource () {
    for (const [source, routes] of sources) {
        if (routes.length > 1) {
            errors.push(`X-Source "${source}" is reused by ${routes.join(' and ')} - each route needs its own, or their telemetry collapses into one bucket`);
        }
    }
}

/** Returns the X-Source and remembers where it was claimed, or null if absent. */
function recordSource (headers, at) {
    const source = headers['X-Source'];

    if (!source) {
        errors.push(`${at}: no X-Source header - this route's MCP traffic cannot be attributed to it`);

        return null;
    }

    sources.set(source, (sources.get(source) || []).concat(at));

    return source;
}

function checkUserAgent (headers, at, source, version) {
    if (headers['User-Agent'] !== `${source}/${version}`) {
        errors.push(`${at}: User-Agent is ${headers['User-Agent'] || '(unset)'}, expected ${source}/${version}`);
    }
}

/** `mcpServers` is an inline object, or a path relative to the repo root. */
function resolveMcpServers (mcpServers, manifestRel) {
    if (typeof mcpServers !== 'string') {
        return { servers: mcpServers, where: manifestRel };
    }

    const where = mcpServers.replace(/^\.\//, '');

    if (!exists(where)) {
        errors.push(`${manifestRel}: mcpServers points at ${where}, which does not exist`);

        return null;
    }

    return { servers: readJson(where).mcpServers, where };
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
