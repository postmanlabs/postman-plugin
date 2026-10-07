#!/usr/bin/env node
// Installs this checkout into Droid (`DROID_BIN`, else `droid` on PATH) as a marketplace, under a
// throwaway home, and runs one `droid exec` against a local stand-in for both an OpenAI-compatible
// model and Postman's MCP server. It then checks what Droid sent each of them. No account, model or
// Postman endpoint is used.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnCli, spawnCliSync } from './lib/cli.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'),
    droid = process.env.DROID_BIN || 'droid',
    // .native expands a Windows short name (RUNNER~1), which Droid reports in full.
    temporary = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'postman-factory-harness-'))),
    home = path.join(temporary, 'home'),
    project = path.join(temporary, 'project'),
    // Droid names a local marketplace after its directory, as it names a GitHub one after the repo.
    marketplace = path.join(temporary, 'postman-plugin'),
    PLUGIN_ID = 'postman@postman-plugin',
    ENTRY_SKILL = 'api-engineer',
    skills = JSON.parse(fs.readFileSync(path.join(repoRoot, 'manifest.json'), 'utf8')).skills.map((skill) => skill.name),
    [[serverName, mcpServer]] = Object.entries(JSON.parse(fs.readFileSync(path.join(repoRoot, 'mcp.json'), 'utf8')).mcpServers),
    env = { ...process.env, HOME: home, USERPROFILE: home };

delete env.FACTORY_API_KEY;

function run (command, args, options = {}) {
    const result = spawnCliSync(command, args, { encoding: 'utf8', env, cwd: project, timeout: 180000, ...options });

    assert.equal(result.status, 0, [`${command} ${args.join(' ')} exited ${result.status}`, result.stdout, result.stderr, result.error?.message].filter(Boolean).join('\n'));

    return result.stdout;
}

// Asynchronous, unlike `run`, so this process can serve the model while droid waits on it.
function runDroid (args) {
    return new Promise((resolve) => {
        const child = spawnCli(droid, args, { cwd: project, env, stdio: ['ignore', 'pipe', 'pipe'], timeout: 120000 });
        let stdout = '',
            stderr = '';

        child.stdout.on('data', (data) => { stdout += data; });
        child.stderr.on('data', (data) => { stderr += data; });
        child.on('close', (code, signal) => resolve({ code: signal ? signal : code, stdout, stderr }));
    });
}

/**
 * The model's first turn loads the entry skill by the name the mandate gives it, its second says
 * "ok". The MCP endpoint answers 401, which is what Postman's does before `/mcp` sign-in.
 */
function startStandIn () {
    const modelRequests = [],
        mcpRequests = [],
        chunk = (delta, finish) => `data: ${JSON.stringify({ id: 'harness', object: 'chat.completion.chunk', created: 0, model: 'echo', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`,
        loadSkill = (skill) => ({ role: 'assistant', tool_calls: [{ index: 0, id: 'harness-skill', type: 'function', function: { name: 'Skill', arguments: JSON.stringify({ skill }) } }] }),
        server = http.createServer((request, response) => {
            let body = '';

            request.on('data', (data) => { body += data; });
            request.on('end', () => {
                if (!request.url.startsWith('/v1/')) {
                    mcpRequests.push({ method: request.method, url: request.url, headers: request.headers });
                    response.writeHead(401, { 'content-type': 'application/json' });
                    response.end('{}');

                    return;
                }

                modelRequests.push(JSON.parse(body || '{}'));
                response.writeHead(200, { 'content-type': 'text/event-stream' });
                response.end(modelRequests.length === 1 ?
                    chunk(loadSkill(mandatedSkill(modelRequests[0])), null) + chunk({}, 'tool_calls') + 'data: [DONE]\n\n' :
                    chunk({ role: 'assistant', content: 'ok' }, null) + chunk({}, 'stop') + 'data: [DONE]\n\n');
            });
        });

    return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, modelRequests, mcpRequests, port: server.address().port })));
}

function text (message) {
    return Array.isArray(message.content) ? message.content.map((part) => part.text ?? '').join('') : message.content ?? '';
}

function transcript (request) {
    return request.messages.map(text).join('\n');
}

