import assert from 'node:assert/strict';
import test from 'node:test';
import { codex, registeredRef } from '../dist/hosts/codex.js';
import { fakeSystem } from './fake-system.js';

const MARKETPLACES = 'codex plugin marketplace list --json',
    REACH = 'git ls-remote --exit-code https://github.com/postmanlabs/postman-plugin.git refs/heads/codex-release',
    PLUGINS = 'codex plugin list --json',
    ours = { name: 'postman', marketplaceSource: { sourceType: 'git', source: 'https://github.com/postmanlabs/postman-plugin.git' } },
    APP_SERVER = 'codex app-server',
    INITIALIZED = { result: { userAgent: 'codex' } },
    installed = (pluginId) => ({ pluginId, installed: true, version: '1.0.0' }),
    // What `config/read` answers for the marketplace `codex plugin marketplace add` registered, with `ref` null without `--ref`.
    readReplies = (ref) => [INITIALIZED, { result: { config: { marketplaces: { postman: { source_type: 'git', source: 'https://github.com/postmanlabs/postman-plugin.git', ref } } } } }];

function codexSystem ({ marketplaces = [ours], plugins = [], ref = 'codex-release' } = {}) {
    return fakeSystem({
        bins: ['codex'],
        rpcs: { [APP_SERVER]: readReplies(ref) },
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
    const system = codexSystem({ marketplaces: [] }),
        outcome = await codex.install(system);

    assert.equal(outcome.message, 'installed postman@postman');
    assert.deepEqual(system.commands, [
        'codex plugin marketplace add postmanlabs/postman-plugin --ref codex-release --json',
        'codex plugin marketplace upgrade postman --json',
        'codex plugin add postman@postman --json'
    ]);
});

test('re-adds a marketplace that tracks main at codex-release, and still reports an update', async () => {
    const system = codexSystem({ plugins: [installed('postman@postman')], ref: null }),
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

const UNPINNED = { plugins: [installed('postman@postman')], ref: null },
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
    assert.match(outcome.message, /could not restore it either; run `codex plugin marketplace remove postman`, `codex plugin marketplace add postmanlabs\/postman-plugin --ref codex-release`, `codex plugin marketplace upgrade postman` and `codex plugin add postman@postman`/);
});

test('a restore that re-adds the marketplace but not the plugin says to remove that marketplace first', async () => {
    const system = codexSystem(UNPINNED);

    system.runs['codex plugin marketplace upgrade postman --json'] = { code: 1, stderr: 'network down' };
    system.runs['codex plugin add postman@postman --json'] = { code: 1, stderr: 'network down' };

    const outcome = await codex.install(system);

    assert.equal(outcome.outcome, 'failed');
    assert.ok(system.commands.includes('codex plugin marketplace add postmanlabs/postman-plugin --json'), 'the restore re-added the unpinned marketplace');
    assert.match(outcome.message, /could not restore it either; run `codex plugin marketplace remove postman`, `codex plugin marketplace add postmanlabs\/postman-plugin --ref codex-release`/);
});

test('refuses a marketplace pinned to another ref, leaving it as it is', async () => {
    const system = codexSystem({ ref: 'my-branch' }),
        outcome = await codex.install(system);

    assert.equal(outcome.outcome, 'blocked');
    assert.match(outcome.message, /tracks my-branch, not codex-release; run `codex plugin marketplace remove postman`/);
    assert.deepEqual(system.commands, []);
});

test('refuses to re-register a marketplace whose ref Codex does not report, leaving it as it is', async () => {
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

        assert.equal(outcome.outcome, 'blocked', JSON.stringify(replies));
        assert.match(outcome.message, /Codex's `config\/read` doesn't report which ref marketplace postman tracks/);
        assert.deepEqual(system.commands, []);
    }
});

test('asks Codex for the ref with config/read over its app server', async () => {
    const system = codexSystem();
    let sent;

    system.rpcs[APP_SERVER] = (fake, calls) => {
        sent = calls;

        return readReplies('codex-release');
    };

    assert.equal((await codex.install(system)).outcome, 'done');
    assert.deepEqual(sent.map(({ method, notify }) => (notify ? `${method} (notification)` : method)), ['initialize', 'initialized (notification)', 'config/read']);
});

test('registeredRef reports a string ref, null for none, and undefined for anything else', async () => {
    const ref = (replies) => registeredRef(fakeSystem({ rpcs: { [APP_SERVER]: replies } }));

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
