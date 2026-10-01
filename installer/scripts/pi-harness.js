#!/usr/bin/env node
// Packs this package, installs the tarball into Pi (`PI_BIN`, else `pi` on PATH) under a throwaway
// home, and sends one prompt to a local stand-in for an OpenAI-compatible endpoint. It then checks
// what Pi sent the model and what the extension registered. No model or account is used.
// With `PI_PACKAGE=npm:@postman/postman-plugin@<version>` it installs that published version instead.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnCli, spawnCliSync } from '../../scripts/lib/cli.js';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'),
    repoRoot = path.dirname(packageRoot),
    pi = process.env.PI_BIN || 'pi',
    published = process.env.PI_PACKAGE,
    // .native expands a Windows short name (RUNNER~1), which Pi reports in full.
    temporary = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'postman-pi-harness-'))),
    home = path.join(temporary, 'home'),
    agentDir = path.join(temporary, 'agent'),
    project = path.join(temporary, 'project'),
    installed = path.join(temporary, 'package'),
    probeFile = path.join(temporary, 'probe.js'),
    probeOutput = path.join(temporary, 'registered-mcp-servers.json'),
    readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8')),
    env = {
        ...process.env,
        HOME: home,
        USERPROFILE: home,
        PI_CODING_AGENT_DIR: agentDir,
        PI_OFFLINE: '1',
        PI_SKIP_VERSION_CHECK: '1'
    };

function run (command, args, options = {}) {
    const result = spawnCliSync(command, args, { encoding: 'utf8', env, timeout: 180000, ...options });

    assert.equal(result.status, 0, [`${command} ${args.join(' ')} exited ${result.status}`, result.stdout, result.stderr, result.error?.message].filter(Boolean).join('\n'));

    return result.stdout;
}

/** Answers every chat completion with a streamed "ok" and keeps the request bodies. */
function startModel () {
    const requests = [],
        chunk = (delta, finish) => `data: ${JSON.stringify({ id: 'harness', object: 'chat.completion.chunk', created: 0, model: 'echo', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`,
        server = http.createServer((request, response) => {
            let body = '';

            request.on('data', (data) => { body += data; });
            request.on('end', () => {
                requests.push(JSON.parse(body || '{}'));
                response.writeHead(200, { 'content-type': 'text/event-stream' });
                response.end(chunk({ role: 'assistant', content: 'ok' }, null) + chunk({}, 'stop') + 'data: [DONE]\n\n');
            });
        });

    return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, requests, port: server.address().port })));
}

// Asynchronous, unlike `run`, so this process can serve the model while pi waits on it.
function runPi (args) {
    return new Promise((resolve) => {
        const child = spawnCli(pi, args, { cwd: project, env, stdio: ['ignore', 'pipe', 'pipe'], timeout: 120000 });
        let stdout = '',
            stderr = '';

        child.stdout.on('data', (data) => { stdout += data; });
        child.stderr.on('data', (data) => { stderr += data; });
        child.on('close', (code, signal) => resolve({ code: signal ? signal : code, stdout, stderr }));
    });
}

/** Where Pi installed `source`: the line under it in `pi list`. */
function installedRoot (source) {
    const lines = run(pi, ['list']).split(/\r?\n/).map((line) => line.trim()),
        at = lines.indexOf(source);

    assert.ok(at >= 0 && lines[at + 1], `pi list does not show ${source}:\n${lines.join('\n')}`);

    return lines[at + 1];
}

/** Packs this checkout and installs the tarball, or installs the published PI_PACKAGE. */
function installPackage () {
    if (published) {
        run(pi, ['install', published]);

        return { root: installedRoot(published), label: published };
    }

    const packed = JSON.parse(run('npm', ['pack', '--json', '--pack-destination', temporary], { cwd: packageRoot }))[0];

    // Relative paths: GNU tar, which Git Bash puts first on Windows, reads `C:` as a remote host.
    run('tar', ['-xzf', packed.filename, '-C', path.basename(installed), '--strip-components=1'], { cwd: temporary });
    run(pi, ['install', installed]);

    return { root: installed, label: packed.filename };
}

