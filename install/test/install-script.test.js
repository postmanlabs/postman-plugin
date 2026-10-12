import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'install.sh'),
    OFFICIAL = '[{"name":"claude-plugins-official","source":"github","repo":"anthropics/claude-plugins-official"}]',
    CODEX_MARKETPLACES = '{"marketplaces":[{"name":"postman","marketplaceSource":{"sourceType":"git","source":"postmanlabs/postman-plugin"}}]}';

// A throwaway home and a PATH holding only the stubs we name, so a test never reaches a real agent.
function sandbox ({ bins = {}, home = {} } = {}) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'postman-install-')),
        bin = path.join(root, 'bin'),
        homeDir = path.join(root, 'home'),
        log = path.join(root, 'commands.log');

    fs.mkdirSync(bin);
    fs.mkdirSync(homeDir);
    fs.writeFileSync(log, '');

    for (const [name, body] of Object.entries(bins)) {
        fs.writeFileSync(path.join(bin, name), `#!/bin/sh\necho "${name} $*" >> "${log}"\n${body}\n`, { mode: 0o755 });
    }

    for (const [file, content] of Object.entries(home)) {
        fs.mkdirSync(path.dirname(path.join(homeDir, file)), { recursive: true });
        fs.writeFileSync(path.join(homeDir, file), content);
    }

    // Tools the script needs, linked in so the stubs stay the only agents on PATH.
    for (const tool of ['sh', 'grep', 'tr', 'cut', 'sed', 'uname', 'printf', 'cat', 'mkdir']) {
        const found = spawnSync('sh', ['-c', `command -v ${tool}`]).stdout.toString().trim();

        if (found.startsWith('/') && !fs.existsSync(path.join(bin, tool))) {
            fs.symlinkSync(found, path.join(bin, tool));
        }
    }

    return {
        homeDir,
        commands: () => fs.readFileSync(log, 'utf8').split('\n').filter(Boolean),
        run (args = [], env = {}) {
            const exec = spawnSync(path.join(bin, 'sh'), [SCRIPT, ...args], {
                env: { PATH: bin, HOME: homeDir, POSTMAN_PLUGIN_CURSOR_APP: path.join(homeDir, 'no-cursor.app'), ...env },
                encoding: 'utf8'
            });

            return { code: exec.status, stdout: exec.stdout, stderr: exec.stderr };
        },
        cleanup: () => fs.rmSync(root, { recursive: true, force: true })
    };
}

// What `claude` prints for the two list commands; every other command succeeds silently.
const claudeStub = ({ plugins = '[]', marketplaces = OFFICIAL, failOn = '' } = {}) => `
case "$*" in
  "plugin list --json") echo '${plugins}' ;;
  "plugin marketplace list --json") echo '${marketplaces}' ;;
  *"${failOn || 'NEVER_MATCHES'}"*) echo "boom: /Users/someone/secret" >&2; exit 1 ;;
esac`;

const codexStub = ({ plugins = '{"installed":[]}', marketplaces = '{"marketplaces":[]}', failOn = '' } = {}) => `
case "$*" in
  "plugin list --json") echo '${plugins}' ;;
  "plugin marketplace list --json") echo '${marketplaces}' ;;
  *"${failOn || 'NEVER_MATCHES'}"*) echo boom >&2; exit 1 ;;
esac`;

test('exits 3 when no supported agent is on the machine', (t) => {
    const box = sandbox();

    t.after(box.cleanup);
    const out = box.run();

    assert.equal(out.code, 3);
    assert.match(out.stderr, /No supported agent found/);
});

test('rejects an unknown agent and a missing value with exit 2', (t) => {
    const box = sandbox();

    t.after(box.cleanup);
    assert.equal(box.run(['--agent', 'vim']).code, 2);
    assert.equal(box.run(['--agent']).code, 2);
    assert.equal(box.run(['--nope']).code, 2);
});

test('Claude Code: registers Anthropic\'s marketplace, then installs at user scope', (t) => {
    const box = sandbox({ bins: { claude: claudeStub({ marketplaces: '[]' }) } });

    t.after(box.cleanup);
    const out = box.run();

    assert.equal(out.code, 0);
    assert.deepEqual(box.commands(), [
        'claude plugin list --json',
        'claude plugin marketplace list --json',
        'claude plugin marketplace add anthropics/claude-plugins-official --scope user',
        'claude plugin install postman@claude-plugins-official --scope user'
    ]);
    assert.match(out.stdout, /^result claude-code installed$/m);
});

