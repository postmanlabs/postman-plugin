#!/usr/bin/env node
// Installs this checkout where the installer puts it, ~/.cursor/plugins/local/postman under a throwaway
// home, and checks it from the Cursor CLI (`CURSOR_BIN`, else `cursor-agent` on PATH). The CLI talks
// only to Cursor's backend, so the session runs on Cursor's model with `CURSOR_API_KEY`, and the
// model reports what reached it. The MCP server is a local stand-in that records Cursor's headers.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
    ENTRY_SKILL, assertMcpHeaders, copyCheckout, pointMcpAt, readJson, repoRoot, run, runAgent, skillExcerpt,
    skills, startStandIn, workspace
} from './lib/harness.js';

assert.ok(process.env.CURSOR_API_KEY, 'CURSOR_API_KEY is not set; the Cursor CLI has no offline mode, so this harness needs a Cursor API key');

const cursor = process.env.CURSOR_BIN || 'cursor-agent',
    { home, project, remove } = workspace('cursor'),
    plugin = path.join(home, '.cursor', 'plugins', 'local', 'postman'),
    { headers } = readJson(path.join(repoRoot, 'mcp.cursor.json')).mcpServers.postman,
    mandate = fs.readFileSync(path.join(repoRoot, 'hooks', 'session-start-context.md'), 'utf8'),
    // A sentence only the mandate has, and the skill it names in the form Cursor should get: bare.
    [, sentence] = mandate.match(/load the `[^`]+` skill and follow it\. ([^.]+\.)/),
    env = { ...process.env, HOME: home, USERPROFILE: home };

const normalize = (text) => text.replace(/[`*_]/g, '').replace(/\s+/g, ' ').trim(),
    PROMPT = [
        'Answer from your context only, using no tools except to load a skill.',
        `1. Quote, exactly as written, the sentence in your context that ends with "${sentence.split(' ').slice(-6).join(' ')}"`,
        '2. On the next line, write the name of the skill the sentence before it tells you to load, exactly as it is written there, in backticks.',
        '3. Load that skill, then on the next line copy, verbatim, the first numbered line of its instructions.',
        '4. On the last line, write "SKILLS:" followed by the name of every skill available to you from the Postman plugin, exactly as listed, comma-separated.',
        'If your context has no such sentence, reply NONE.'
    ].join('\n');

let standIn;

try {
    standIn = await startStandIn(() => ({ status: 404, type: 'text/plain', body: '' }));
    copyCheckout(plugin);
    pointMcpAt(path.join(plugin, 'mcp.cursor.json'), standIn.mcpUrl);

    // Connecting is enough for the stand-in to see the headers; the 401 it answers fails the listing.
    await runAgent(cursor, ['mcp', 'list-tools', 'postman'], { env, cwd: project });
    assertMcpHeaders('Cursor', standIn.mcpRequests, headers);

    const session = await runAgent(cursor, ['-p', '--trust', '--output-format', 'json', PROMPT], { env, cwd: project, timeout: 300000 });

    assert.equal(session.code, 0, `cursor-agent exited ${session.code}\n${session.stdout}\n${session.stderr}`);

    const reply = normalize(JSON.parse(session.stdout).result ?? '');

    assert.ok(reply.includes(normalize(sentence)), `the session-start mandate did not reach Cursor's model; it replied:\n${reply}`);
    assert.doesNotMatch(reply, /postman:api-engineer/, `Cursor got the mandate with \`postman:\` skill names, which it cannot resolve:\n${reply}`);
    assert.ok(reply.includes(ENTRY_SKILL), `Cursor's model did not name ${ENTRY_SKILL}:\n${reply}`);
    assert.ok(reply.includes(normalize(skillExcerpt(ENTRY_SKILL))), `the mandated skill did not load from ${plugin}:\n${reply}`);

    const listed = (reply.split('SKILLS:').pop() ?? '').split(/[,\s]+/).map((name) => name.replace(/^postman:/, '')).filter(Boolean);

    assert.deepEqual(skills.filter((skill) => !listed.includes(skill)), [], `Cursor's model did not list every skill in manifest.json:\n${reply}`);

    console.log(`cursor-agent ${run(cursor, ['--version'], { env }).trim()} delivered the mandate, loaded ${ENTRY_SKILL} and connected to the postman MCP server from ${plugin}`);
}
finally {
    standIn?.server.close();
    remove();
}