function systemPrompt (request) {
    const message = request.messages?.find((entry) => entry.role === 'system' || entry.role === 'developer'),
        content = message?.content;

    return Array.isArray(content) ? content.map((part) => part.text ?? '').join('') : content ?? '';
}

let model;

try {
    for (const dir of [home, agentDir, project, installed]) {
        fs.mkdirSync(dir, { recursive: true });
    }

    const { root, label } = installPackage(),
        { version, pi: manifest } = readJson(path.join(root, 'package.json'));

    assert.ok(manifest, `${label} is not a Pi package: its package.json has no \`pi\` key`);

    const mcpConfig = readJson(path.join(root, 'mcp.pi.json')).mcpServers,
        // A published version is checked against what it shipped; the checkout may have moved on since.
        skills = published ?
            fs.readdirSync(path.join(root, 'skills')).filter((name) => fs.existsSync(path.join(root, 'skills', name, 'SKILL.md'))) :
            readJson(path.join(repoRoot, 'manifest.json')).skills.map((skill) => skill.name);

    assert.ok(skills.length > 0, `${label} ships no skills`);

    for (const [name, { headers }] of Object.entries(mcpConfig)) {
        assert.equal(headers['X-Plugin-Version'], version, `mcp.pi.json (${name}) reports ${headers['X-Plugin-Version']}, but the package is ${version}`);
    }

    model = await startModel();

    fs.writeFileSync(path.join(agentDir, 'models.json'), JSON.stringify({
        providers: {
            harness: { baseUrl: `http://127.0.0.1:${model.port}/v1`, api: 'openai-completions', apiKey: 'harness', models: [{ id: 'echo' }] }
        }
    }));
    // A disabled `postman` entry of the user's own takes precedence, so nothing connects to Postman.
    fs.writeFileSync(path.join(agentDir, 'mcp.json'), JSON.stringify({
        mcpServers: { postman: { url: 'http://127.0.0.1:9/mcp', enabled: false } }
    }));
    fs.writeFileSync(probeFile, `import fs from 'node:fs';
export default function (pi) {
    pi.on('session_start', () => fs.writeFileSync(${JSON.stringify(probeOutput)}, JSON.stringify(pi.getMcpServers())));
}
`);

    const session = await runPi(['--mode', 'json', '--print', '--no-session', '--model', 'harness/echo', '--extension', probeFile, 'Say ok.']);

    assert.equal(session.code, 0, `pi exited ${session.code}\n${session.stdout}\n${session.stderr}`);
    // Pi prints an extension that fails to load here. Skill warnings it shows only in its TUI,
    // so test/pi-package.test.js checks the skills against Pi's rules instead.
    assert.doesNotMatch(session.stderr, /warning|error/i, `pi printed a problem:\n${session.stderr}`);
    assert.ok(model.requests.length > 0, 'pi never called the model');

    const prompt = systemPrompt(model.requests[0]);

    for (const skill of skills) {
        assert.ok(prompt.includes(path.join(root, 'skills', skill, 'SKILL.md')), `the skill ${skill} is not in the system prompt`);
    }

    assert.match(prompt, /<postman>\s*<EXTREMELY_IMPORTANT>/, 'the session-start mandate is not in the system prompt');
    assert.match(prompt, /load the `api-engineer` skill/);
    assert.doesNotMatch(prompt, /`postman:[a-z0-9-]+`/, 'the mandate still names skills as `postman:<skill>`');

    const registered = JSON.parse(fs.readFileSync(probeOutput, 'utf8'));

    assert.deepEqual(registered.map(({ name, config }) => ({ name, config })), Object.entries(mcpConfig).map(([name, config]) => ({ name, config })));
    assert.ok(registered.every((server) => server.extensionPath === path.join(root, 'dist', 'pi-extension.js')));

    console.log(`pi ${run(pi, ['--version']).trim()} loaded ${skills.length} skills, the mandate and the ${Object.keys(mcpConfig).join(', ')} MCP server from ${label}`);
}
finally {
    model?.server.close();
    fs.rmSync(temporary, { recursive: true, force: true });
}
