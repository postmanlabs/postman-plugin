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

test('removes the copy `npx plugins add` leaves before adding ours', async () => {
    const system = codexSystem({ plugins: [installed('postman@plugins-cli')] }),
        status = await codex.status(system);

    await codex.install(system);

    assert.deepEqual(status.notes, ['postman@plugins-cli duplicates it and will be removed']);
    assert.deepEqual(system.commands, [
        'codex plugin marketplace upgrade postman --json',
        'codex plugin remove postman@plugins-cli --json',
        'codex plugin add postman@postman --json'
    ]);
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

test('remove removes ours and the npx plugins copy; the marketplace stays', async () => {
    const system = codexSystem({ plugins: [installed('postman@postman'), installed('postman@plugins-cli')] });

    assert.equal((await codex.remove(system)).outcome, 'done');
    assert.deepEqual(system.commands, [
        'codex plugin remove postman@postman --json',
        'codex plugin remove postman@plugins-cli --json'
    ]);
});

test('remove skips when nothing is installed', async () => {
    const system = codexSystem();

    assert.equal((await codex.remove(system)).outcome, 'skipped');
    assert.deepEqual(system.commands, []);
});