/** The entry skill exactly as the mandate spells it, so a name Droid can't resolve fails below. */
function mandatedSkill (request) {
    return transcript(request).match(/load the `([^`]+)` skill/)?.[1] ?? 'mandate-not-found';
}

/** The checkout as git would ship it, committed, since Droid tracks a local marketplace by commit. */
function copyCheckout (mcpUrl) {
    const files = run('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd: repoRoot }).split('\0').filter(Boolean);

    for (const file of files.filter((entry) => fs.existsSync(path.join(repoRoot, entry)))) {
        fs.mkdirSync(path.dirname(path.join(marketplace, file)), { recursive: true });
        fs.copyFileSync(path.join(repoRoot, file), path.join(marketplace, file));
    }

    // Only the URL moves to the stand-in; the headers Droid sends are checked against mcp.json's.
    fs.writeFileSync(path.join(marketplace, 'mcp.json'), JSON.stringify({ mcpServers: { [serverName]: { ...mcpServer, url: mcpUrl } } }));

    run('git', ['init', '--quiet'], { cwd: marketplace });
    run('git', ['add', '--all'], { cwd: marketplace });
    run('git', ['-c', 'user.name=harness', '-c', 'user.email=harness@localhost', '-c', 'commit.gpgsign=false', 'commit', '--quiet', '--message', 'harness'], { cwd: marketplace });
}

let standIn;

try {
    for (const dir of [home, project, marketplace]) {
        fs.mkdirSync(dir, { recursive: true });
    }

    standIn = await startStandIn();
    copyCheckout(`http://127.0.0.1:${standIn.port}/mcp`);

    assert.match(run(droid, ['plugin', 'marketplace', 'add', marketplace]), /postman-plugin/);
    run(droid, ['plugin', 'install', PLUGIN_ID, '--scope', 'user']);
    assert.match(run(droid, ['plugin', 'list', '--scope', 'user']), new RegExp(`^\\s*${PLUGIN_ID}\\s+\\[user\\]`, 'm'));

    const settingsFile = path.join(home, '.factory', 'settings.json'),
        settings = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));

    settings.customModels = [{ model: 'echo', displayName: 'Harness', baseUrl: `http://127.0.0.1:${standIn.port}/v1`, apiKey: 'harness', provider: 'generic-chat-completion-api' }];
    fs.writeFileSync(settingsFile, JSON.stringify(settings));

    const session = await runDroid(['exec', '--model', 'custom:Harness-0', '--output-format', 'json', 'Say ok.']);

    assert.equal(session.code, 0, `droid exited ${session.code}\n${session.stdout}\n${session.stderr}`);
    assert.equal(standIn.modelRequests.length, 2, `droid called the model ${standIn.modelRequests.length} times, not twice\n${session.stdout}\n${session.stderr}`);

    const [first, second] = standIn.modelRequests.map(transcript);

    for (const skill of skills) {
        assert.match(first, new RegExp(`^${skill}: `, 'm'), `the skill ${skill} is not in the session's skill list`);
    }

    assert.match(first, /<EXTREMELY_IMPORTANT>\s*You have the Postman plugin/, 'the session-start mandate is not in the session');
    assert.doesNotMatch(first, /`postman:[a-z0-9-]+`/, 'the mandate still names skills as `postman:<skill>`, which Droid cannot resolve');
    assert.match(second, new RegExp(`Skill "${ENTRY_SKILL}" is now active`), `the mandated skill did not load:\n${second.slice(-500)}`);

    const installed = path.join(home, '.factory', 'plugins', 'installed_plugins'),
        [record] = fs.readdirSync(installed).map((file) => JSON.parse(fs.readFileSync(path.join(installed, file), 'utf8'))),
        { installPath } = record.entry;

    assert.ok(second.includes(path.join(installPath, 'skills', ENTRY_SKILL, 'SKILL.md')), `${ENTRY_SKILL} did not load from the installed plugin at ${installPath}`);

    // Only the JSON-RPC POSTs carry the server's headers; the OAuth probes after the 401 don't.
    const toServer = standIn.mcpRequests.filter(({ method, url }) => method === 'POST' && url === '/mcp');

    assert.ok(toServer.length > 0, `droid never connected to the ${serverName} MCP server in mcp.json: ${JSON.stringify(standIn.mcpRequests.map(({ url }) => url))}`);

    for (const [name, value] of Object.entries(mcpServer.headers)) {
        assert.ok(toServer.every(({ headers }) => headers[name.toLowerCase()] === value), `droid did not send ${name}: ${value} to the MCP server`);
    }

    console.log(`droid ${run(droid, ['--version']).trim()} loaded ${skills.length} skills, the mandate and the ${serverName} MCP server from ${PLUGIN_ID}`);
}
finally {
    standIn?.server.close();
    fs.rmSync(temporary, { recursive: true, force: true });
}
