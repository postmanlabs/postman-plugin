import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'),
    cli = path.join(packageRoot, 'dist', 'cli.js'),
    { version } = JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8')),
    windows = process.platform === 'win32';

// A stand-in `claude` that logs each call and flips to "installed" once `plugin install` runs.
const FAKE_CLAUDE = `const fs = require('node:fs');
const call = process.argv.slice(2).join(' ');

fs.appendFileSync(process.env.FAKE_LOG, call + '\\n');

if (call === 'plugin marketplace list --json') {
    console.log('[]');
}
else if (call === 'plugin list --json') {
    console.log(fs.existsSync(process.env.FAKE_STATE) ? '[{"id":"postman@claude-plugins-official","scope":"user"}]' : '[]');
}
else if (call.startsWith('plugin install ')) {
    fs.writeFileSync(process.env.FAKE_STATE, '');
}
`;

// Launched the way npm installs a CLI: a `.cmd` shim on Windows, so the run goes through cmd.exe.
function writeLauncher (bin, name) {
    if (windows) {
        fs.writeFileSync(path.join(bin, `${name}.cmd`), `@"${process.execPath}" "%~dp0${name}.cjs" %*\r\n`);
    }
    else {
        fs.writeFileSync(path.join(bin, name), `#!/bin/sh\nexec "${process.execPath}" "${path.join(bin, `${name}.cjs`)}" "$@"\n`, { mode: 0o755 });
    }
}

function sandbox () {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'postman-plugin-cli-')),
        bin = path.join(root, 'bin'),
        home = path.join(root, 'home');

    fs.mkdirSync(bin);
    fs.mkdirSync(home);

    return {
        root,
        bin,
        env: {
            // Node starts a `.cmd` through ComSpec, and Windows processes need SystemRoot.
            ...(windows && { ComSpec: process.env.ComSpec, SystemRoot: process.env.SystemRoot }),
            PATH: bin,
            HOME: home,
            USERPROFILE: home,
            XDG_CONFIG_HOME: path.join(home, '.config'),
            FAKE_LOG: path.join(root, 'calls.log'),
            FAKE_STATE: path.join(root, 'installed')
        },
        addClaude () {
            fs.writeFileSync(path.join(bin, 'claude.cjs'), FAKE_CLAUDE);
            writeLauncher(bin, 'claude');
        },
        calls () {
            return fs.existsSync(this.env.FAKE_LOG) ? fs.readFileSync(this.env.FAKE_LOG, 'utf8').trim().split('\n') : [];
        }
    };
}

function cliRun (args, env) {
    return spawnSync(process.execPath, [cli, ...args], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

test('--help and --version', () => {
    const help = cliRun(['--help'], process.env),
        shown = cliRun(['-v'], process.env);

    assert.equal(help.status, 0);
    assert.match(help.stdout, /Usage: npx @postman\/postman-plugin/);
    assert.equal(shown.stdout.trim(), version);
});

test('rejects unknown commands, flags and agents with exit 2', () => {
    assert.equal(cliRun(['upgrade'], process.env).status, 2);
    assert.equal(cliRun(['--force'], process.env).status, 2);

    const unknown = cliRun(['--agent', 'claude-code,vscode'], process.env);

    assert.equal(unknown.status, 2);
    assert.match(unknown.stderr, /Unknown agent: vscode/);
});

test('an --agent that names no agent is rejected, not read as "every agent"', () => {
    for (const args of [['remove', '--agent', ''], ['remove', '--agent', ','], ['remove', '--agent=', '--yes']]) {
        const empty = cliRun(args, process.env);

        assert.equal(empty.status, 2, args.join(' '));
        assert.match(empty.stderr, /--agent was given no agent id/);
    }
});

test('finds nothing on a machine with no agents', () => {
    // Cursor is left out: on macOS it is also detected by /Applications/Cursor.app, outside the sandbox.
    const box = sandbox(),
        status = cliRun(['status', '--agent', 'claude-code,codex,factory,kimi,opencode'], box.env);

    assert.equal(status.status, 0);
    assert.match(status.stdout, /None of the requested agents was found/);
});

test('--dry-run runs only read-only probes', () => {
    const box = sandbox();

    box.addClaude();

    const dry = cliRun(['install', '--dry-run', '--agent', 'claude-code'], box.env);

    assert.equal(dry.status, 0, dry.stdout + dry.stderr);
    assert.match(dry.stdout, /\$ claude plugin marketplace add anthropics\/claude-plugins-official --scope user/);
    assert.deepEqual(box.calls(), ['plugin list --json', 'plugin marketplace list --json', 'plugin list --json']);
});

test('--yes installs through the real process layer and verifies the result', () => {
    const box = sandbox();

    box.addClaude();

    const install = cliRun(['install', '--yes', '--agent', 'claude-code'], box.env);

    assert.equal(install.status, 0, install.stdout + install.stderr);
    assert.deepEqual(box.calls().filter((call) => !call.endsWith('list --json')), [
        'plugin marketplace add anthropics/claude-plugins-official --scope user',
        'plugin install postman@claude-plugins-official --scope user --json'
    ]);
});

test('refuses to run unattended without --yes', () => {
    const box = sandbox();

    box.addClaude();

    const unattended = cliRun(['install'], box.env);

    assert.equal(unattended.status, 2);
    assert.deepEqual(box.calls(), ['plugin list --json']);
});
