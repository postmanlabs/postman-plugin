import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { codex, registeredRef } from '../dist/hosts/codex.js';
import { fakeSystem } from './fake-system.js';
import { POSTMAN_HOOK_KEY } from '../dist/hosts/codex-hooks.js';
import { run } from '../dist/run.js';
import { createSystem } from '../dist/system.js';
import { checkCodexTui } from '../scripts/codex-tui-check.js';
import { codexEnvironment, writeTestConfig } from '../scripts/codex-hook-check.js';
import { JsonRpcError } from '../dist/json-rpc.js';

const MARKETPLACES = 'codex plugin marketplace list --json',
    REACH = 'git ls-remote --exit-code https://github.com/postmanlabs/postman-plugin.git refs/heads/main',
    PLUGINS = 'codex plugin list --json',
    ours = { name: 'postman', marketplaceSource: { sourceType: 'git', source: 'https://github.com/postmanlabs/postman-plugin.git' } },
    APP_SERVER = 'codex app-server',
    INITIALIZED = { result: { userAgent: 'codex' } },
    installed = (pluginId) => ({ pluginId, installed: true, version: '1.0.0' }),
    // What `config/read` answers for the marketplace `codex plugin marketplace add` registered, with `ref` null without `--ref`.
    readReplies = (ref) => [INITIALIZED, { result: { config: { marketplaces: { postman: { source_type: 'git', source: 'https://github.com/postmanlabs/postman-plugin.git', ref } } } } }];

function codexSystem ({ marketplaces = [ours], plugins = [], ref = 'main' } = {}) {
    return fakeSystem({
        bins: ['codex'],
        rpcs: { [APP_SERVER]: readReplies(ref) },
        probes: {
            [MARKETPLACES]: JSON.stringify({ marketplaces }),
            [PLUGINS]: JSON.stringify({ installed: plugins, available: [] }),
            [REACH]: 'abc123\trefs/heads/main\n'
        }
    });
}

test('detects Codex by its CLI on PATH', async () => {
    assert.equal(await codex.detect(codexSystem()), true);
    assert.equal(await codex.detect(fakeSystem()), false);
});

test('fresh install adds this repo at main as the postman marketplace, records its revision, then adds the plugin', async () => {
    const system = codexSystem({ marketplaces: [] });

    assert.deepEqual(system.files, {});
    assert.equal(system.dirs.size, 0);

    const outcome = await codex.install(system);

    assert.equal(outcome.message, 'installed postman@postman');
    assert.deepEqual(system.commands, [
        'codex plugin marketplace add postmanlabs/postman-plugin --ref main --json',
        'codex plugin marketplace upgrade postman --json',
        'codex plugin add postman@postman --json'
    ]);
});

test('migrates a marketplace that tracks codex-release to main, and still reports an update', async () => {
    const system = codexSystem({ plugins: [installed('postman@postman')], ref: 'codex-release' }),
        status = await codex.status(system),
        outcome = await codex.install(system);

    assert.match(status.notes.join('\n'), /tracks codex-release and will be re-added at main/);
    assert.equal(outcome.message, 'updated postman@postman');
    assert.deepEqual(system.commands, [
        'codex plugin marketplace remove postman --json',
        'codex plugin marketplace add postmanlabs/postman-plugin --ref main --json',
        'codex plugin marketplace upgrade postman --json',
        'codex plugin add postman@postman --json'
    ]);
});

const LEGACY = { plugins: [installed('postman@postman')], ref: 'codex-release' },
    RESTORE = [
        'codex plugin marketplace remove postman --json',
        'codex plugin marketplace add postmanlabs/postman-plugin --ref codex-release --json',
        'codex plugin add postman@postman --json'
    ];

