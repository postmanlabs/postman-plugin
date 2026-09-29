import assert from 'node:assert/strict';
import test from 'node:test';
import { factory } from '../dist/hosts/factory.js';
import { fakeSystem } from './fake-system.js';

const MARKETPLACES = 'droid plugin marketplace list',
    PLUGINS = 'droid plugin list --scope user',
    ours = marketplace('postman-plugin', 'github:postmanlabs/postman-plugin'),
    installed = (pluginId = 'postman@postman-plugin') => `  ${pluginId}  [user]  abc1234`;

function marketplace (name, source) {
    return `  ${name}  (1 plugin)  ${source}`;
}

function factorySystem ({ marketplaces = [ours], plugins = [] } = {}) {
    return fakeSystem({
        bins: ['droid'],
        probes: {
            [MARKETPLACES]: marketplaces.length ? `Registered marketplaces:\n${marketplaces.join('\n')}\n` : 'No marketplaces registered.\n',
            [PLUGINS]: plugins.length ? `Installed plugins:\nActive:\n${plugins.join('\n')}\n` : 'No plugins installed in user scope.\n'
        }
    });
}

test('detects Factory.ai by its CLI on PATH', async () => {
    assert.equal(await factory.detect(factorySystem()), true);
    assert.equal(await factory.detect(fakeSystem()), false);
});

test('fresh install adds this repo as a marketplace, then installs the plugin', async () => {
    const system = factorySystem({ marketplaces: [] }),
        outcome = await factory.install(system);

    assert.equal(outcome.message, 'installed postman@postman-plugin');
    assert.deepEqual(system.commands, [
        'droid plugin marketplace add postmanlabs/postman-plugin',
        'droid plugin install postman@postman-plugin --scope user'
    ]);
});

test('re-run updates the marketplace and the installed plugin', async () => {
    const system = factorySystem({ plugins: [installed()] }),
        outcome = await factory.install(system);

    assert.equal(outcome.message, 'updated postman@postman-plugin');
    assert.deepEqual(system.commands, [
        'droid plugin marketplace update postman-plugin',
        'droid plugin update postman@postman-plugin --scope user'
    ]);
});

test('status reads Droid human output', async () => {
    assert.equal((await factory.status(factorySystem({ plugins: [installed()] }))).installed, true);
    assert.equal((await factory.status(factorySystem())).installed, false);
    assert.equal((await factory.status(factorySystem({ plugins: [installed('other@postman-plugin')] }))).installed, false);
});

test('accepts the marketplace source in GitHub URL form', async () => {
    const system = factorySystem({ marketplaces: [marketplace('postman-plugin', 'github:https://github.com/postmanlabs/postman-plugin.git')] });

    assert.equal((await factory.install(system)).outcome, 'done');
});

test('refuses a postman-plugin marketplace that points somewhere else', async () => {
    const system = factorySystem({ marketplaces: [marketplace('postman-plugin', 'local:/src/postman-plugin')] }),
        outcome = await factory.install(system);

    assert.equal(outcome.outcome, 'blocked');
    assert.match(outcome.message, /local:\/src\/postman-plugin/);
    assert.deepEqual(system.commands, []);
});

test('remove uninstalls the user-scope plugin only when present', async () => {
    const system = factorySystem({ plugins: [installed()] });

    assert.equal((await factory.remove(system)).outcome, 'done');
    assert.deepEqual(system.commands, ['droid plugin uninstall postman@postman-plugin --scope user']);
    assert.equal((await factory.remove(factorySystem())).outcome, 'skipped');
});
