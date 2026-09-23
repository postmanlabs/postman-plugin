#!/usr/bin/env node
/**
 * PreToolUse guard: refuse a `git commit` while the vendor manifests disagree.
 *
 * Wired from .claude/settings.local.json with `if: "Bash(git commit*)"`, so it
 * only spawns on a commit. Silent when everything is consistent; on a problem it
 * writes to stderr and exits 2, which blocks the commit and hands the reason
 * back to Claude.
 *
 * The first two checks mirror CI's `manifest` job, just locally and without the
 * network. The rest are the ones CI cannot do cheaply and the README asks you to
 * "verify by eye": per-route version agreement, X-Source uniqueness, and that
 * each route spells its header and MCP keys the way that vendor deserializes
 * them. Every one of those is a silent failure at runtime - the traffic is
 * accepted and filed under a version that was never cut, two routes collapse
 * into one telemetry bucket, or a misspelled key is dropped and the requests go
 * out unattributed while the server still connects.
 *
 * Routes come in two shapes and both must be covered. Manifest routes are found
 * by globbing `.*-plugin/plugin.json`. Config-only routes (opencode) have no
 * manifest at all and match no such glob, so they are listed explicitly in
 * CONFIG_ONLY_ROUTES - a route that is in neither is invisible here, which
 * looks exactly like passing.
 *
 * Deliberately does NOT fetch vendor schemas. That needs network and an npx
 * download per run, which is too slow for a pre-commit gate; CI's `schema` job
 * owns it.
 */
'use strict';

const fs = require('fs'),
    path = require('path'),
    { execFileSync } = require('child_process');

let ROOT;

try {
    ROOT = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
}
catch (e) {
    // Not a git repo - nothing to guard.
    process.exit(0);
}

// Only guard this repository. A `git commit` anywhere else is none of our business.
if (!fs.existsSync(path.join(ROOT, 'scripts', 'build-manifest.js'))) {
    process.exit(0);
}

const errors = [],
    readJson = (rel) => JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8'));

// 1. Every tracked JSON parses. Run first - the checks below read these files,
//    and a parse error there would surface as a confusing crash instead.
let tracked = [];

try {
    tracked = execFileSync('git', ['ls-files', '*.json'], { cwd: ROOT, encoding: 'utf8' })
        .split('\n')
        .filter(Boolean);
}
catch (e) {
    // Fall through with an empty list rather than blocking on a git hiccup.
}

for (const file of tracked) {
    try {
        readJson(file);
    }
    catch (e) {
        errors.push(`${file}: invalid JSON - ${e.message}`);
    }
}

if (errors.length) {
    report();
}

// 2. manifest.json is in sync with the skill files.
try {
    execFileSync('node', [path.join(ROOT, 'scripts', 'build-manifest.js'), '--check'], {
        cwd: ROOT,
        stdio: ['ignore', 'ignore', 'pipe']
    });
}
catch (e) {
    errors.push('manifest.json is stale. Run `node scripts/build-manifest.js` and stage the result.');
}

// 3. Per-route version agreement and X-Source uniqueness.
const sources = new Map();

