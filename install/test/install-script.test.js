import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
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
    for (const tool of ['sh', 'grep', 'tr', 'cut', 'sed', 'uname', 'printf', 'cat', 'mkdir', 'head', 'date', 'touch', 'sleep', 'mv', 'rm', 'find', 'dirname']) {
        const found = spawnSync('sh', ['-c', `command -v ${tool}`]).stdout.toString().trim();

        if (found.startsWith('/') && !fs.existsSync(path.join(bin, tool))) {
            fs.symlinkSync(found, path.join(bin, tool));
        }
    }

    return {
        root,
        homeDir,
        // The version probe is not a command that changes anything, so it stays out of the recorded list.
        commands: () => fs.readFileSync(log, 'utf8').split('\n').filter((line) => line && !line.endsWith(' --version')),
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
const claudeStub = ({ plugins = '[]', marketplaces = OFFICIAL, failOn = '', message = 'boom: /Users/someone/secret', version = '2.1.296 (Claude Code)' } = {}) => `
case "$*" in
  "--version") echo '${version}' ;;
  "plugin list --json") echo '${plugins}' ;;
  "plugin marketplace list --json") echo '${marketplaces}' ;;
  *"${failOn || 'NEVER_MATCHES'}"*) echo "${message}" >&2; exit 1 ;;
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
    const box = sandbox({ bins: { git: '[ "$1" = --version ] && exit 0; [ "$1" = -C ] && { echo abcdef0123456789; exit 0; }; for last; do :; done; mkdir -p "$last/.cursor-plugin"' }, home: { '.cursor/settings.json': '{}' } });

    t.after(box.cleanup);
    const out = box.run(['--agent', 'cursor']);

    assert.equal(out.code, 0);
    assert.match(box.commands()[0], new RegExp(`^git clone --depth 1 --branch main https://github.com/postmanlabs/postman-plugin.git ${box.homeDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/.cursor/plugins/local/postman.partial.\\d+$`));
    assert.ok(fs.existsSync(path.join(box.homeDir, '.cursor/plugins/local/postman/.cursor-plugin')), 'renamed into place');
    assert.deepEqual(partials(box), []);
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

test('telemetry: goes to the plugin installer project by default, and is off with POSTMAN_PLUGIN_TELEMETRY=0', (t) => {
    const byDefault = sandbox({ bins: { claude: claudeStub(), curl: 'exit 0' } }),
        off = sandbox({ bins: { claude: claudeStub(), curl: 'exit 0' } });

    t.after(byDefault.cleanup);
    t.after(off.cleanup);
    byDefault.run();
    off.run([], { POSTMAN_PLUGIN_TELEMETRY: '0' });
    assert.match(byDefault.commands().find((line) => line.startsWith('curl ')), /https:\/\/o1224273\.ingest\.us\.sentry\.io\/api\/4512245392867328\/store\/\?sentry_key=[0-9a-f]{32}$/);
    assert.ok(!off.commands().some((line) => line.startsWith('curl ')));
});

// What a run left beside the clone: the folders it clones into before renaming.
const partials = (box) => fs.readdirSync(path.join(box.homeDir, '.cursor/plugins/local')).filter((name) => name.startsWith('postman.partial'));

const sentEvents = (box) => box.commands().filter((line) => line.startsWith('curl '));
const TELEMETRY = { POSTMAN_PLUGIN_TELEMETRY_URL: 'https://sentry.test/store' };

test('telemetry: a failure carries a fixed cause, the exit code, the agent version and a run id', (t) => {
    const box = sandbox({ bins: { claude: claudeStub({ failOn: 'plugin install', message: 'getaddrinfo ENOTFOUND github.com /Users/someone/secret' }), curl: 'exit 0' } });

    t.after(box.cleanup);
    box.run(['--agent', 'claude-code'], TELEMETRY);
    const [event] = sentEvents(box);

    assert.match(event, /"cause":"network-dns"/);
    assert.match(event, /"exit_code":"1"/);
    assert.match(event, /"agent_version":"2\.1\.296"/);
    assert.match(event, /"run_id":"\d+-\d+"/);
    assert.match(event, /"arch":"[^"]+"/);
    assert.doesNotMatch(event, /secret|ENOTFOUND|github/);
});

test('telemetry: the cause classifier maps common failures to fixed codes', (t) => {
    const cases = {
        'x509: certificate signed by unknown authority': 'tls',
        'HTTP 407 Proxy Authentication Required': 'proxy',
        'EACCES: permission denied, mkdir': 'permission',
        'ENOSPC: no space left on device': 'disk-full',
        'fatal: could not read Username: terminal prompts disabled': 'auth',
        'error: unknown option --scope': 'cli-unsupported',
        'something nobody has seen': 'unknown'
    };

    for (const [message, cause] of Object.entries(cases)) {
        const box = sandbox({ bins: { claude: claudeStub({ failOn: 'plugin install', message }), curl: 'exit 0' } });

        t.after(box.cleanup);
        box.run(['--agent', 'claude-code'], TELEMETRY);
        assert.match(sentEvents(box)[0], new RegExp(`"cause":"${cause}"`), message);
    }
});

test('telemetry: no supported agent is reported, not silent', (t) => {
    const box = sandbox({ bins: { curl: 'exit 0' } });

    t.after(box.cleanup);
    const out = box.run([], TELEMETRY);

    assert.equal(out.code, 3);
    assert.match(sentEvents(box)[0], /"agent":"none".*"outcome":"skipped".*"reason":"no-agent"/);
});

test('telemetry: a run killed mid-install reports an abort and exits 130', async (t) => {
    const box = sandbox({ bins: { claude: `case "$*" in "plugin list --json") echo '[]' ;; "plugin marketplace list --json") echo '[]' ;; esac\ncase "$*" in *"marketplace add"*) touch "$0.started"; sleep 2 ;; esac`, curl: 'exit 0' } });

    t.after(box.cleanup);
    const child = spawn(path.join(box.root, 'bin', 'sh'), [SCRIPT, '--agent', 'claude-code'], {
        env: { PATH: path.join(box.root, 'bin'), HOME: box.homeDir, ...TELEMETRY }
    });
    const exit = new Promise((resolve) => child.on('exit', (code) => resolve(code)));

    for (let waited = 0; !fs.existsSync(path.join(box.root, 'bin', 'claude.started')) && waited < 5000; waited += 50) {
        await new Promise((resolve) => setTimeout(resolve, 50));
    }
    child.kill('SIGTERM');

    assert.equal(await exit, 130);
    assert.match(sentEvents(box)[0], /"agent":"claude-code".*"outcome":"failed".*"reason":"aborted"/);
});

test('git never prompts for credentials', (t) => {
    const box = sandbox({ bins: { git: '[ "$1" = --version ] && exit 0; [ "$1" = -C ] && exit 0; echo "GTP=$GIT_TERMINAL_PROMPT" >> "$0.env"; for last; do :; done; mkdir -p "$last/.cursor-plugin"' }, home: { '.cursor/settings.json': '{}' } });

    t.after(box.cleanup);
    box.run(['--agent', 'cursor']);
    assert.equal(fs.readFileSync(path.join(box.root, 'bin', 'git.env'), 'utf8').trim(), 'GTP=0');
});

test('Cursor: a failed clone leaves nothing behind, and only an old leftover partial folder is removed', (t) => {
    const failing = sandbox({ bins: { git: '[ "$1" = --version ] && exit 0; for last; do :; done; mkdir -p "$last/half"; echo "fatal: unable to access" >&2; exit 128' }, home: { '.cursor/settings.json': '{}' } }),
        leftover = sandbox({ bins: { git: '[ "$1" = --version ] && exit 0; [ "$1" = -C ] && { echo abcdef0123456789; exit 0; }; for last; do :; done; mkdir -p "$last/.cursor-plugin"' }, home: { '.cursor/plugins/local/postman.partial.111/old.txt': 'x', '.cursor/plugins/local/postman.partial.222/fresh.txt': 'x' } });

    t.after(failing.cleanup);
    t.after(leftover.cleanup);
    assert.match(failing.run(['--agent', 'cursor']).stdout, /^result cursor failed clone-failed$/m);
    assert.deepEqual(partials(failing), []);
    assert.ok(!fs.existsSync(path.join(failing.homeDir, '.cursor/plugins/local/postman')));

    // A run that died hours ago left the first folder. A run that started a moment ago owns the second.
    const hoursAgo = new Date(Date.now() - 3 * 3600 * 1000);

    fs.utimesSync(path.join(leftover.homeDir, '.cursor/plugins/local/postman.partial.111'), hoursAgo, hoursAgo);
    assert.match(leftover.run(['--agent', 'cursor']).stdout, /^result cursor installed$/m);
    assert.deepEqual(partials(leftover), ['postman.partial.222']);
});

test('Cursor: another run finishing first is reported as installed, not nested into a second folder', (t) => {
    const box = sandbox({ bins: { git: '[ "$1" = --version ] && exit 0; [ "$1" = -C ] && exit 0; for last; do :; done; mkdir -p "$last/.cursor-plugin"; mkdir -p "${last%.partial.*}/.cursor-plugin"' }, home: { '.cursor/settings.json': '{}' } });

    t.after(box.cleanup);
    const out = box.run(['--agent', 'cursor']);

    assert.match(out.stdout, /^result cursor already-installed$/m);
    assert.deepEqual(partials(box), []);
    assert.ok(!fs.existsSync(path.join(box.homeDir, '.cursor/plugins/local/postman/postman.partial')));
});

test('Cursor: the macOS git stub does not count without the Command Line Tools, and the commit cloned is reported', (t) => {
    const shim = sandbox({ bins: { git: 'exit 0', 'xcode-select': 'exit 2', uname: 'case "$1" in -s) echo Darwin ;; -r) echo 25.1.0 ;; *) echo arm64 ;; esac', curl: 'exit 0' }, home: { '.cursor/settings.json': '{}' } }),
        real = sandbox({ bins: { git: '[ "$1" = --version ] && exit 0; [ "$1" = -C ] && { echo abcdef0123456789; exit 0; }; for last; do :; done; mkdir -p "$last/.cursor-plugin"', 'xcode-select': 'exit 0', uname: 'case "$1" in -s) echo Darwin ;; -r) echo 25.1.0 ;; *) echo arm64 ;; esac', curl: 'exit 0' }, home: { '.cursor/settings.json': '{}' } });

    t.after(shim.cleanup);
    t.after(real.cleanup);
    const env = (box) => ({ ...TELEMETRY, POSTMAN_PLUGIN_SYSTEM_GIT: path.join(box.root, 'bin', 'git') });

    assert.match(shim.run(['--agent', 'cursor'], env(shim)).stdout, /^result cursor failed git-missing$/m);
    assert.ok(!shim.commands().some((line) => line.startsWith('git clone')), 'the stub is never run');
    assert.match(real.run(['--agent', 'cursor'], env(real)).stdout, /^result cursor installed$/m);
    assert.match(sentEvents(real)[0], /"ref":"abcdef012345"/);
});

test('telemetry: a failing list command says why, and the language is reported without the region', (t) => {
    const box = sandbox({ bins: { claude: `case "$*" in "--version") echo 1.0.0 ;; "plugin list --json") echo "error: unknown command 'plugin'" >&2; exit 1 ;; esac`, curl: 'exit 0' } });

    t.after(box.cleanup);
    const out = box.run(['--agent', 'claude-code'], { ...TELEMETRY, LANG: 'ru_RU.UTF-8' });
    const [event] = sentEvents(box);

    assert.match(out.stdout, /^result claude-code failed list-failed$/m);
    assert.match(event, /"cause":"cli-unsupported"/);
    assert.match(event, /"lang":"ru"/);
    assert.doesNotMatch(event, /RU|UTF/);
});

test('telemetry: the event names its environment, groups by a fingerprint and says why in its message', (t) => {
    const box = sandbox({ bins: { claude: claudeStub({ failOn: 'plugin install', message: 'getaddrinfo ENOTFOUND' }), curl: 'exit 0' } }),
        beta = sandbox({ bins: { claude: claudeStub(), curl: 'exit 0' } });

    t.after(box.cleanup);
    t.after(beta.cleanup);
    box.run(['--agent', 'claude-code'], TELEMETRY);
    beta.run(['--agent', 'claude-code'], { ...TELEMETRY, POSTMAN_PLUGIN_ENVIRONMENT: 'beta;x' });
    const [event] = sentEvents(box);

    assert.match(event, /"environment":"production"/);
    assert.match(event, /"user":\{"ip_address":"0\.0\.0\.0"\}/, 'the sender\'s IP address is not recorded');
    assert.match(event, /"message":"postman-plugin-install claude-code failed install-failed network-dns"/);
    assert.match(event, /"fingerprint":\["postman-plugin-install","claude-code","failed","install-failed","network-dns"\]/);
    assert.match(sentEvents(beta)[0], /"environment":"beta_x"/);
    assert.match(event, /--connect-timeout 3 --max-time 5/);
});

test('telemetry: results are printed before any event is sent', (t) => {
    // The curl stub copies what the script has printed so far, so it sees whether the result lines came first.
    const box = sandbox({ bins: { claude: claudeStub(), curl: 'cat "$PRINTED" > "$0.seen"' } }),
        printed = path.join(box.root, 'printed.txt');

    t.after(box.cleanup);
    spawnSync(path.join(box.root, 'bin', 'sh'), ['-c', `"${path.join(box.root, 'bin', 'sh')}" "${SCRIPT}" --agent claude-code > "${printed}"`], {
        env: { PATH: path.join(box.root, 'bin'), HOME: box.homeDir, PRINTED: printed, ...TELEMETRY }
    });

    assert.match(fs.readFileSync(path.join(box.root, 'bin', 'curl.seen'), 'utf8'), /result claude-code installed/);
});

test('privacy: an event holds no host, user or path text, whatever the machine and the agent print', (t) => {
    const box = sandbox({
        bins: {
            claude: claudeStub({ failOn: 'plugin install', version: 'wrapper alice-laptop 1.2.3 /home/alice/.claude' }),
            uname: 'case "$1" in -r) echo 6.1.0-corp-secret-host-alice ;; -m) echo x86_64 ;; *) echo Linux ;; esac',
            curl: 'exit 0'
        }
    });

    t.after(box.cleanup);
    box.run(['--agent', 'claude-code'], { ...TELEMETRY, USER: 'alice', LOGNAME: 'alice', HOSTNAME: 'alice-laptop' });
    const [event] = sentEvents(box);

    assert.match(event, /"os_version":"6\.1"/);
    assert.match(event, /"agent_version":"1\.2\.3"/);
    assert.doesNotMatch(event, /alice|laptop|secret|corp|\/home|\/Users|wrapper/i);
});

test('privacy: DO_NOT_TRACK turns reporting off, and only a terminal sees the notice', (t) => {
    const off = sandbox({ bins: { claude: claudeStub(), curl: 'exit 0' } }),
        offTrue = sandbox({ bins: { claude: claudeStub(), curl: 'exit 0' } }),
        on = sandbox({ bins: { claude: claudeStub(), curl: 'exit 0' } });

    t.after(off.cleanup);
    t.after(offTrue.cleanup);
    t.after(on.cleanup);
    off.run(['--agent', 'claude-code'], { ...TELEMETRY, DO_NOT_TRACK: '1' });
    offTrue.run(['--agent', 'claude-code'], { ...TELEMETRY, DO_NOT_TRACK: 'true' });
    const out = on.run(['--agent', 'claude-code'], { ...TELEMETRY, DO_NOT_TRACK: '0' });

    assert.equal(sentEvents(off).length, 0);
    assert.equal(sentEvents(offTrue).length, 0);
    assert.equal(sentEvents(on).length, 1);
    assert.doesNotMatch(out.stderr, /reports whether it worked/, 'no notice when stderr is not a terminal');
});
