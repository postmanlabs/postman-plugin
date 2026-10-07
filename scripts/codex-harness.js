#!/usr/bin/env node
// Installs this checkout into Codex (`CODEX_BIN`, else `codex` on PATH) as a local marketplace, under a
// throwaway home, and runs `codex exec` against a local stand-in for both a Responses API model and
// Postman's MCP server: once as a new user has it, with the plugin's hook not yet trusted, and once
// trusted. It then checks what Codex sent each of them. No account is used.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {
    ENTRY_SKILL, assertMandate, assertMcpHeaders, assertSkillsListed, copyCheckout, mandatedSkill, pointMcpAt,
    readJson, repoRoot, run, runAgent, skillExcerpt, skills, startStandIn, workspace
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

/** Codex loads a skill by reading the file its listing names, so the mandated name has to have an entry. */
function listedSkillFile (text, name) {
    const [, short] = text.match(new RegExp(`^- ${name}: .*\\(file: ([^)]+)\\)$`, 'm')) ?? [],
        [, rootName, rest] = short?.match(/^(r\d+)\/(.*)$/) ?? [],
        [, rootPath] = text.match(new RegExp(`^- \`${rootName}\` = \`([^\`]+)\``, 'm')) ?? [];

    return rootPath && path.join(rootPath, rest);
}

/** With the mandate in the session, the first turn reads the skill it names from Codex's listing and the second says "ok". */
function answer (request, body, requests) {
    const text = transcript(body),
        id = `harness-${requests.length}`;

    return /<EXTREMELY_IMPORTANT>/.test(text) && !hasCallOutput(body) ?
        { body: read(id, listedSkillFile(text, mandatedSkill(text)) ?? 'mandated-skill-not-listed') } :
        { body: say(id) };
}

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

/**
 * The installed SessionStart hook run the way Codex runs it, for a failure to show: `commandWindows` on
 * Windows, Codex's own `${...}` substitutions, then the session's shell, PowerShell on Windows.
 */
function runHookAsCodex (installedPath) {
    const hooksFile = readJson(path.join(installedPath, '.codex-plugin', 'plugin.json')).hooks ?? 'hooks/hooks.json',
        [{ hooks: [handler] }] = readJson(path.join(installedPath, hooksFile)).hooks.SessionStart,
        variables = { PLUGIN_ROOT: installedPath, CLAUDE_PLUGIN_ROOT: installedPath },
        command = Object.entries(variables).reduce((line, [key, value]) => line.replaceAll(`\${${key}}`, value),
            (process.platform === 'win32' && handler.commandWindows) || handler.command),
        options = { encoding: 'utf8', env: { ...env, ...variables }, timeout: 60000 },
        result = process.platform === 'win32' ?
            spawnSync('pwsh', ['-NoProfile', '-Command', command], options) :
            spawnSync(env.SHELL || '/bin/sh', ['-c', command], options);

    return [`$ ${command}`, `exit ${result.status}`, result.stdout, result.stderr, result.error?.message].filter(Boolean).join('\n');
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

    const { installedPath } = JSON.parse(run(codex, ['plugin', 'add', PLUGIN_ID, '--json'], { env, cwd: project }));

    // Codex skips a plugin's hook until the user trusts it, so a new user's session has the skills and no mandate.
    const { turns: untrustedTurns, output: untrustedOutput } = await session(standIn, []),
        [untrusted] = untrustedTurns;

    assert.equal(untrustedTurns.length, 1, `codex called the model ${untrustedTurns.length} times, not once\n${untrustedOutput}`);

    assertSkillsListed('Codex', untrusted, (skill) => new RegExp(`^- postman:${skill}: `, 'm'));
    assert.doesNotMatch(untrusted, /<EXTREMELY_IMPORTANT>/, 'Codex ran the plugin hook before the user trusted it; update this harness and CONTRIBUTING.md\'s Codex section');

    const { turns: trustedTurns, items: trustedItems, output: trustedOutput, hookRuns } = await session(standIn, ['--dangerously-bypass-hook-trust']),
        [trusted, afterRead] = trustedTurns;

    assertSkillsListed('Codex', trusted, (skill) => new RegExp(`^- postman:${skill}: `, 'm'));
    assert.match(trusted, /<EXTREMELY_IMPORTANT>/, `the session-start mandate is not in what Codex sent the model. Codex reported ${hookRuns.length ? hookRuns.join('; ') : 'no hook run'}. Codex sent:\n${trustedItems}\nThe hook, run as Codex runs it:\n${runHookAsCodex(installedPath)}`);
    assertMandate('Codex', trusted, { namespaced: true });
    assert.equal(trustedTurns.length, 2, `codex called the model ${trustedTurns.length} times, not twice\n${trustedOutput}`);

    const skillFile = listedSkillFile(trusted, mandatedSkill(trusted));

    assert.equal(skillFile && path.resolve(skillFile), path.resolve(installedPath, 'skills', ENTRY_SKILL, 'SKILL.md'), `the mandate names \`${mandatedSkill(trusted)}\`, which Codex lists at ${skillFile}, not as the installed ${ENTRY_SKILL}`);
    assert.ok(afterRead.includes(skillExcerpt(ENTRY_SKILL)), `the mandated skill did not load from ${skillFile}:\n${afterRead.slice(-800)}`);
    assertMcpHeaders('Codex', standIn.mcpRequests, headers);

    console.log(`${run(codex, ['--version'], { env }).trim()} loaded ${skills.length} skills, the mandate once its hook is trusted and the postman MCP server from ${PLUGIN_ID}`);
}
finally {
    standIn?.server.close();
    remove();
}
