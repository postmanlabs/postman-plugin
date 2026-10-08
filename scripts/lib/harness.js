// What the route harnesses share: a throwaway home, this checkout copied as git would ship it, and
// one local server that stands in for both the agent's model and Postman's MCP server.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnCli, spawnCliSync } from './cli.js';

export const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..'),
    ENTRY_SKILL = 'api-engineer',
    readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8')),
    skills = readJson(path.join(repoRoot, 'manifest.json')).skills.map((skill) => skill.name);

/** A temporary root holding `home` and `project`; .native expands a Windows short name (RUNNER~1). */
export function workspace (name) {
    const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), `postman-${name}-harness-`))),
        home = path.join(root, 'home'),
        project = path.join(root, 'project');

    fs.mkdirSync(home, { recursive: true });
    fs.mkdirSync(project, { recursive: true });

    return { root, home, project, remove: () => fs.rmSync(root, { recursive: true, force: true }) };
}

// Some agents find their project from $PWD rather than the working directory they are started in.
const inDirectory = (options) => (options.cwd ? { ...options, env: { ...(options.env ?? process.env), PWD: options.cwd } } : options);

export function run (command, args, options = {}) {
    const result = spawnCliSync(command, args, { encoding: 'utf8', timeout: 180000, maxBuffer: 16 * 1024 * 1024, ...inDirectory(options) });

    assert.equal(result.status, 0, [`${command} ${args.join(' ')} exited ${result.status}`, result.stdout, result.stderr, result.error?.message].filter(Boolean).join('\n'));

    return result.stdout;
}

/** Asynchronous, unlike `run`, so this process can serve the model while the agent waits on it. */
export function runAgent (command, args, options = {}) {
    return new Promise((resolve) => {
        const child = spawnCli(command, args, { stdio: ['ignore', 'pipe', 'pipe'], timeout: 180000, ...inDirectory(options) });
        let stdout = '',
            stderr = '';

        child.stdout.on('data', (data) => { stdout += data; });
        child.stderr.on('data', (data) => { stderr += data; });
        child.on('close', (code, signal) => resolve({ code: signal ? signal : code, stdout, stderr }));
    });
}

/** Every file git would ship from this checkout, copied into `target`. */
export function copyCheckout (target) {
    const files = run('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd: repoRoot }).split('\0').filter(Boolean);

    for (const file of files.filter((entry) => fs.existsSync(path.join(repoRoot, entry)))) {
        fs.mkdirSync(path.dirname(path.join(target, file)), { recursive: true });
        fs.copyFileSync(path.join(repoRoot, file), path.join(target, file));
    }
}

/** `target` as a one-commit repository, for agents that install a local marketplace by commit. */
export function commit (target) {
    run('git', ['init', '--quiet'], { cwd: target });
    run('git', ['add', '--all'], { cwd: target });
    run('git', ['-c', 'user.name=harness', '-c', 'user.email=harness@localhost', '-c', 'commit.gpgsign=false', 'commit', '--quiet', '--message', 'harness'], { cwd: target });
}

/** The first numbered instruction, which only a loaded skill puts in the session. */
export function skillExcerpt (skill, root = repoRoot) {
    const body = fs.readFileSync(path.join(root, 'skills', skill, 'SKILL.md'), 'utf8').split(/^---\r?$/m).slice(2).join('---');

    return body.split(/\r?\n/).find((line) => /^1\.\s+\S/.test(line)).trim();
}

/** The entry skill exactly as the mandate spells it, so a name the agent can't resolve fails later. */
export function mandatedSkill (text) {
    return text.match(/load the `([^`]+)` skill/)?.[1] ?? 'mandate-not-found';
}

/**
 * Requests for the MCP server, and the OAuth discovery after its 401, get Postman's answers before sign-in. Every other request goes to
 * `model(request, body, modelRequests)`, which returns `{ status?, type?, body }`.
 */
export function startStandIn (model) {
    const modelRequests = [],
        mcpRequests = [],
        server = http.createServer((request, response) => {
            let raw = '';

            request.on('data', (data) => { raw += data; });
            request.on('end', () => {
                if (/^\/(mcp|\.well-known\/|register|authorize|token)/.test(request.url)) {
                    mcpRequests.push({ method: request.method, url: request.url, headers: request.headers });
                    response.writeHead(401, { 'content-type': 'application/json' });
                    response.end('{}');

                    return;
                }

                let body = {};

                try {
                    body = JSON.parse(raw || '{}');
                }
                catch {}

                modelRequests.push({ url: request.url, body });

                const answer = model(request, body, modelRequests);

                response.writeHead(answer.status ?? 200, { 'content-type': answer.type ?? 'text/event-stream' });
                response.end(answer.body);
            });
        });

    return new Promise((resolve) => server.listen(0, '127.0.0.1', () => {
        const base = `http://127.0.0.1:${server.address().port}`;

        resolve({ server, modelRequests, mcpRequests, base, mcpUrl: `${base}/mcp` });
    }));
}

