import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { AGENT_COMMANDS, commandsFor } from '../dist/agent-commands.js';
import { HOSTS } from '../dist/hosts/index.js';
import { fakeSystem } from './fake-system.js';

test('the published constants cover every installer host exactly once', () => {
    assert.deepEqual(AGENT_COMMANDS.map((entry) => entry.id), HOSTS.map((host) => host.id));
    assert.equal(new Set(AGENT_COMMANDS.map((entry) => entry.id)).size, HOSTS.length);
    assert.deepEqual(JSON.parse(fs.readFileSync(new URL('../dist/agent-commands.json', import.meta.url), 'utf8')), AGENT_COMMANDS);
    for (const entry of AGENT_COMMANDS) {
        assert.equal(commandsFor(entry.id), entry.commands);
        if (!entry.native) {
            assert.equal(typeof entry.limitations.install, 'string');
            assert.equal(typeof entry.limitations.remove, 'string');
        }
    }
});

for (const entry of AGENT_COMMANDS.filter((agent) => agent.native)) {
    test(`${entry.id} fresh install uses its shared command arguments`, async () => {
        const system = fakeSystem({
            bins: [entry.executable],
            probes: {
                'agy plugin list --json': '[]',
                'claude plugin list --json': '[]',
                'claude plugin marketplace list --json': '[]',
                'codex plugin list --json': '{"installed":[]}',
                'codex plugin marketplace list --json': '{"marketplaces":[]}',
                'copilot plugin list --json': '[]',
                'copilot plugin marketplace list --json': '[]',
                'droid plugin list --scope user': 'No plugins installed',
                'droid plugin marketplace list': 'No marketplaces registered'
            }
        });
        const outcome = await HOSTS.find((host) => host.id === entry.id).install(system);

        assert.equal(outcome.outcome, 'done');
        assert.ok(system.commands.includes([entry.executable, ...entry.commands.install].join(' ')));
        if (entry.marketplace) {
            assert.ok(system.commands.includes([entry.executable, ...entry.commands.addMarketplace].join(' ')));
        }
    });
}

test('the Kimi harness reads shared command arguments from the manifest', (context) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-harness-command-')),
        tools = path.join(root, 'tools'),
        script = path.join(tools, 'fake-npx.cjs'),
        calls = path.join(root, 'calls.json'),
        repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

    context.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
    fs.mkdirSync(tools);
    fs.writeFileSync(script, [
        '#!/usr/bin/env node',
        "require('node:fs').writeFileSync(process.env.HARNESS_COMMAND_LOG, JSON.stringify(process.argv.slice(2)));",
        'process.exit(42);'
    ].join('\n'), { mode: 0o755 });
    if (process.platform === 'win32') {
        fs.writeFileSync(path.join(tools, 'npx.cmd'), `@echo off\r\n"${process.execPath}" "${script}" %*\r\n`);
    }
    else { fs.symlinkSync(script, path.join(tools, 'npx')); }
    const environment = { ...process.env, HARNESS_COMMAND_LOG: calls, TMPDIR: root, TEMP: root, TMP: root },
        pathKey = Object.keys(environment).find((key) => key.toUpperCase() === 'PATH'),
        existingPath = environment[pathKey];

    for (const key of Object.keys(environment).filter((name) => name.toUpperCase() === 'PATH')) {
        delete environment[key];
    }
    environment.PATH = [tools, existingPath].join(path.delimiter);
    const result = spawnSync(process.execPath, ['scripts/kimi-harness.js'], {
        cwd: repoRoot, env: environment, encoding: 'utf8', timeout: 30000
    });

    assert.ok(fs.existsSync(calls), result.stderr);
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /exited 42/);
    assert.doesNotMatch(result.stderr, /object null is not iterable/);
    const args = JSON.parse(fs.readFileSync(calls, 'utf8')),
        expected = [...commandsFor('kimi').install],
        sourceIndex = expected.indexOf('add') + 1;

    assert.ok(path.isAbsolute(args[sourceIndex]));
    assert.equal(path.basename(args[sourceIndex]), 'postman-plugin');
    expected[sourceIndex] = args[sourceIndex];
    assert.deepEqual(args, expected);
});
