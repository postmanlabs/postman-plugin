import assert from 'node:assert/strict';
import test from 'node:test';
import { codex } from '../dist/hosts/codex.js';
import { fakeSystem } from './fake-system.js';

const MARKETPLACES = 'codex plugin marketplace list --json',
    PLUGINS = 'codex plugin list --json',
    ours = { name: 'postman', marketplaceSource: { sourceType: 'git', source: 'https://github.com/postmanlabs/postman-plugin.git' } },
    installed = (pluginId) => ({ pluginId, installed: true, version: '1.0.0' });

function codexSystem ({ marketplaces = [ours], plugins = [] } = {}) {
    return fakeSystem({
        bins: ['codex'],
        probes: {
            [MARKETPLACES]: JSON.stringify({ marketplaces }),
            [PLUGINS]: JSON.stringify({ installed: plugins, available: [] })
        }
    });
}

test('detects Codex by its CLI on PATH', async () => {
    assert.equal(await codex.detect(codexSystem()), true);
    assert.equal(await codex.detect(fakeSystem()), false);
});

test('fresh install adds this repo as the postman marketplace, then adds the plugin', async () => {
    const system = codexSystem({ marketplaces: [] }),
        outcome = await codex.install(system);

    assert.equal(outcome.message, 'installed postman@postman');
    assert.deepEqual(system.commands, [
        'codex plugin marketplace add postmanlabs/postman-plugin --json',
        'codex plugin add postman@postman --json'
    ]);
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