for (const dir of fs.readdirSync(ROOT).filter((d) => /^\..+-plugin$/.test(d)).sort()) {
    const manifestRel = `${dir}/plugin.json`;

    if (!fs.existsSync(path.join(ROOT, manifestRel))) {
        continue;
    }

    const manifest = readJson(manifestRel),
        version = manifest.version;

    // The marketplace route declares no version on purpose, and a route may
    // legitimately ship no MCP server at all.
    if (!version || !manifest.mcpServers) {
        continue;
    }

    // `mcpServers` is either a path relative to the plugin root (the repo root,
    // not the manifest's own directory) or an inline object.
    let block = manifest.mcpServers,
        where = manifestRel;

    if (typeof block === 'string') {
        where = block.replace(/^\.\//, '');

        if (!fs.existsSync(path.join(ROOT, where))) {
            errors.push(`${manifestRel}: mcpServers points at ${where}, which does not exist`);
            continue;
        }

        block = readJson(where).mcpServers;
    }

    // Vendors disagree on the spelling, and the wrong one is not an error at
    // runtime - it is silently dropped, so the server still connects and every
    // request goes out unattributed. Claude Code, Cursor and Kimi read `headers`;
    // Codex deserializes into its own `RawMcpServerConfig`, which has only
    // `http_headers` and carries `#[schemars(deny_unknown_fields)]` - schemars,
    // for schema generation, not serde - so serde ignores anything else.
    const headerKey = dir === '.codex-plugin' ? 'http_headers' : 'headers',
        otherKey = headerKey === 'headers' ? 'http_headers' : 'headers';

    for (const [name, server] of Object.entries(block || {})) {
        const headers = server[headerKey] || {},
            source = headers['X-Source'],
            at = `${where} (${name})`;

        if (server[otherKey]) {
            errors.push(`${at}: headers are under \`${otherKey}\`, but this route reads \`${headerKey}\` - the block is silently ignored and the traffic arrives unattributed`);
        }

        if (!source) {
            errors.push(`${at}: no X-Source header - this route's MCP traffic cannot be attributed to it`);
        }
        else {
            sources.set(source, (sources.get(source) || []).concat(at));
        }

        if (headers['X-Plugin-Version'] !== version) {
            errors.push(`${at}: X-Plugin-Version is ${headers['X-Plugin-Version'] || '(unset)'} but ${manifestRel} declares version ${version}`);
        }

        if (source && headers['User-Agent'] !== `${source}/${version}`) {
            errors.push(`${at}: User-Agent is ${headers['User-Agent'] || '(unset)'}, expected ${source}/${version}`);
        }
    }
}

// 3b. Config-only routes, which the glob above cannot see. opencode has no
//     plugin manifest at all: its route is the project config at the repo root,
//     the `mcp` block is always inline, and there is no `version` key anywhere -
//     the config schema is `additionalProperties: false`, so one cannot be
//     added. That leaves two invariants: X-Source presence and uniqueness, and
//     agreement between the two header strings, since no manifest field exists
//     to compare either of them against.
//
//     Patch contributed by the session that added the opencode route (PR #29),
//     which could not land it itself - this file is untracked and outside that
//     branch.
const CONFIG_ONLY_ROUTES = [
    { file: 'opencode.json', serverKey: 'mcp', wrongServerKey: 'mcpServers', headerKey: 'headers' }
];

for (const route of CONFIG_ONLY_ROUTES) {
    if (!fs.existsSync(path.join(ROOT, route.file))) {
        continue;
    }

    const cfg = readJson(route.file);

    if (cfg[route.wrongServerKey]) {
        errors.push(`${route.file}: MCP servers are under \`${route.wrongServerKey}\`, but this route reads \`${route.serverKey}\` - the block is ignored and no server is configured`);
    }

    for (const [name, server] of Object.entries(cfg[route.serverKey] || {})) {
        const headers = server[route.headerKey] || {},
            source = headers['X-Source'],
            version = headers['X-Plugin-Version'],
            at = `${route.file} (${name})`;

        if (!source) {
            errors.push(`${at}: no X-Source header - this route's MCP traffic cannot be attributed to it`);
        }
        else {
            sources.set(source, (sources.get(source) || []).concat(at));
        }

        // No manifest `version` to check against, by construction, so the two
        // header strings are only checked against each other.
        if (!version) {
            errors.push(`${at}: no X-Plugin-Version header - this route carries the version nowhere else, so the traffic is filed under none`);
        }

        if (source && version && headers['User-Agent'] !== `${source}/${version}`) {
            errors.push(`${at}: User-Agent is ${headers['User-Agent'] || '(unset)'}, expected ${source}/${version}`);
        }
    }
}

for (const [source, routes] of sources) {
    if (routes.length > 1) {
        errors.push(`X-Source "${source}" is reused by ${routes.join(' and ')} - each route needs its own, or their telemetry collapses into one bucket`);
    }
}

report();

/** Writes any errors to stderr and exits 2 to block the commit, else exits 0 silently. */
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
