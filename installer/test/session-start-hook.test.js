import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

// The hooks/hooks.json command's scripts, run as each agent runs them: the sh script, or on Windows
// its cmd.exe twin, which both Droid and Cursor's PowerShell pick there.
const hooksDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'hooks'),
    windows = process.platform === 'win32',
    mandate = fs.readFileSync(path.join(hooksDir, 'session-start-context.md'), 'utf8'),
    bareNames = (text) => text.replace(/`postman:([a-z0-9-]*)`/g, '`$1`'),
    agentEnv = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^(CLAUDE|CURSOR|COPILOT|DROID)_PLUGIN_ROOT$/i.test(name)));

/** `droidRoot` is Droid's `DROID_PLUGIN_ROOT` hook environment variable: set on Droid, absent everywhere else. */
function runHook (dir, droidRoot, env = {}) {
    const options = { env: { ...agentEnv, ...(droidRoot && { DROID_PLUGIN_ROOT: droidRoot }), ...env }, encoding: 'utf8' },
        result = windows ?
            // `/s` drops the outer quotes, so cmd.exe runs the rest exactly as quoted here.
            spawnSync('cmd.exe', ['/d', '/s', '/c', `""${path.join(dir, 'session-start.cmd')}""`], { ...options, windowsVerbatimArguments: true }) :
            spawnSync(path.join(dir, 'session-start'), [], options);

    assert.equal(result.status, 0, result.stderr || result.error?.message);

    return result.stdout;
}

/** Parsed the way Cursor and Copilot CLI parse a hook's stdout; Cursor drops anything else as `invalid_json`. */
function jsonOutput (stdout) {
    return JSON.parse(stdout.trim());
}

test('Claude Code gets the mandate file byte for byte', () => {
    assert.equal(runHook(hooksDir, ''), mandate);
});

test('Droid gets the mandate with bare skill names', () => {
    assert.equal(runHook(hooksDir, hooksDir), bareNames(mandate));
});

test('Cursor gets JSON whose additional_context is the mandate with bare skill names', () => {
    const output = jsonOutput(runHook(hooksDir, '', { CURSOR_PLUGIN_ROOT: path.dirname(hooksDir) }));

    assert.deepEqual(output, { additional_context: bareNames(mandate) });
    assert.match(output.additional_context, /^<EXTREMELY_IMPORTANT>\s*You have the Postman plugin/);
    assert.match(output.additional_context, /load the `api-engineer` skill/);
});

test('Copilot CLI gets JSON whose additionalContext is the mandate with bare skill names', () => {
    const output = jsonOutput(runHook(hooksDir, '', { COPILOT_PLUGIN_ROOT: path.dirname(hooksDir), CLAUDE_PLUGIN_ROOT: path.dirname(hooksDir) }));

    assert.deepEqual(output, { additionalContext: bareNames(mandate) });
    assert.match(output.additionalContext, /load the `api-engineer` skill/);
});

test('Cursor JSON survives quotes, backslashes, tabs, CRLF and non-ASCII in the mandate', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'postman-plugin-hook-')),
        fixture = 'Say "hi" from C:\\Users\\me\\\tthen `postman:api-engineer` — 100% done.\r\nNext line\r\n\nLast line\n';

    for (const script of ['session-start', 'session-start.cmd']) {
        fs.copyFileSync(path.join(hooksDir, script), path.join(dir, script));
    }
    fs.writeFileSync(path.join(dir, 'session-start-context.md'), fixture);

    assert.deepEqual(jsonOutput(runHook(dir, '', { CURSOR_PLUGIN_ROOT: dir })), { additional_context: bareNames(fixture) });
    assert.deepEqual(jsonOutput(runHook(dir, '', { COPILOT_PLUGIN_ROOT: dir })), { additionalContext: bareNames(fixture) });
});

test('Droid on Windows is recognised by its placeholder root, not the value', () => {
    assert.equal(runHook(hooksDir, '/PLUGIN_ROOT_NOT_EXPANDED_ERROR'), bareNames(mandate));
});

test('hooks.json names no variable but CLAUDE_PLUGIN_ROOT', () => {
    const hooks = JSON.parse(fs.readFileSync(path.join(hooksDir, 'hooks.json'), 'utf8')),
        commands = Object.values(hooks.hooks).flat().flatMap((entry) => entry.hooks.map((hook) => hook.command));

    assert.ok(commands.length > 0);

    for (const command of commands) {
        assert.deepEqual([...command.matchAll(/\$\{(\w+)\}/g)].map((match) => match[1]), ['CLAUDE_PLUGIN_ROOT']);
    }
});
