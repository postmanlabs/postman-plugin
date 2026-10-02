#!/usr/bin/env node
// Installs this checkout into Kimi Code (`KIMI_BIN`, else `kimi` on PATH) with the `plugins` CLI the
// installer uses, under a throwaway home, and runs one `kimi -p` against a local stand-in for both an
// OpenAI-compatible model and Postman's MCP server. It then checks what Kimi sent each of them.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
    ENTRY_SKILL, assertMandate, assertMcpHeaders, assertSkillsListed, chatCompletion, copyCheckout, mandatedSkill,
    pointMcpAt, readJson, repoRoot, run, runAgent, skillExcerpt, skills, startStandIn, workspace
} from './lib/harness.js';

const kimi = process.env.KIMI_BIN || 'kimi',
    { root, home, project, remove } = workspace('kimi'),
    marketplace = path.join(root, 'postman-plugin'),
    kimiHome = path.join(home, '.kimi-code'),
    // The `plugins` release the installer pins, so this installs the way `npx @postman/postman-plugin` does.
    [, pluginsCli] = fs.readFileSync(path.join(repoRoot, 'installer', 'src', 'source.ts'), 'utf8').match(/PLUGINS_CLI = '([^']+)'/),
    { headers } = readJson(path.join(repoRoot, '.kimi-plugin', 'plugin.json')).mcpServers.postman,
    env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^KIMI_/.test(name))),
    slashes = (text) => text.replace(/\\/g, '/');

/** The session's first turn loads the entry skill by the name the mandate gives it, its second says "ok". */
function answer (request, body) {
    if (request.url.endsWith('/models')) {
        return { type: 'application/json', body: '{"data":[{"id":"echo"}]}' };
    }

    return chatCompletion.hasToolResult(body) ?
        { body: chatCompletion.say('ok') } :
        { body: chatCompletion.call('Skill', { skill: mandatedSkill(chatCompletion.transcript(body)) }) };
}

let standIn;

try {
    standIn = await startStandIn(answer);
    copyCheckout(marketplace);
    pointMcpAt(path.join(marketplace, '.kimi-plugin', 'plugin.json'), standIn.mcpUrl);

    Object.assign(env, {
        HOME: home,
        USERPROFILE: home,
        KIMI_CODE_HOME: kimiHome,
        KIMI_MODEL_PROVIDER_TYPE: 'openai',
        KIMI_MODEL_BASE_URL: `${standIn.base}/v1`,
        KIMI_MODEL_NAME: 'echo',
        KIMI_MODEL_API_KEY: 'harness',
        DISABLE_TELEMETRY: '1',
        DO_NOT_TRACK: '1'
    });

    run('npx', ['-y', `--package=${pluginsCli}`, 'plugins', 'add', marketplace, '--target', 'kimi', '--yes'], { env, cwd: project });

    const record = readJson(path.join(kimiHome, 'plugins', 'installed.json')).plugins.find(({ id }) => id === 'postman');

    assert.ok(record?.enabled, `postman is not enabled in ${path.join(kimiHome, 'plugins', 'installed.json')}`);

    const session = await runAgent(kimi, ['-p', 'Say ok.', '--output-format', 'stream-json'], { env, cwd: project }),
        turns = standIn.modelRequests.filter(({ url }) => url.endsWith('/chat/completions'));

    assert.equal(session.code, 0, `kimi exited ${session.code}\n${session.stdout}\n${session.stderr}`);
    assert.equal(turns.length, 2, `kimi called the model ${turns.length} times, not twice\n${session.stdout}\n${session.stderr}`);

    const [first, second] = turns.map(({ body }) => chatCompletion.transcript(body));

    assertSkillsListed('Kimi Code', first, (skill) => new RegExp(`^- ${skill}: `, 'm'));
    assertMandate('Kimi Code', first, { namespaced: false });
    assert.ok(second.includes(skillExcerpt(ENTRY_SKILL)), `the mandated skill did not load:\n${second.slice(-800)}`);
    assert.ok(slashes(second).includes(slashes(path.join(record.root, 'skills', ENTRY_SKILL))), `${ENTRY_SKILL} did not load from the installed plugin at ${record.root}`);
    assertMcpHeaders('Kimi Code', standIn.mcpRequests, headers);

    console.log(`kimi ${run(kimi, ['--version'], { env }).trim()} loaded ${skills.length} skills, the mandate and the postman MCP server from ${record.root}`);
}
finally {
    standIn?.server.close();
    remove();
}
