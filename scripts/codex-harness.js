#!/usr/bin/env node
// Installs this checkout into Codex (`CODEX_BIN`, else `codex` on PATH) as a local marketplace, under a
// throwaway home, and runs `codex exec` against a local stand-in for both a Responses API model and
// Postman's MCP server: once as a new user has it, with the plugin's hook not yet trusted, and once
// trusted. It then checks what Codex sent each of them. No account is used.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
    ENTRY_SKILL, assertMandate, assertMcpHeaders, assertSkillsListed, copyCheckout, mandatedSkill, pointMcpAt,
    readJson, repoRoot, run, runAgent, skills, startStandIn, workspace
} from './lib/harness.js';

const codex = process.env.CODEX_BIN || 'codex',
    { root, home, project, remove } = workspace('codex'),
    marketplace = path.join(root, 'postman-plugin'),
    codexHome = path.join(home, '.codex'),
    PLUGIN_ID = `postman@${readJson(path.join(repoRoot, '.claude-plugin', 'marketplace.json')).name}`,
    { http_headers: headers } = Object.values(readJson(path.join(repoRoot, 'mcp.codex.json')).mcpServers)[0],
    env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^(CODEX_|OPENAI_)/.test(name)));

const event = (body) => `event: ${body.type}\ndata: ${JSON.stringify(body)}\n\n`,
    usage = { input_tokens: 1, input_tokens_details: null, output_tokens: 1, output_tokens_details: null, total_tokens: 2 },
    say = (id) => event({ type: 'response.created', response: { id } }) +
        event({ type: 'response.output_item.done', item: { type: 'message', role: 'assistant', id: `${id}-message`, content: [{ type: 'output_text', text: 'ok' }] } }) +
        event({ type: 'response.completed', response: { id, usage } });

const inputText = (item) => (Array.isArray(item.content) ? item.content.map((part) => part.text ?? '').join('\n') : ''),
    transcript = (body) => [body.instructions ?? '', ...(body.input ?? []).map(inputText)].join('\n');

/** Codex loads a skill by reading the file its listing names, so the mandated name has to have an entry. */
function listedSkillFile (text, name) {
    const [, short] = text.match(new RegExp(`^- ${name}: .*\\(file: ([^)]+)\\)$`, 'm')) ?? [],
        [, rootName, rest] = short?.match(/^(r\d+)\/(.*)$/) ?? [],
        [, rootPath] = text.match(new RegExp(`^- \`${rootName}\` = \`([^\`]+)\``, 'm')) ?? [];

    return rootPath && path.join(rootPath, rest);
}

async function session (standIn, extra) {
    const before = standIn.modelRequests.length,
        result = await runAgent(codex, ['exec', '--skip-git-repo-check', '--ephemeral', '--json', ...extra, 'Say ok.'], { env, cwd: project }),
        turns = standIn.modelRequests.slice(before).filter(({ url }) => url.startsWith('/v1/responses'));

    assert.equal(result.code, 0, `codex exited ${result.code}\n${result.stdout}\n${result.stderr}`);
    assert.equal(turns.length, 1, `codex called the model ${turns.length} times, not once\n${result.stdout}\n${result.stderr}`);

    return transcript(turns[0].body);
}

let standIn;

try {
    standIn = await startStandIn((request, body, requests) => ({ body: say(`harness-${requests.length}`) }));
    copyCheckout(marketplace);
    pointMcpAt(path.join(marketplace, 'mcp.codex.json'), standIn.mcpUrl);

    fs.mkdirSync(codexHome, { recursive: true });
    fs.writeFileSync(path.join(codexHome, 'config.toml'), [
        'model = "harness"',
        'model_provider = "harness"',
        '[model_providers.harness]',
        'name = "harness"',
        `base_url = "${standIn.base}/v1"`,
        'wire_api = "responses"',
        'env_key = "HARNESS_API_KEY"',
        ''
    ].join('\n'));
    Object.assign(env, { HOME: home, USERPROFILE: home, CODEX_HOME: codexHome, HARNESS_API_KEY: 'harness' });

    run(codex, ['plugin', 'marketplace', 'add', marketplace, '--json'], { env, cwd: project });

    const { installedPath } = JSON.parse(run(codex, ['plugin', 'add', PLUGIN_ID, '--json'], { env, cwd: project }));

    // Codex skips a plugin's hook until the user trusts it, so a new user's session has the skills and no mandate.
    const untrusted = await session(standIn, []);

    assertSkillsListed('Codex', untrusted, (skill) => new RegExp(`^- postman:${skill}: `, 'm'));
    assert.doesNotMatch(untrusted, /<EXTREMELY_IMPORTANT>/, 'Codex ran the plugin hook before the user trusted it; update this harness and CONTRIBUTING.md\'s Codex section');

    const trusted = await session(standIn, ['--dangerously-bypass-hook-trust']);

    assertSkillsListed('Codex', trusted, (skill) => new RegExp(`^- postman:${skill}: `, 'm'));
    assertMandate('Codex', trusted, { namespaced: true });

    const skillFile = listedSkillFile(trusted, mandatedSkill(trusted));

    assert.equal(skillFile && path.resolve(skillFile), path.resolve(installedPath, 'skills', ENTRY_SKILL, 'SKILL.md'), `the mandate names \`${mandatedSkill(trusted)}\`, which Codex lists at ${skillFile}, not as the installed ${ENTRY_SKILL}`);
    assert.ok(fs.existsSync(skillFile), `Codex lists ${skillFile}, which does not exist`);
    assertMcpHeaders('Codex', standIn.mcpRequests, headers);

    console.log(`${run(codex, ['--version'], { env }).trim()} loaded ${skills.length} skills, the mandate once its hook is trusted and the postman MCP server from ${PLUGIN_ID}`);
}
finally {
    standIn?.server.close();
    remove();
}