test('leaves a legacy marketplace alone when main is out of reach', async () => {
    const system = codexSystem(LEGACY);

    system.probes[REACH] = { code: 128, stderr: 'unable to access' };

    const outcome = await codex.install(system);

    assert.equal(outcome.outcome, 'failed');
    assert.match(outcome.message, /can't reach main in postmanlabs\/postman-plugin, so marketplace postman was left tracking codex-release/);
    assert.deepEqual(system.commands, []);
});

test('a migration that fails after the remove restores the marketplace tracking codex-release and the plugin', async () => {
    for (const failing of ['codex plugin marketplace add postmanlabs/postman-plugin --ref main --json', 'codex plugin marketplace upgrade postman --json']) {
        const system = codexSystem(LEGACY);

        system.runs[failing] = { code: 1, stderr: 'network down' };

        const outcome = await codex.install(system);

        assert.equal(outcome.outcome, 'failed');
        assert.match(outcome.message, /network down\nrestored marketplace postman tracking codex-release and postman@postman$/);
        assert.deepEqual(system.commands.slice(system.commands.indexOf(failing) + 1), RESTORE, failing);
    }
});

test('a migration whose plugin add fails restores the plugin from the marketplace tracking codex-release', async () => {
    const system = codexSystem(LEGACY);
    let adds = 0;

    system.runs['codex plugin add postman@postman --json'] = () => (++adds === 1 ? { code: 1, stderr: 'network down' } : '');

    const outcome = await codex.install(system);

    assert.equal(outcome.outcome, 'failed');
    assert.match(outcome.message, /restored marketplace postman tracking codex-release and postman@postman$/);
    assert.deepEqual(system.commands.slice(-3), RESTORE);
});

test('a migration that cannot restore either says how to finish it by hand', async () => {
    const system = codexSystem(LEGACY);

    system.runs['codex plugin marketplace upgrade postman --json'] = { code: 1, stderr: 'network down' };
    system.runs['codex plugin marketplace add postmanlabs/postman-plugin --ref codex-release --json'] = { code: 1, stderr: 'network down' };

    const outcome = await codex.install(system);

    assert.equal(outcome.outcome, 'failed');
    assert.match(outcome.message, /could not restore it either; run `codex plugin marketplace remove postman`, `codex plugin marketplace add postmanlabs\/postman-plugin --ref main`, `codex plugin marketplace upgrade postman` and `codex plugin add postman@postman`/);
});

test('a restore that re-adds the marketplace but not the plugin says to remove that marketplace first', async () => {
    const system = codexSystem(LEGACY);

    system.runs['codex plugin marketplace upgrade postman --json'] = { code: 1, stderr: 'network down' };
    system.runs['codex plugin add postman@postman --json'] = { code: 1, stderr: 'network down' };

    const outcome = await codex.install(system);

    assert.equal(outcome.outcome, 'failed');
    assert.ok(system.commands.includes('codex plugin marketplace add postmanlabs/postman-plugin --ref codex-release --json'), 'the restore re-added the legacy marketplace');
    assert.match(outcome.message, /could not restore it either; run `codex plugin marketplace remove postman`, `codex plugin marketplace add postmanlabs\/postman-plugin --ref main`/);
});

test('refuses a marketplace pinned to another ref, leaving it as it is', async () => {
    const system = codexSystem({ ref: 'my-branch' }),
        outcome = await codex.install(system);

    assert.equal(outcome.outcome, 'blocked');
    assert.match(outcome.message, /tracks my-branch, not main; run `codex plugin marketplace remove postman`/);
    assert.deepEqual(system.commands, []);
});

test('an unavailable config/read API preserves the registration and never fails an update', async () => {
    for (const replies of [
        null,
        [INITIALIZED, { error: { code: -32601, message: 'method not found' } }],
        [INITIALIZED, { result: { config: {} } }],
        [INITIALIZED, { result: { config: { marketplaces: { other: { ref: null } } } } }],
        [INITIALIZED, { result: { config: { marketplaces: { postman: { ref: 7 } } } } }]
    ]) {
        const system = codexSystem();

        system.rpcs[APP_SERVER] = replies;

        const outcome = await codex.install(system);

        assert.equal(outcome.outcome, 'done', JSON.stringify(replies));
        assert.match(system.lines.join('\n'), /keeping its registration and skipping ref migration/);
        assert.deepEqual(system.commands, [
            'codex plugin marketplace upgrade postman --json',
            'codex plugin add postman@postman --json'
        ]);
    }
});

test('asks Codex for the ref with config/read over its app server', async () => {
    const system = codexSystem();
    let sent;

    system.rpcs[APP_SERVER] = (fake, calls) => {
        sent = calls;

        return readReplies('main');
    };

    assert.equal((await codex.install(system)).outcome, 'done');
    assert.deepEqual(sent.map(({ method, notify }) => (notify ? `${method} (notification)` : method)), ['initialize', 'initialized (notification)', 'config/read']);
});

test('registeredRef reports a string ref, null for none, and undefined for anything else', async () => {
    const ref = (replies) => registeredRef(fakeSystem({ rpcs: { [APP_SERVER]: replies } }));

    assert.equal(await ref(readReplies('main')), 'main');
    assert.equal(await ref(readReplies('codex-release')), 'codex-release');
    assert.equal(await ref(readReplies(null)), null);
    assert.equal(await ref([INITIALIZED, { result: { config: { marketplaces: { postman: {} } } } }]), null);
    assert.equal(await ref(null), undefined);
    assert.equal(await ref([INITIALIZED, { result: { config: { marketplaces: { postman: { ref: ['a'] } } } } }]), undefined);
});

test('re-run upgrades the marketplace and re-adds, which is how Codex updates', async () => {
    const system = codexSystem({ plugins: [installed('postman@postman')] }),
        outcome = await codex.install(system);

    assert.equal(outcome.message, 'updated postman@postman');
    assert.deepEqual(system.commands, [
        'codex plugin marketplace upgrade postman --json',
        'codex plugin add postman@postman --json'
    ]);
});

test('an existing unpinned marketplace keeps tracking main without re-registration', async () => {
    const system = codexSystem({ plugins: [installed('postman@postman')], ref: null });

    assert.deepEqual((await codex.status(system)).notes, []);
    assert.equal((await codex.install(system)).message, 'updated postman@postman');
    assert.deepEqual(system.commands, [
        'codex plugin marketplace upgrade postman --json',
        'codex plugin add postman@postman --json'
    ]);
});

test('adds ours, then removes the copy `npx plugins add` leaves', async () => {
    const system = codexSystem({ plugins: [installed('postman@plugins-cli')] }),
        status = await codex.status(system);

    await codex.install(system);

    assert.deepEqual(status.notes, ['postman@plugins-cli duplicates it and will be removed']);
    assert.deepEqual(system.commands, [
        'codex plugin marketplace upgrade postman --json',
        'codex plugin add postman@postman --json',
        'codex plugin remove postman@plugins-cli --json'
    ]);
});

test('a failed add leaves the npx plugins copy in place, so Postman still works', async () => {
    const system = codexSystem({ plugins: [installed('postman@plugins-cli')] });

    system.runs['codex plugin add postman@postman --json'] = { code: 1, stderr: 'network down' };

    assert.equal((await codex.install(system)).outcome, 'failed');
    assert.ok(!system.commands.some((command) => command.includes('remove')));
});

test('accepts the marketplace source in owner/repo form', async () => {
    const system = codexSystem({ marketplaces: [{ name: 'postman', marketplaceSource: { sourceType: 'git', source: 'postmanlabs/postman-plugin' } }] });

    assert.equal((await codex.install(system)).outcome, 'done');
});

test('refuses a postman marketplace that points somewhere else', async () => {
    const system = codexSystem({ marketplaces: [{ name: 'postman', marketplaceSource: { sourceType: 'local', source: '/src/postman-plugin' } }] }),
        outcome = await codex.install(system);

    assert.equal(outcome.outcome, 'blocked');
    assert.match(outcome.message, /\/src\/postman-plugin/);
    assert.deepEqual(system.commands, []);
});

test('refuses a local marketplace even when its path reads like this repo', async () => {
    const system = codexSystem({ marketplaces: [{ name: 'postman', marketplaceSource: { sourceType: 'local', source: 'postmanlabs/postman-plugin' } }] }),
        outcome = await codex.install(system);

    assert.equal(outcome.outcome, 'blocked');
    assert.match(outcome.message, /local source postmanlabs\/postman-plugin/);
    assert.deepEqual(system.commands, []);
});

// Makes the fake `codex plugin remove <id>` drop that ID from the listing, as the real CLI does.
function removes (system, ids) {
    for (const id of ids) {
        system.runs[`codex plugin remove ${id} --json`] = (fake) => {
            const listing = JSON.parse(fake.probes[PLUGINS]);

            fake.probes[PLUGINS] = JSON.stringify({ ...listing, installed: listing.installed.filter((entry) => entry.pluginId !== id) });

            return '';
        };
    }

    return system;
}

test('remove removes ours and the npx plugins copy; the marketplace stays', async () => {
    const system = removes(codexSystem({ plugins: [installed('postman@postman'), installed('postman@plugins-cli')] }),
        ['postman@postman', 'postman@plugins-cli']);

    assert.equal((await codex.remove(system)).outcome, 'done');
    assert.deepEqual(system.commands, [
        'codex plugin remove postman@postman --json',
        'codex plugin remove postman@plugins-cli --json'
    ]);
});

test('remove fails when a remove exits 0 but leaves the duplicate installed', async () => {
    const system = removes(codexSystem({ plugins: [installed('postman@postman'), installed('postman@plugins-cli')] }), ['postman@postman']),
        outcome = await codex.remove(system);

    assert.equal(outcome.outcome, 'failed');
    assert.match(outcome.message, /postman@plugins-cli is still installed/);
});

test('remove skips when nothing is installed', async () => {
    const system = codexSystem();

    assert.equal((await codex.remove(system)).outcome, 'skipped');
    assert.deepEqual(system.commands, []);
});

function hookSystem ({ status = 'untrusted', hash = 'declaration/content', ...options } = {}) {
    const system = codexSystem(),
        hook = { key: POSTMAN_HOOK_KEY, trustStatus: status, currentHash: hash, sourcePath: path.resolve('/plugin/hooks/codex-hooks.json'), command: '/plugin/hooks/session-start' };

    Object.assign(system, options);
    system.files[path.resolve('/plugin/hooks/session-start-context.md')] = 'The installed Postman mandate.';
    Object.assign(system.rpcs, {
        initialize: {},
        'hooks/list': () => ({ data: [{ hooks: [hook, { key: 'other:hook', trustStatus: 'untrusted' }] }] }),
        'config/batchWrite': () => { hook.trustStatus = 'trusted'; return {}; }
    });

    return { system, hook };
}

test('automatically approves only Postman, using the full hash on both protocol versions', async () => {
    for (const hash of ['declaration', 'declaration/content']) {
        const { system, hook } = hookSystem({ status: hash.includes('/') ? 'modified' : 'untrusted', hash });

        assert.equal((await codex.install(system)).outcome, 'done');
        assert.equal(hook.trustStatus, 'trusted');
        assert.doesNotMatch(system.lines.join('\n'), /Approve Postman's|The installed Postman mandate|hooks[\\/]session-start/);
        assert.deepEqual(system.rpcCalls.map(({ method }) => method), ['initialize', 'initialized', 'hooks/list', 'hooks/list', 'config/batchWrite', 'hooks/list']);
        assert.deepEqual(system.rpcCalls.find(({ method }) => method === 'config/batchWrite').params, {
            edits: [{ keyPath: 'hooks.state', value: { [POSTMAN_HOOK_KEY]: { trusted_hash: hash } }, mergeStrategy: 'upsert' }],
            reloadUserConfig: true
        });
    }
});

test('unattended installs approve the hook without any extra flag or prompt', async () => {
    const { system, hook } = hookSystem();

    system.runs['codex plugin add postman@postman --json'] = (fake) => {
        fake.probes[PLUGINS] = JSON.stringify({ installed: [installed('postman@postman')] });

        return '';
    };
    assert.equal(await run(system, [codex], {
        command: 'install', agents: ['codex'], yes: true, isTTY: false,
        confirm: async () => { throw new Error('must not ask'); }
    }), 0);
    assert.equal(hook.trustStatus, 'trusted');
});

test('trusted reruns write nothing', async () => {
    const { system } = hookSystem();

    await codex.install(system);
    system.rpcCalls.length = 0;
    await codex.install(system);
    assert.deepEqual(system.rpcCalls.map(({ method }) => method), ['initialize', 'initialized', 'hooks/list']);
    assert.match(system.lines.join('\n'), /already trusted/);
});

test('missing APIs, failed writes and malformed hook listings never fail the install', async () => {
    for (const [method, reply] of [
        ['initialize', new Error('app-server missing')],
        ['hooks/list', new Error('Method not found')],
        ['hooks/list', {}],
        ['hooks/list', { data: [{ hooks: [], errors: ['cannot load hooks'] }] }],
        ['hooks/list', { data: [{ hooks: [] }] }],
        ['config/batchWrite', new Error('write denied')]
    ]) {
        const { system } = hookSystem();

        system.rpcs[method] = reply;
        assert.equal((await codex.install(system)).outcome, 'done');
        assert.match(system.lines.join('\n'), /approval (skipped|could not be confirmed)/);
    }
});

test('a different hook, unknown status, missing hash or unreadable mandate never gets approved', async () => {
    for (const patch of [{ key: 'postman@evil:hooks/codex-hooks.json:session_start:0:0' }, { trustStatus: 'future-status' }, { currentHash: '' }, { sourcePath: '/missing/hooks.json' }]) {
        const { system, hook } = hookSystem();

        Object.assign(hook, patch);
        await codex.install(system);
        assert.ok(!system.rpcCalls.some(({ method }) => method === 'config/batchWrite'));
    }
});

test('a hash that changes while being checked is not approved', async () => {
    const { system, hook } = hookSystem(),
        list = system.rpcs['hooks/list'];
    let reads = 0;

    system.rpcs['hooks/list'] = () => {
        if (++reads === 2) {
            hook.currentHash = 'new-content';
        }

        return list();
    };
    await codex.install(system);
    assert.ok(!system.rpcCalls.some(({ method }) => method === 'config/batchWrite'));
    assert.match(system.lines.join('\n'), /changed while checking/);
});

test('a dry run prints the automatic config write without starting app-server', async () => {
    const { system } = hookSystem({ dryRun: true });

    await codex.install(system);
    assert.deepEqual(system.rpcSessions, []);
    assert.match(system.lines.join('\n'), /config\/batchWrite .*trusted_hash/);
});

test('dry-run ref detection starts no app-server, even for an installed marketplace', async () => {
    const { system } = hookSystem({ dryRun: true });

    system.probes[PLUGINS] = JSON.stringify({ installed: [installed('postman@postman')] });
    system.rpc = async () => { throw new Error('must not start a read-only app-server either'); };
    // status delegates the dry-run guard to System.rpc, while install must defer
    // choosing a marketplace migration until the real config/read is available.
    assert.equal((await codex.install(system)).outcome, 'done');
    assert.deepEqual(system.rpcSessions, []);
    assert.match(system.lines.join('\n'), /App-server is deferred/);
    assert.equal(await createSystem({ dryRun: true, log: () => {} }).rpc('/nonexistent/codex', [], []), null);
});

test('isolated Codex smoke retains Windows Path and strips profile and credential overrides case-insensitively', () => {
    assert.deepEqual(codexEnvironment({
        Path: 'C:\\node;C:\\git', PathExt: '.EXE;.CMD', UserProfile: 'C:\\users\\runner',
        codex_home: 'old-profile', OPENAI_API_KEY: 'test-value', Codex_Bin: 'other-codex'
    }, 'win32'), { PATH: 'C:\\node;C:\\git', PATHEXT: '.EXE;.CMD', USERPROFILE: 'C:\\users\\runner' });
    assert.deepEqual(codexEnvironment({ PATH: '/bin', Path: 'separate-posix-key', CODEX_HOME: '/old-profile' }, 'linux'), {
        PATH: '/bin', Path: 'separate-posix-key'
    });
});

test('smoke setup retries only a temporary Windows config persistence error, with a fixed limit', async () => {
    const persist = new JsonRpcError({ code: -32603, message: 'failed to persist config.toml' });
    let calls = 0;
    const rpc = { async request () { if (++calls === 1) { throw persist; } } };

    await writeTestConfig(rpc, [], 'seed the legacy ref', 'win32', async () => {});
    assert.equal(calls, 2);

    for (const [platform, error, expected] of [
        ['linux', persist, 1],
        ['win32', new JsonRpcError({ code: -32601, message: 'Method not found' }), 1],
        ['win32', new JsonRpcError({ code: -32603, message: 'invalid config' }), 1],
        ['win32', persist, 3]
    ]) {
        calls = 0;
        const failing = { async request () { calls++; throw error; } };

        await assert.rejects(writeTestConfig(failing, [], 'seed the legacy ref', platform, async () => {}),
            (failure) => /Could not seed the legacy ref/.test(failure.message) && failure.cause === error);
        assert.equal(calls, expected);
    }
});

test('the TUI check detects hook review and requires a ready session', { skip: process.platform !== 'linux' && 'Linux terminal check', timeout: 10000 }, async () => {
    const fake = (text, extra = {}) => checkCodexTui({
        command: process.execPath,
        args: ['-e', `console.log(${JSON.stringify(text)}); setInterval(()=>{},1000)`],
        env: process.env, settleMs: 20, timeoutMs: 1000, ...extra
    });

    await fake('OpenAI Codex\n/status - show session configuration\n›');
    await fake('OpenAI Codex\n› Ask Codex to do anything\nharness default');
    await fake('Hooks need review\n1 hook is new or changed.', { expectReview: true });
    await assert.rejects(fake('Hooks need review\n1 hook is new or changed.'), /still shows its hook review warning/);
    await assert.rejects(fake('OpenAI Codex\nloading\nUpdate available'), /did not show a ready prompt/);
});

test('the RPC transport handles notifications, remote errors, EOF, bad JSON and timeouts', { timeout: 10000 }, async () => {
    const system = createSystem({ log: () => {} }),
        reply = `let text = ''; process.stdin.setEncoding('utf8'); process.stdin.on('data', chunk => {
            text += chunk; let end;
            while ((end = text.indexOf('\\n')) >= 0) {
                const message = JSON.parse(text.slice(0, end)); text = text.slice(end + 1);
                process.stdout.write(JSON.stringify({method:'notification'})+'\\n');
                process.stdout.write(JSON.stringify({id:message.id, result:{ok:true}})+'\\n');
            }
        });`;

    const value = await system.withJsonRpc(process.execPath, ['-e', reply], (rpc) => rpc.request('test', {}));

    assert.deepEqual(value, { ok: true });

    for (const [script, expected, timeout] of [
        [`process.stdin.on('data',()=>process.stdout.write(JSON.stringify({id:1,error:{code:-32601,message:'Method not found'}})+'\\n'));`, /RPC error -32601: Method not found/, 3000],
        ['process.exit(0)', /closed/, 3000],
        [`process.stdin.on('data',()=>process.stdout.write('invalid\\n'));`, /invalid JSON/, 3000],
        ['process.stdin.resume()', /timed out/, 500],
        [`process.on('SIGTERM',()=>{}); process.stdin.resume();`, /timed out/, 500]
    ]) {
        await assert.rejects(system.withJsonRpc(process.execPath, ['-e', script], (rpc) => rpc.request('test', {}), timeout), expected);
    }

    await assert.rejects(system.withJsonRpc('/nonexistent/codex', [], (rpc) => rpc.request('test', {})));

    let called = false;

    await createSystem({ dryRun: true, log: () => {} }).withJsonRpc('/nonexistent/codex', [], async () => { called = true; });
    assert.equal(called, false);
});