test('Claude Code: an installed plugin is left alone', (t) => {
    const box = sandbox({ bins: { claude: claudeStub({ plugins: '[{"id": "postman@claude-plugins-official", "scope": "user"}]' }) } });

    t.after(box.cleanup);
    const out = box.run();

    assert.equal(out.code, 0);
    assert.deepEqual(box.commands(), ['claude plugin list --json']);
    assert.match(out.stdout, /^result claude-code already-installed$/m);
});

test('Claude Code: our own marketplace\'s copy counts as installed, so it is not doubled', (t) => {
    const box = sandbox({ bins: { claude: claudeStub({ plugins: '[{"id":"postman@postman","scope":"user"}]' }) } });

    t.after(box.cleanup);
    assert.match(box.run().stdout, /^result claude-code already-installed$/m);
    assert.equal(box.commands().length, 1);
});

test('Claude Code: refreshes a registered official marketplace before installing', (t) => {
    const box = sandbox({ bins: { claude: claudeStub() } });

    t.after(box.cleanup);
    box.run();

    assert.deepEqual(box.commands().slice(2), [
        'claude plugin marketplace update claude-plugins-official',
        'claude plugin install postman@claude-plugins-official --scope user'
    ]);
});

test('Claude Code: a marketplace of that name from another source blocks the install', (t) => {
    const box = sandbox({ bins: { claude: claudeStub({ marketplaces: '[{"name":"claude-plugins-official","source":"github","repo":"someone/fork"}]' }) } });

    t.after(box.cleanup);
    const out = box.run();

    assert.equal(out.code, 1);
    assert.match(out.stdout, /^result claude-code failed marketplace-source-mismatch$/m);
    assert.ok(!box.commands().some((line) => line.includes('plugin install')));
});

test('Claude Code: a failed install reports a code, and the agent output stays out of stdout', (t) => {
    const box = sandbox({ bins: { claude: claudeStub({ failOn: 'plugin install' }) } });

    t.after(box.cleanup);
    const out = box.run();

    assert.equal(out.code, 1);
    assert.match(out.stdout, /^result claude-code failed install-failed$/m);
    assert.doesNotMatch(out.stdout, /secret/);
});

test('Codex: adds the marketplace, then the plugin', (t) => {
    const box = sandbox({ bins: { codex: codexStub() } });

    t.after(box.cleanup);
    const out = box.run();

    assert.equal(out.code, 0);
    assert.deepEqual(box.commands(), [
        'codex plugin list --json',
        'codex plugin marketplace list --json',
        'codex plugin marketplace add postmanlabs/postman-plugin --json',
        'codex plugin add postman@postman --json'
    ]);
});

test('Codex: an installed plugin is left alone', (t) => {
    const box = sandbox({ bins: { codex: codexStub({ plugins: '{"installed":[{"pluginId":"postman@postman","installed":true}]}' }) } });

    t.after(box.cleanup);
    assert.match(box.run().stdout, /^result codex already-installed$/m);
    assert.equal(box.commands().length, 1);
});

test('Codex: a registered marketplace is upgraded, and a foreign source blocks', (t) => {
    const ok = sandbox({ bins: { codex: codexStub({ marketplaces: CODEX_MARKETPLACES }) } }),
        foreign = sandbox({ bins: { codex: codexStub({ marketplaces: '{"marketplaces":[{"name":"postman","marketplaceSource":{"source":"/tmp/x"}}]}' }) } });

    t.after(ok.cleanup);
    t.after(foreign.cleanup);
    ok.run();
    assert.ok(ok.commands().includes('codex plugin marketplace upgrade postman --json'));
    assert.match(foreign.run().stdout, /^result codex failed marketplace-source-mismatch$/m);
});

