#!/usr/bin/env node
// Installs this checkout into Codex (`CODEX_BIN`, else `codex` on PATH) as a local marketplace, under a
// throwaway home, and runs `codex exec` against a local stand-in for both a Responses API model and
// Postman's MCP server, with hook trust bypassed so any hook the route declares would run. It then checks
// what Codex sent each of them. No account is used.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
    assertMcpHeaders, assertSkillsListed, copyCheckout, pointMcpAt, readJson, repoRoot, run, runAgent, skills,
    startStandIn, workspace
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
        event({ type: 'response.completed', response: { id, usage } }),
    read = (id, file) => event({ type: 'response.created', response: { id } }) +
        event({ type: 'response.output_item.done', item: { type: 'function_call', id: `${id}-call`, call_id: `${id}-call`, name: 'exec_command', arguments: JSON.stringify({ cmd: `cat "${file}"` }) } }) +
        event({ type: 'response.completed', response: { id, usage } });

const inputText = (item) => (Array.isArray(item.content) ? item.content.map((part) => part.text ?? '').join('\n') : typeof item.output === 'string' ? item.output : JSON.stringify(item.output ?? '')),
    transcript = (body) => [body.instructions ?? '', ...(body.input ?? []).map(inputText)].join('\n'),
    hasCallOutput = (body) => (body.input ?? []).some((item) => item.type === 'function_call_output');

const answer = (request, body, requests) => ({ body: say(`harness-${requests.length}`) });

// The runner isolates the session; Codex's own sandbox needs user namespaces a CI runner may not allow.
async function session (standIn, extra) {
    const before = standIn.modelRequests.length,
        result = await runAgent(codex, ['exec', '--skip-git-repo-check', '--ephemeral', '--sandbox', 'danger-full-access', ...extra, 'Say ok.'], { env, cwd: project }),
        requests = standIn.modelRequests.slice(before).filter(({ url }) => url.startsWith('/v1/responses')),
        turns = requests.map(({ body }) => transcript(body)),
        // What each request carried, item by item, for a failure to show where Codex put the hook's output.
        items = requests.map(({ body }, turn) => (body.input ?? []).map((item) => `turn ${turn + 1} ${item.role ?? item.type}: ${JSON.stringify(inputText(item).slice(0, 120))}`).join('\n')).join('\n');

    assert.equal(result.code, 0, `codex exited ${result.code}\n${result.stdout}\n${result.stderr}`);

    // Without --json, exec reports each hook's run on stderr as `hook: <event> <status>`.
    return { turns, items, output: `${result.stdout}\n${result.stderr}`, hookRuns: result.stderr.split(/\r?\n/).filter((line) => /^hook: /.test(line.replace(/\x1b\[[0-9;]*m/g, ''))) };
}

let standIn;

try {
    standIn = await startStandIn(answer);
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

    run(codex, ['plugin', 'add', PLUGIN_ID, '--json'], { env, cwd: project });

    // `"hooks": {}` stops Codex falling back to the shared hooks/hooks.json, so even trusted no hook runs.
    const { turns, output, hookRuns } = await session(standIn, ['--dangerously-bypass-hook-trust']),
        [first] = turns;

    assert.equal(turns.length, 1, `codex called the model ${turns.length} times, not once\n${output}`);
    assert.deepEqual(hookRuns, [], `the Codex route must declare no hooks, but Codex ran ${hookRuns.join('; ')}`);
    assertSkillsListed('Codex', first, (skill) => new RegExp(`^- postman:${skill}: `, 'm'));
    assert.doesNotMatch(first, /<EXTREMELY_IMPORTANT>/, 'the session-start mandate reached Codex, so a hook ran');
    assertMcpHeaders('Codex', standIn.mcpRequests, headers);

    console.log(`${run(codex, ['--version'], { env }).trim()} loaded ${skills.length} skills, no hook and the postman MCP server from ${PLUGIN_ID}`);
}
finally {
    standIn?.server.close();
    remove();
}
