import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { codex, marketplaceRef } from '../dist/hosts/codex.js';
import { fakeSystem } from './fake-system.js';
import { POSTMAN_HOOK_KEY } from '../dist/hosts/codex-hooks.js';
import { run } from '../dist/run.js';
import { createSystem } from '../dist/system.js';

const MARKETPLACES = 'codex plugin marketplace list --json',
    REACH = 'git ls-remote --exit-code https://github.com/postmanlabs/postman-plugin.git refs/heads/codex-release',
    PLUGINS = 'codex plugin list --json',
    ours = { name: 'postman', marketplaceSource: { sourceType: 'git', source: 'https://github.com/postmanlabs/postman-plugin.git' } },
    CONFIG = path.join('/home/user', '.codex', 'config.toml'),
    installed = (pluginId) => ({ pluginId, installed: true, version: '1.0.0' }),
    // What `codex plugin marketplace add` writes, with `ref` only when it was given one.
    config = (ref) => `[marketplaces.postman]\nsource_type = "git"\nsource = "https://github.com/postmanlabs/postman-plugin.git"\n${ref ? `ref = "${ref}"\n` : ''}`;

function codexSystem ({ marketplaces = [ours], plugins = [], files = { [CONFIG]: config('codex-release') }, env = {} } = {}) {
    return fakeSystem({
        bins: ['codex'],
        files,
        env,
        probes: {
            [MARKETPLACES]: JSON.stringify({ marketplaces }),
            [PLUGINS]: JSON.stringify({ installed: plugins, available: [] }),
            [REACH]: 'abc123\trefs/heads/codex-release\n'
        }
    });
}

test('detects Codex by its CLI on PATH', async () => {
    assert.equal(await codex.detect(codexSystem()), true);
    assert.equal(await codex.detect(fakeSystem()), false);
});

test('fresh install adds this repo at codex-release as the postman marketplace, records its revision, then adds the plugin', async () => {
    const system = codexSystem({ marketplaces: [], files: {} }),
        outcome = await codex.install(system);

    assert.equal(outcome.message, 'installed postman@postman');
    assert.deepEqual(system.commands, [
        'codex plugin marketplace add postmanlabs/postman-plugin --ref codex-release --json',
        'codex plugin marketplace upgrade postman --json',
        'codex plugin add postman@postman --json'
    ]);
});

test('re-adds a marketplace that tracks main at codex-release, and still reports an update', async () => {
    const system = codexSystem({ plugins: [installed('postman@postman')], files: { [CONFIG]: config() } }),
        status = await codex.status(system),
        outcome = await codex.install(system);

    assert.match(status.notes.join('\n'), /tracks main and will be re-added at codex-release/);
    assert.equal(outcome.message, 'updated postman@postman');
    assert.deepEqual(system.commands, [
        'codex plugin marketplace remove postman --json',
        'codex plugin marketplace add postmanlabs/postman-plugin --ref codex-release --json',
        'codex plugin marketplace upgrade postman --json',
        'codex plugin add postman@postman --json'
    ]);
});

const UNPINNED = { plugins: [installed('postman@postman')], files: { [CONFIG]: config() } },
    RESTORE = [
        'codex plugin marketplace remove postman --json',
        'codex plugin marketplace add postmanlabs/postman-plugin --json',
        'codex plugin add postman@postman --json'
    ];

