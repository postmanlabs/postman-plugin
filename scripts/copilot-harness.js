#!/usr/bin/env node
// Installs this checkout into GitHub Copilot CLI (`COPILOT_BIN`, else `copilot` on PATH) as the
// `postman` marketplace, as the installer does, under a throwaway home, and runs one `copilot -p`
// offline against a local stand-in for both a BYOK OpenAI-compatible model and Postman's MCP server.
// It then checks what Copilot sent each of them. No GitHub account is used.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
    ENTRY_SKILL, assertMandate, assertMcpHeaders, assertSkillsListed, chatCompletion, copyCheckout, mandatedSkill,
    pointMcpAt, readJson, repoRoot, run, runAgent, skillExcerpt, skills, startStandIn, workspace
} from './lib/harness.js';

const copilot = process.env.COPILOT_BIN || 'copilot',
    { root, home, project, remove } = workspace('copilot'),
    marketplace = path.join(root, 'postman-plugin'),
    MARKETPLACE = readJson(path.join(repoRoot, '.claude-plugin', 'marketplace.json')).name,
    PLUGIN_ID = `postman@${MARKETPLACE}`,
    { headers } = readJson(path.join(repoRoot, 'mcp.copilot.json')).mcpServers.postman,
    env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^(CLAUDE|ANTHROPIC_|COPILOT_|GH_TOKEN$|GITHUB_TOKEN$)/.test(name)));

const isConversation = (body) => body.tools?.some((tool) => tool.function?.name === 'skill');

/** The session's hook events, which say whether the hook ran and failed when its output never reached the model. */
function hookEvents () {
    const sessions = path.join(home, '.copilot', 'session-state');

    return (fs.existsSync(sessions) ? fs.readdirSync(sessions) : [])
        .map((id) => path.join(sessions, id, 'events.jsonl'))
        .filter((file) => fs.existsSync(file))
        .flatMap((file) => fs.readFileSync(file, 'utf8').split(/\r?\n/).filter((line) => line.includes('"type":"hook.')))
        .join('\n');
}

/** The session's first turn loads the entry skill by the name the mandate gives it, its second says "ok". */
function answer (request, body) {
    if (!isConversation(body) || chatCompletion.hasToolResult(body)) {
        return { body: chatCompletion.say('ok') };
    }

    return { body: chatCompletion.call('skill', { skill: mandatedSkill(chatCompletion.transcript(body)) }) };
}

let standIn;

try {
    standIn = await startStandIn(answer);
    copyCheckout(marketplace);
    pointMcpAt(path.join(marketplace, 'mcp.copilot.json'), standIn.mcpUrl);

    Object.assign(env, {
        HOME: home,
        USERPROFILE: home,
        COPILOT_HOME: path.join(home, '.copilot'),
        COPILOT_OFFLINE: 'true',
        COPILOT_AUTO_UPDATE: 'false',
        COPILOT_PROVIDER_BASE_URL: `${standIn.base}/v1`,
        COPILOT_PROVIDER_API_KEY: 'harness',
        COPILOT_MODEL: 'gpt-4.1'
    });

    run(copilot, ['plugin', 'marketplace', 'add', marketplace], { env, cwd: project });
    run(copilot, ['plugin', 'install', PLUGIN_ID], { env, cwd: project });

    const installed = JSON.parse(run(copilot, ['plugin', 'list', '--json'], { env, cwd: project })).find(({ name }) => name === 'postman');

    assert.ok(installed, 'copilot plugin list --json has no postman plugin after the install');
    assert.equal(installed.marketplace, MARKETPLACE, `postman was not installed from the ${MARKETPLACE} marketplace`);
    assert.equal(installed.enabled, true, 'postman installed disabled');
    assert.equal(installed.version, readJson(path.join(repoRoot, '.github', 'plugin', 'plugin.json')).version, 'copilot read a version other than .github/plugin/plugin.json\'s, so it loaded another route\'s manifest');

    const session = await runAgent(copilot, ['-p', 'Say ok.', '--allow-all-tools', '--output-format', 'json'], { env, cwd: project }),
        turns = standIn.modelRequests.filter(({ body }) => isConversation(body));

    assert.equal(session.code, 0, `copilot exited ${session.code}\n${session.stdout}\n${session.stderr}`);
    assert.equal(turns.length, 2, `copilot ran ${turns.length} turns, not two\n${session.stdout}\n${session.stderr}`);

    const [first, second] = turns.map(({ body }) => chatCompletion.transcript(body)),
        skillList = turns[0].body.tools.find((tool) => tool.function.name === 'skill').function.description + first;

    assertSkillsListed('Copilot CLI', skillList, (skill) => new RegExp(`<name>${skill}</name>`));
    try {
        assertMandate('Copilot CLI', first, { namespaced: false });
    }
    catch (error) {
        error.message += `\nhook events:\n${hookEvents() || 'none'}`;
        throw error;
    }
    assert.ok(second.includes(skillExcerpt(ENTRY_SKILL)), `the mandated skill did not load:\n${second.slice(-800)}`);
    assertMcpHeaders('Copilot CLI', standIn.mcpRequests, headers);

    console.log(`${run(copilot, ['--version'], { env }).split('\n')[0].trim()} loaded ${skills.length} skills, the mandate and the postman MCP server from ${PLUGIN_ID}`);
}
finally {
    standIn?.server.close();
    remove();
}
