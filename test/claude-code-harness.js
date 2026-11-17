#!/usr/bin/env node
// Installs this checkout into Claude Code (`CLAUDE_BIN`, else `claude` on PATH) as a local marketplace,
// under a throwaway home, and runs one `claude -p` against a local stand-in for both the Anthropic API
// and Postman's MCP server. It then checks what Claude Code sent each of them. No account is used.
import assert from 'node:assert/strict';
import path from 'node:path';
import {
    ENTRY_SKILL, assertMandate, assertMcpHeaders, assertSkillsListed, copyCheckout, mandatedSkill, pointMcpAt,
    readJson, repoRoot, run, runAgent, skillExcerpt, skills, startStandIn, workspace
} from './lib/harness.js';

const claude = process.env.CLAUDE_BIN || 'claude',
    { root, home, project, remove } = workspace('claude-code'),
    marketplace = path.join(root, 'postman-plugin'),
    PLUGIN_ID = `postman@${readJson(path.join(repoRoot, '.claude-plugin', 'marketplace.json')).name}`,
    { headers } = Object.values(readJson(path.join(repoRoot, 'mcp.claude-code.json')).mcpServers)[0],
    env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^(CLAUDE|ANTHROPIC_)/.test(name)));

const sse = (events) => events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''),
    message = (block, delta, stopReason) => sse([
        { type: 'message_start', message: { id: 'harness', type: 'message', role: 'assistant', model: 'harness', content: [], stop_reason: null, usage: { input_tokens: 1, output_tokens: 0 } } },
        { type: 'content_block_start', index: 0, content_block: block },
        { type: 'content_block_delta', index: 0, delta },
        { type: 'content_block_stop', index: 0 },
        { type: 'message_delta', delta: { stop_reason: stopReason }, usage: { output_tokens: 1 } },
        { type: 'message_stop' }
    ]),
    say = (text) => message({ type: 'text', text: '' }, { type: 'text_delta', text }, 'end_turn'),
    loadSkill = (skill) => message({ type: 'tool_use', id: 'harness-skill', name: 'Skill', input: {} }, { type: 'input_json_delta', partial_json: JSON.stringify({ skill }) }, 'tool_use');

const blockText = (block) => (typeof block === 'string' ? block : block.text ?? (Array.isArray(block.content) ? block.content.map(blockText).join('\n') : block.content ?? '')),
    transcript = (body) => (body.messages ?? []).map((entry) => (Array.isArray(entry.content) ? entry.content.map(blockText).join('\n') : entry.content)).join('\n'),
    isConversation = (body) => body.tools?.some((tool) => tool.name === 'Skill'),
    hasToolResult = (body) => body.messages?.some((entry) => Array.isArray(entry.content) && entry.content.some((block) => block.type === 'tool_result'));

/** The session's first turn loads the entry skill by the name the mandate gives it, its second says "ok". */
function answer (request, body) {
    if (!request.url.startsWith('/v1/messages') || !isConversation(body) || hasToolResult(body)) {
        return { body: say('ok') };
    }

    return { body: loadSkill(mandatedSkill(transcript(body))) };
}

let standIn;

try {
    standIn = await startStandIn(answer);
    copyCheckout(marketplace);
    pointMcpAt(path.join(marketplace, 'mcp.claude-code.json'), standIn.mcpUrl);

    Object.assign(env, { HOME: home, USERPROFILE: home, ANTHROPIC_BASE_URL: standIn.base, ANTHROPIC_API_KEY: 'harness', DISABLE_AUTOUPDATER: '1' });

    run(claude, ['plugin', 'marketplace', 'add', marketplace], { env, cwd: project });
    run(claude, ['plugin', 'install', PLUGIN_ID, '--scope', 'user'], { env, cwd: project });
    assert.ok(readJson(path.join(home, '.claude', 'plugins', 'installed_plugins.json')).plugins[PLUGIN_ID], `${PLUGIN_ID} is not in installed_plugins.json`);

    const session = await runAgent(claude, ['-p', 'Say ok.', '--output-format', 'json'], { env, cwd: project }),
        turns = standIn.modelRequests.filter(({ body }) => isConversation(body));

    assert.equal(session.code, 0, `claude exited ${session.code}\n${session.stdout}\n${session.stderr}`);
    assert.equal(turns.length, 2, `claude ran ${turns.length} turns, not two\n${session.stdout}\n${session.stderr}`);

    const [first, second] = turns.map(({ body }) => transcript(body));

    assertSkillsListed('Claude Code', first, (skill) => new RegExp(`^- postman:${skill}: `, 'm'));
    assertMandate('Claude Code', first, { namespaced: true });
    assert.ok(second.includes(skillExcerpt(ENTRY_SKILL)), `the mandated skill did not load:\n${second.slice(-800)}`);
    assertMcpHeaders('Claude Code', standIn.mcpRequests, headers);

    console.log(`claude ${run(claude, ['--version'], { env }).trim()} loaded ${skills.length} skills, the mandate and the postman MCP server from ${PLUGIN_ID}`);
}
finally {
    standIn?.server.close();
    remove();
}