test('leaves a marketplace that tracks main alone when codex-release is out of reach', async () => {
    const system = codexSystem(UNPINNED);

    system.probes[REACH] = { code: 128, stderr: 'unable to access' };

    const outcome = await codex.install(system);

    assert.equal(outcome.outcome, 'failed');
    assert.match(outcome.message, /can't reach codex-release in postmanlabs\/postman-plugin, so marketplace postman was left tracking main/);
    assert.deepEqual(system.commands, []);
});

test('a migration that fails after the remove restores the marketplace tracking main and the plugin', async () => {
    for (const failing of ['codex plugin marketplace add postmanlabs/postman-plugin --ref codex-release --json', 'codex plugin marketplace upgrade postman --json']) {
        const system = codexSystem(UNPINNED);

        system.runs[failing] = { code: 1, stderr: 'network down' };

        const outcome = await codex.install(system);

        assert.equal(outcome.outcome, 'failed');
        assert.match(outcome.message, /network down\nrestored marketplace postman tracking main and postman@postman$/);
        assert.deepEqual(system.commands.slice(system.commands.indexOf(failing) + 1), RESTORE, failing);
    }
});

test('a migration whose plugin add fails restores the plugin from the marketplace tracking main', async () => {
    const system = codexSystem(UNPINNED);
    let adds = 0;

    system.runs['codex plugin add postman@postman --json'] = () => (++adds === 1 ? { code: 1, stderr: 'network down' } : '');

    const outcome = await codex.install(system);

    assert.equal(outcome.outcome, 'failed');
    assert.match(outcome.message, /restored marketplace postman tracking main and postman@postman$/);
    assert.deepEqual(system.commands.slice(-3), RESTORE);
});

test('a migration that cannot restore either says how to finish it by hand', async () => {
    const system = codexSystem(UNPINNED);

    system.runs['codex plugin marketplace upgrade postman --json'] = { code: 1, stderr: 'network down' };
    system.runs['codex plugin marketplace add postmanlabs/postman-plugin --json'] = { code: 1, stderr: 'network down' };

    const outcome = await codex.install(system);

    assert.equal(outcome.outcome, 'failed');
    assert.match(outcome.message, /could not restore it either; run `codex plugin marketplace add postmanlabs\/postman-plugin --ref codex-release` and `codex plugin add postman@postman`/);
});

test('refuses a marketplace pinned to another ref, leaving it as it is', async () => {
    const system = codexSystem({ files: { [CONFIG]: `developer_instructions = """\n${config()}"""\n${config('my-branch')}` } }),
        outcome = await codex.install(system);

    assert.equal(outcome.outcome, 'blocked');
    assert.match(outcome.message, /tracks my-branch, not codex-release; run `codex plugin marketplace remove postman`/);
    assert.deepEqual(system.commands, []);
});

test('refuses to re-register a marketplace whose ref it cannot read, leaving it as it is', async () => {
    for (const files of [
        {},
        { [CONFIG]: '[marketplaces.other]\nsource = "x"\n' },
        { [CONFIG]: '[marketplaces.postman]\n"ref" = "my-branch"\n' },
        { [CONFIG]: '[marketplaces.postman]\nref = """my-branch"""\n' },
        { [CONFIG]: `x = '''\n${config()}'''\n` }
    ]) {
        const system = codexSystem({ files }),
            outcome = await codex.install(system);

        assert.equal(outcome.outcome, 'blocked');
        assert.ok(outcome.message.includes(`can't read which ref marketplace postman tracks from ${CONFIG}`), outcome.message);
        assert.deepEqual(system.commands, []);
    }
});

test('reads the ref from $CODEX_HOME/config.toml', async () => {
    const system = codexSystem({ env: { CODEX_HOME: '/custom/codex' }, files: { [path.join('/custom/codex', 'config.toml')]: config('codex-release') } });

    assert.equal((await codex.install(system)).outcome, 'done');
    assert.deepEqual(system.commands, ['codex plugin marketplace upgrade postman --json', 'codex plugin add postman@postman --json']);
});

test('marketplaceRef reads only the named marketplace table', () => {
    assert.equal(marketplaceRef(config('codex-release'), 'postman'), 'codex-release');
    assert.equal(marketplaceRef(config(), 'postman'), null);
    assert.equal(marketplaceRef(config('a').replace(/\n/g, '\r\n'), 'postman'), 'a');
    assert.equal(marketplaceRef('[marketplaces."postman"] # ours\nref = \'b\' # pinned\n', 'postman'), 'b');
    assert.equal(marketplaceRef('[marketplaces.postman]\nsource = "x"\n[marketplaces.other]\nref = "c"\n', 'postman'), null);
    assert.equal(marketplaceRef('[marketplaces.postmanx]\nref = "d"\n', 'postman'), undefined);
    assert.equal(marketplaceRef('', 'postman'), undefined);

    const example = 'developer_instructions = """\nRegister it like this:\n[marketplaces.postman]\nsource = "x"\n"""\n';

    assert.equal(marketplaceRef(`${example}${config('my-branch')}`, 'postman'), 'my-branch');
    assert.equal(marketplaceRef(example, 'postman'), undefined);
    assert.equal(marketplaceRef(`${config()}${config('my-branch')}`, 'postman'), undefined);
    for (const line of ['"ref" = "a"', "'ref' = 'a'", 'ref = """a"""', "ref = '''a'''", 'ref = "a\\"b"', 'ref.x = "a"']) {
        assert.equal(marketplaceRef(`[marketplaces.postman]\n${line}\n`, 'postman'), undefined, line);
    }
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
