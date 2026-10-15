#!/usr/bin/env node
// Installs this checkout into Antigravity (`AGY_BIN`, else `agy` on PATH) under a throwaway home and
// checks what agy registered: every skill in manifest.json, the always-on rule carrying the mandate,
// and the postman MCP server with this route's headers.
//
// This checks the install, not the session. agy 1.3.5 reaches a stand-in model through
// AGY_LLM_GATEWAY_URL, but signed out it sends that model no skills and no rules at all, even
// project ones, so checking what reaches the model needs a signed-in Antigravity account.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { copyCheckout, readJson, repoRoot, run, skills, workspace } from './lib/harness.js';

const agy = process.env.AGY_BIN || 'agy',
    { root, home, project, remove } = workspace('antigravity'),
    plugin = path.join(root, 'postman-plugin'),
    env = { ...process.env, HOME: home, USERPROFILE: home },
    mandate = fs.readFileSync(path.join(repoRoot, 'hooks', 'session-start-context.md'), 'utf8'),
    { headers } = readJson(path.join(repoRoot, 'mcp_config.json')).mcpServers.postman;

try {
    copyCheckout(plugin);
    run(agy, ['plugin', 'validate', plugin], { env, cwd: project });
    run(agy, ['plugin', 'install', plugin], { env, cwd: project });

    const installed = JSON.parse(run(agy, ['plugin', 'list', '--json'], { env, cwd: project })).find(({ name }) => name === 'postman');

    assert.ok(installed, 'agy plugin list --json has no postman plugin after the install');
    assert.equal(installed.enabled, true, 'postman installed disabled');
    assert.equal(installed.version, readJson(path.join(repoRoot, '.antigravity-plugin', 'plugin.json')).version, 'agy read a version other than .antigravity-plugin/plugin.json\'s, so it loaded another route\'s manifest');
    assert.deepEqual([...installed.skills].sort(), [...skills].sort(), 'agy registered a different skill set from manifest.json');
    assert.ok(installed.rules?.includes('GEMINI.md'), `agy registered no rules/GEMINI.md, so nothing carries the mandate: ${JSON.stringify(installed.rules)}`);
    assert.ok(installed.mcpServers?.includes('postman'), `agy registered no postman MCP server: ${JSON.stringify(installed.mcpServers)}`);

    const rule = fs.readFileSync(path.join(installed.path, 'rules', 'GEMINI.md'), 'utf8'),
        server = readJson(path.join(installed.path, 'mcp_config.json')).mcpServers.postman;

    assert.match(rule, /<EXTREMELY_IMPORTANT>\s*You have the Postman plugin/, 'the installed rules/GEMINI.md does not carry the mandate');
    assert.equal(rule, mandate.replace(/`postman:([a-z0-9-]+)`/g, '`$1`'), 'the installed rules/GEMINI.md is not the shared mandate with bare skill names');
    assert.equal(server.serverUrl, 'https://mcp.postman.com/mcp', 'the installed MCP server is not Postman\'s, under the `serverUrl` key agy reads');
    assert.deepEqual(server.headers, headers, 'the installed MCP server lost this route\'s headers');

    console.log(`agy ${run(agy, ['--version'], { env }).trim()} registered ${skills.length} skills, rules/GEMINI.md and the postman MCP server from ${installed.path}`);
}
finally {
    remove();
}