test('Cursor: clones the repo into the local plugins folder', (t) => {
    const box = sandbox({ bins: { git: 'for last; do :; done; mkdir -p "$last/.cursor-plugin"' }, home: { '.cursor/settings.json': '{}' } });

    t.after(box.cleanup);
    const out = box.run(['--agent', 'cursor']);

    assert.equal(out.code, 0);
    assert.deepEqual(box.commands(), [`git clone --depth 1 --branch main https://github.com/postmanlabs/postman-plugin.git ${box.homeDir}/.cursor/plugins/local/postman`]);
    assert.match(out.stdout, /^result cursor installed$/m);
});

test('Cursor: an existing clone or Marketplace copy counts as installed', (t) => {
    const clone = sandbox({ home: { '.cursor/plugins/local/postman/.cursor-plugin/plugin.json': '{}' } }),
        market = sandbox({ home: { '.cursor/plugins/cache/cursor-public/postman/plugin.json': '{}' } });

    t.after(clone.cleanup);
    t.after(market.cleanup);
    assert.match(clone.run(['--agent', 'cursor']).stdout, /^result cursor already-installed$/m);
    assert.match(market.run(['--agent', 'cursor']).stdout, /^result cursor already-installed$/m);
});

test('Cursor: reports a missing git and a folder it will not overwrite', (t) => {
    const noGit = sandbox({ home: { '.cursor/settings.json': '{}' } }),
        occupied = sandbox({ bins: { git: 'exit 0' }, home: { '.cursor/plugins/local/postman/notes.txt': 'mine' } });

    t.after(noGit.cleanup);
    t.after(occupied.cleanup);
    assert.match(noGit.run(['--agent', 'cursor']).stdout, /^result cursor failed git-missing$/m);
    assert.match(occupied.run(['--agent', 'cursor']).stdout, /^result cursor failed target-exists$/m);
    assert.deepEqual(occupied.commands(), []);
});

test('--agent limits the run, and an agent that is not installed is skipped silently', (t) => {
    const box = sandbox({ bins: { claude: claudeStub(), codex: codexStub() } });

    t.after(box.cleanup);
    const out = box.run(['--agent', 'codex']);

    assert.ok(box.commands().every((line) => line.startsWith('codex ')));
    assert.doesNotMatch(out.stdout, /claude-code/);
});

test('one agent failing does not stop the others, and the exit code says so', (t) => {
    const box = sandbox({ bins: { claude: claudeStub({ failOn: 'plugin install' }), codex: codexStub() } });

    t.after(box.cleanup);
    const out = box.run();

    assert.equal(out.code, 1);
    assert.match(out.stdout, /^result claude-code failed install-failed$/m);
    assert.match(out.stdout, /^result codex installed$/m);
});

test('telemetry: posts fixed codes with a sanitized source, and nothing the agent printed', (t) => {
    const capture = 'for last; do :; done; echo "$@" >> "$0.out"',
        box = sandbox({ bins: { claude: claudeStub({ failOn: 'plugin install' }), curl: capture } });

    t.after(box.cleanup);
    box.run([], { POSTMAN_PLUGIN_TELEMETRY_URL: 'https://sentry.test/store', POSTMAN_PLUGIN_INSTALL_SOURCE: 'auto new/download;rm -rf' });
    const sent = box.commands().find((line) => line.startsWith('curl '));

    assert.ok(sent, 'curl was called');
    assert.match(sent, /"agent":"claude-code"/);
    assert.match(sent, /"outcome":"failed"/);
    assert.match(sent, /"reason":"install-failed"/);
    assert.match(sent, /"source":"auto_new_download_rm_-rf"/);
    assert.match(sent, /"level":"error"/);
    assert.doesNotMatch(sent, /secret|\/Users/);
});

test('telemetry: off when no endpoint is set or POSTMAN_PLUGIN_TELEMETRY=0', (t) => {
    const unset = sandbox({ bins: { claude: claudeStub(), curl: 'exit 0' } }),
        off = sandbox({ bins: { claude: claudeStub(), curl: 'exit 0' } });

    t.after(unset.cleanup);
    t.after(off.cleanup);
    unset.run();
    off.run([], { POSTMAN_PLUGIN_TELEMETRY_URL: 'https://sentry.test/store', POSTMAN_PLUGIN_TELEMETRY: '0' });
    assert.ok(!unset.commands().some((line) => line.startsWith('curl ')));
    assert.ok(!off.commands().some((line) => line.startsWith('curl ')));
});