const completionChunk = (delta, finish) => `data: ${JSON.stringify({ id: 'harness', object: 'chat.completion.chunk', created: 0, model: 'echo', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;

/** Streamed OpenAI-compatible chat completions: a reply, or one call of `tool` with `args`. */
export const chatCompletion = {
    say: (content) => completionChunk({ role: 'assistant', content }, null) + completionChunk({}, 'stop') + 'data: [DONE]\n\n',
    call: (tool, args) => completionChunk({ role: 'assistant', tool_calls: [{ index: 0, id: 'harness-call', type: 'function', function: { name: tool, arguments: JSON.stringify(args) } }] }, null) +
        completionChunk({}, 'tool_calls') + 'data: [DONE]\n\n',
    text: (message) => (Array.isArray(message.content) ? message.content.map((part) => part.text ?? '').join('') : message.content ?? ''),
    transcript: (body) => (body.messages ?? []).map(chatCompletion.text).join('\n'),
    hasToolResult: (body) => (body.messages ?? []).some((message) => message.role === 'tool')
};

/** Rewrites only the URL of each server in an MCP config, so the headers the agent sends are still the route's. */
export function pointMcpAt (file, url, serversKey = 'mcpServers') {
    const config = readJson(file);

    for (const server of Object.values(config[serversKey])) {
        server.url = url;
    }

    fs.writeFileSync(file, JSON.stringify(config, null, 2));
}

/** Only the JSON-RPC POSTs carry a server's configured headers; the OAuth probes after the 401 don't. */
export function assertMcpHeaders (agent, mcpRequests, headers) {
    const toServer = mcpRequests.filter(({ method, url }) => method === 'POST' && url === '/mcp');

    assert.ok(toServer.length > 0, `${agent} never connected to the Postman MCP server: ${JSON.stringify(mcpRequests.map(({ method, url }) => `${method} ${url}`))}`);

    for (const [name, value] of Object.entries(headers)) {
        assert.ok(toServer.every((request) => request.headers[name.toLowerCase()] === value), `${agent} did not send ${name}: ${value} to the MCP server`);
    }
}

/** `postman:` names for Claude Code and Codex; bare names for every agent that doesn't namespace skills. */
export function assertMandate (agent, text, { namespaced }) {
    assert.match(text, /<EXTREMELY_IMPORTANT>\s*You have the Postman plugin/, `the session-start mandate is not in what ${agent} sent the model`);

    if (namespaced) {
        assert.match(text, /load the `postman:api-engineer` skill/, `${agent} got the mandate without its postman: skill names`);
    }
    else {
        assert.doesNotMatch(text, /`postman:[a-z0-9-]+`/, `the mandate still names skills as \`postman:<skill>\`, which ${agent} cannot resolve`);
    }
}

/** `listing(skill)` matches the agent's own skill-list entry, which the mandate's backticked names never do. */
export function assertSkillsListed (agent, text, listing) {
    for (const skill of skills) {
        assert.ok(listing(skill).test(text), `the skill ${skill} is not in the skill list ${agent} sent the model`);
    }
}
