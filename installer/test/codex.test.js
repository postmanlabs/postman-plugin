import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { codex, registeredRef } from '../dist/hosts/codex.js';
import { fakeSystem } from './fake-system.js';
import { POSTMAN_HOOK_KEY } from '../dist/hosts/codex-hooks.js';
import { run } from '../dist/run.js';
import { createSystem } from '../dist/system.js';
import { codexEnvironment, writeTestConfig } from '../scripts/codex-install-check.js';
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

test('remove removes ours and the npx plugins copy, then the marketplace they came from', async () => {
    const system = removes(codexSystem({ plugins: [installed('postman@postman'), installed('postman@plugins-cli')] }),
        ['postman@postman', 'postman@plugins-cli']);

    assert.equal((await codex.remove(system)).outcome, 'done');
    assert.deepEqual(system.commands, [
        'codex plugin remove postman@postman --json',
        'codex plugin remove postman@plugins-cli --json',
        'codex plugin marketplace remove postman --json'
    ]);
});

test('remove fails when a remove exits 0 but leaves the duplicate installed', async () => {
    const system = removes(codexSystem({ plugins: [installed('postman@postman'), installed('postman@plugins-cli')] }), ['postman@postman']),
        outcome = await codex.remove(system);

    assert.equal(outcome.outcome, 'failed');
    assert.match(outcome.message, /postman@plugins-cli is still installed/);
});

test('remove skips when nothing is installed', async () => {
    const system = codexSystem({ marketplaces: [] });

    assert.equal((await codex.remove(system)).outcome, 'skipped');
    assert.deepEqual(system.commands, []);
});

const USER_CONFIG = '/home/user/.codex/config.toml';

/** A Codex whose user config holds `state` under `hooks.state`, answering `config/read` and `config/batchWrite` like codex app-server. */
function trustSystem (state, options = {}) {
    const system = codexSystem(options);
    let version = 1;

    Object.assign(system.rpcs, {
        initialize: {},
        'config/read': () => ({ config: {}, origins: {}, layers: [{ name: { type: 'user', file: USER_CONFIG }, version: `v${version}`, config: { hooks: { state } } }] }),
        'config/batchWrite': (params) => {
            if (params.expectedVersion !== `v${version}`) {
                throw new Error('Configuration was modified since last read');
            }

            for (const key of params.edits[0].keyPath === 'hooks.state' ? Object.keys(state) : [POSTMAN_HOOK_KEY]) {
                delete state[key];
            }
            version++;

            return { status: 'ok', version: `v${version}`, filePath: USER_CONFIG };
        }
    });

    return system;
}

test('remove after an older remove still takes out the marketplace and the hook approval it left', async () => {
    const state = { [POSTMAN_HOOK_KEY]: { trusted_hash: 'h' }, 'other@market:hooks/hooks.json:session_start:0:0': { trusted_hash: 'x' } },
        system = trustSystem(state),
        outcome = await codex.remove(system);

    assert.equal(outcome.outcome, 'done');
    assert.equal(outcome.message, 'removed marketplace postman, the session-start hook approval');
    assert.deepEqual(system.commands, ['codex plugin marketplace remove postman --json']);
    assert.deepEqual(system.rpcCalls.find(({ method }) => method === 'config/batchWrite').params, {
        edits: [{ keyPath: `hooks.state.${JSON.stringify(POSTMAN_HOOK_KEY)}`, value: null, mergeStrategy: 'replace' }],
        expectedVersion: 'v1',
        filePath: USER_CONFIG,
        reloadUserConfig: true
    });
    assert.deepEqual(Object.keys(state), ['other@market:hooks/hooks.json:session_start:0:0']);
});

test('remove leaves a postman marketplace registered from another source, and one still serving a plugin', async () => {
    const foreign = codexSystem({ marketplaces: [{ name: 'postman', marketplaceSource: { sourceType: 'git', source: 'https://github.com/someone/fork.git' } }] }),
        serving = codexSystem({ plugins: [installed('other@postman')] });

    assert.equal((await codex.remove(foreign)).outcome, 'skipped');
    assert.match(foreign.lines.join('\n'), /registered from https:\/\/github.com\/someone\/fork.git, not postmanlabs\/postman-plugin; left alone/);
    assert.equal((await codex.remove(serving)).outcome, 'skipped');
    assert.match(serving.lines.join('\n'), /still serves other@postman; left alone/);
    assert.deepEqual([...foreign.commands, ...serving.commands], []);
});

test('a dry-run remove still keeps a marketplace another plugin installs from', async () => {
    const system = codexSystem({ plugins: [installed('postman@postman'), installed('other@postman')] });

    Object.assign(system, { dryRun: true });
    await codex.remove(system);

    assert.deepEqual(system.commands, ['codex plugin remove postman@postman --json']);
    assert.match(system.lines.join('\n'), /still serves other@postman; left alone/);
});

