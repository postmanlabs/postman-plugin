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
    posixOnly = { skip: process.platform === 'win32' && 'fake CLIs are sh scripts' };

// A stand-in `claude` that logs each call and flips to "installed" once `plugin install` runs.
// PATH holds only the sandbox, so it may use shell builtins and nothing else.
const FAKE_CLAUDE = `#!/bin/sh
echo "$*" >> "$FAKE_LOG"
case "$*" in
  "--version") echo "\${FAKE_VERSION:-2.1.285} (Claude Code)" ;;
  "plugin marketplace list --json") echo '[]' ;;
  "plugin list --json")
    if [ -f "$FAKE_STATE" ]; then echo '[{"id":"postman@claude-plugins-official","scope":"user"}]'; else echo '[]'; fi ;;
  "plugin install "*) : > "$FAKE_STATE" ;;
esac
`;

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
            PATH: bin,
            HOME: home,
            USERPROFILE: home,
            XDG_CONFIG_HOME: path.join(home, '.config'),
            FAKE_LOG: path.join(root, 'calls.log'),
            FAKE_STATE: path.join(root, 'installed')
        },
        addClaude () {
            fs.writeFileSync(path.join(bin, 'claude'), FAKE_CLAUDE, { mode: 0o755 });
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

test('finds nothing on a machine with no agents', posixOnly, () => {
    // Cursor is left out: on macOS it is also detected by /Applications/Cursor.app, outside the sandbox.
    const box = sandbox(),
        status = cliRun(['status', '--agent', 'claude-code,codex,factory,kimi,opencode'], box.env);

    assert.equal(status.status, 0);
    assert.match(status.stdout, /None of the requested agents was found/);
});

test('--dry-run runs only read-only probes', posixOnly, () => {
    const box = sandbox();

    box.addClaude();

    const dry = cliRun(['install', '--dry-run', '--agent', 'claude-code'], box.env);

    assert.equal(dry.status, 0, dry.stdout + dry.stderr);
    assert.match(dry.stdout, /\$ claude plugin marketplace add anthropics\/claude-plugins-official --scope user/);
    assert.deepEqual(box.calls(), ['plugin list --json', '--version', 'plugin marketplace list --json', 'plugin list --json']);
});

test('--yes installs through the real process layer and verifies the result', posixOnly, () => {
    const box = sandbox();

    box.addClaude();

    const install = cliRun(['install', '--yes', '--agent', 'claude-code'], box.env);

    assert.equal(install.status, 0, install.stdout + install.stderr);
    assert.deepEqual(box.calls().filter((call) => !call.endsWith('list --json')), [
        '--version',
        'plugin marketplace add anthropics/claude-plugins-official --scope user',
        'plugin install postman@claude-plugins-official --scope user --json'
    ]);
});

test('refuses to run unattended without --yes', posixOnly, () => {
    const box = sandbox();

    box.addClaude();

    const unattended = cliRun(['install'], box.env);

    assert.equal(unattended.status, 2);
    assert.deepEqual(box.calls(), ['plugin list --json', '--version']);
});

test('an agent below its minimum version is warned about, then installed into anyway', posixOnly, () => {
    const box = sandbox();

    box.addClaude();

    const install = cliRun(['install', '--yes', '--agent', 'claude-code'], { ...box.env, FAKE_VERSION: '2.1.100' });

    assert.equal(install.status, 0, install.stdout + install.stderr);
    assert.match(install.stdout, /warning: Claude Code 2\.1\.100 is older than 2\.1\.268/);
    assert.ok(box.calls().includes('plugin install postman@claude-plugins-official --scope user --json'));
});
