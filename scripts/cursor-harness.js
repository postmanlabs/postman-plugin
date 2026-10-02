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
    // One line: npm's and Cursor's Windows .cmd shims end an argument at its first newline.
    PROMPT = [
        'Answer from your context only, using no tool except one that loads a skill.',
        'Reply with only a JSON object with these keys:',
        `"mandate": the sentence in your context that ends with "${sentence.split(' ').slice(-6).join(' ')}", quoted exactly, or null;`,
        '"skill": the name of the skill the sentence before it tells you to load, exactly as written there, or null;',
        '"firstLine": after loading that skill, the first numbered line of its instructions, verbatim, or null;',
        '"skills": the name of every skill available to you that comes from the Postman plugin, exactly as listed.'
    ].join(' ');

async function ask (extra = []) {
    const session = await runAgent(cursor, ['-p', '--trust', '--approve-mcps', '--output-format', 'json', ...extra, PROMPT], { env, cwd: project, timeout: 300000 });

    assert.equal(session.code, 0, `cursor-agent exited ${session.code}\n${session.stdout}\n${session.stderr}`);

    try {
        return JSON.parse(JSON.parse(session.stdout).result.replace(/^[^{]*|[^}]*$/g, ''));
    }
    catch {
        assert.fail(`cursor-agent did not answer with JSON:\n${session.stdout}\n${session.stderr}`);
    }
}

const readText = (file) => (fs.existsSync(file) && fs.statSync(file).isFile() ? fs.readFileSync(file, 'utf8').slice(0, 2000) : '(directory or missing)');

/** Paths under `dir`, three levels deep, skipping the copy of this checkout. */
function tree (dir, depth = 3) {
    return depth === 0 || !fs.existsSync(dir) ? [] : fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const full = path.join(dir, entry.name);

        return full === plugin ? [`${full}/ (this checkout)`] : [full, ...(entry.isDirectory() ? tree(full, depth - 1) : [])];
    });
}

let standIn;

try {
    standIn = await startStandIn(() => ({ status: 404, type: 'text/plain', body: '' }));
    copyCheckout(plugin);
    pointMcpAt(path.join(plugin, 'mcp.cursor.json'), standIn.mcpUrl);

    const answer = await ask(),
        reply = JSON.stringify(answer, null, 2),
        listed = (answer.skills ?? []).map((name) => String(name).replace(/^postman:/, ''));

    console.log(`Cursor's model replied:\n${reply}`);

    if (!listed.length) {
        const withPluginDir = await ask(['--plugin-dir', plugin]);

        assert.fail([
            `Cursor loaded no Postman skill from ${plugin}.`,
            `With --plugin-dir it answered: ${JSON.stringify(withPluginDir, null, 2)}`,
            ...['cli-config.json', 'agent-cli-state.json'].map((file) => `${file}: ${readText(path.join(home, '.cursor', file))}`),
            ...tree(path.join(home, '.cursor', 'managed')).map((file) => `${file}: ${readText(file)}`)
        ].join('\n'));
    }
    assert.equal(normalize(answer.mandate ?? ''), normalize(sentence), `the session-start mandate did not reach Cursor's model:\n${reply}`);
    assert.equal(normalize(answer.skill ?? ''), ENTRY_SKILL, `Cursor's model did not name ${ENTRY_SKILL} as the mandate spells it for Cursor, without \`postman:\`:\n${reply}`);
    assert.equal(normalize(answer.firstLine ?? ''), normalize(skillExcerpt(ENTRY_SKILL)), `the mandated skill did not load from ${plugin}:\n${reply}`);
    assert.deepEqual(skills.filter((skill) => !listed.includes(skill)), [], `Cursor's model did not list every skill in manifest.json:\n${reply}`);

    if (!standIn.mcpRequests.length) {
        const listing = await runAgent(cursor, ['mcp', 'list'], { env, cwd: project });

        assert.fail(`Cursor never connected to the Postman MCP server. \`cursor-agent mcp list\` exited ${listing.code}:\n${listing.stdout}\n${listing.stderr}`);
    }
    assertMcpHeaders('Cursor', standIn.mcpRequests, headers);

    console.log(`cursor-agent ${run(cursor, ['--version'], { env }).trim()} delivered the mandate, loaded ${ENTRY_SKILL} and connected to the postman MCP server from ${plugin}`);
}
finally {
    standIn?.server.close();
    remove();
}