test('remove keeps a hook approval it cannot delete safely, and says how to remove it', async () => {
    const changed = trustSystem({ [POSTMAN_HOOK_KEY]: { trusted_hash: 'h' } }, { marketplaces: [] }),
        read = changed.rpcs['config/read'];

    // Another writer bumps the version between the read and the write.
    changed.rpcs['config/read'] = () => { const reply = read(); reply.layers[0].version = 'stale'; return reply; };

    const outcome = await codex.remove(changed);

    assert.equal(outcome.outcome, 'skipped');
    assert.match(changed.lines.join('\n'), /Could not delete Postman's hook approval: Configuration was modified since last read\. Remove `\[hooks\.state\."postman@postman:hooks\/codex-hooks\.json:session_start:0:0"\]`/);
});

test('remove deletes the whole hooks.state table when Postman\'s approval is the only one in it', async () => {
    const system = trustSystem({ [POSTMAN_HOOK_KEY]: { trusted_hash: 'h' } }, { marketplaces: [] });

    assert.equal((await codex.remove(system)).message, 'removed the session-start hook approval');
    assert.deepEqual(system.rpcCalls.find(({ method }) => method === 'config/batchWrite').params.edits, [{ keyPath: 'hooks.state', value: null, mergeStrategy: 'replace' }]);
});

test('a Codex whose config/read has no layers says the approval could not be checked, and one without a user config says nothing', async () => {
    const unsupported = trustSystem({}, { marketplaces: [] }),
        noConfig = trustSystem({}, { marketplaces: [] });

    unsupported.rpcs['config/read'] = () => ({ config: {}, origins: {} });
    noConfig.rpcs['config/read'] = () => ({ config: {}, origins: {}, layers: [] });

    const outcome = await codex.remove(unsupported);

    await codex.remove(noConfig);

    assert.ok(unsupported.lines.join('\n').includes(`Could not check ${path.join('/home/user', '.codex', 'config.toml')} for Postman's session-start hook approval: config/read returned no config layers.`));
    assert.doesNotMatch(unsupported.lines.join('\n'), /yourself/);
    assert.deepEqual(outcome, { outcome: 'skipped', message: 'not installed, though the session-start hook approval could not be checked' });
    assert.deepEqual(noConfig.lines, []);
});

test('remove without a hook approval writes nothing to the Codex config', async () => {
    const system = trustSystem({ 'other:hook': { trusted_hash: 'x' } }, { marketplaces: [] });

    assert.equal((await codex.remove(system)).outcome, 'skipped');
    assert.ok(!system.rpcCalls.some(({ method }) => method === 'config/batchWrite'));
});

test('a dry-run remove prints the hook-approval delete without starting codex app-server', async () => {
    const system = trustSystem({ [POSTMAN_HOOK_KEY]: { trusted_hash: 'h' } }, { marketplaces: [] });

    Object.assign(system, { dryRun: true });
    await codex.remove(system);

    assert.deepEqual(system.rpcSessions, []);
    assert.match(system.lines.join('\n'), /config\/batchWrite .*"value":null,"mergeStrategy":"replace"/);
});

test('a dry-run remove never reports "not installed" for a hook approval it cannot check', async () => {
    const onlyApproval = Object.assign(trustSystem({ [POSTMAN_HOOK_KEY]: { trusted_hash: 'h' } }, { marketplaces: [] }), { dryRun: true }),
        withMarketplace = Object.assign(trustSystem({ [POSTMAN_HOOK_KEY]: { trusted_hash: 'h' } }), { dryRun: true });

    assert.deepEqual(await codex.remove(onlyApproval), { outcome: 'skipped', message: 'not installed, though the session-start hook approval could not be checked' });
    assert.equal((await codex.remove(withMarketplace)).message, 'removed marketplace postman, the session-start hook approval, if present');
});

test('dry-run ref detection starts no app-server, even for an installed marketplace', async () => {
    const system = Object.assign(codexSystem(), { dryRun: true });

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

// Signed in through ChatGPT, Codex drops a plugin's MCP server that shares a name with one of its apps.
// https://github.com/openai/codex/blob/rust-v0.164.0/codex-rs/core-plugins/src/app_mcp_routing.rs#L20-L38
test('no MCP server in mcp.codex.json shares a name with an app in .app.json', () => {
    const repoRoot = path.resolve(import.meta.dirname, '..', '..'),
        read = (file) => JSON.parse(fs.readFileSync(path.join(repoRoot, file), 'utf8')),
        apps = Object.keys(read('.app.json').apps),
        servers = Object.keys(read('mcp.codex.json').mcpServers);

    assert.deepEqual(servers.filter((name) => apps.includes(name)), [], 'rename the server, or Codex hides it from ChatGPT sign-ins');
});
