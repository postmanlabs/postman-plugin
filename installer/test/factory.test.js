import assert from 'node:assert/strict';
import test from 'node:test';
import { factory } from '../dist/hosts/factory.js';
import { fakeSystem } from './fake-system.js';

const MARKETPLACES = 'droid plugin marketplace list',
    PLUGINS = 'droid plugin list --scope user',
    PROJECT_PLUGINS = 'droid plugin list --scope project',
    ours = marketplace('postman-plugin', 'github:postmanlabs/postman-plugin'),
    installed = (pluginId = 'postman@postman-plugin') => `  ${pluginId}  [user]  abc1234`;

function marketplace (name, source) {
    return `  ${name}  (1 plugin)  ${source}`;
}

function factorySystem ({ marketplaces = [ours], plugins = [], projectPlugins = [] } = {}) {
    return fakeSystem({
        bins: ['droid'],
        probes: {
            [MARKETPLACES]: marketplaces.length ? `Registered marketplaces:\n${marketplaces.join('\n')}\n` : 'No marketplaces registered.\n',
            [PLUGINS]: plugins.length ? `Installed plugins:\nActive:\n${plugins.join('\n')}\n` : 'No plugins installed in user scope.\n',
            [PROJECT_PLUGINS]: projectPlugins.length ? `Installed plugins:\nActive:\n${projectPlugins.join('\n')}\n` : 'No plugins installed in project scope.\n'
        }
    });
}

test('detects Factory Droid by its CLI on PATH', async () => {
    assert.equal(await factory.detect(factorySystem()), true);
    assert.equal(await factory.detect(fakeSystem()), false);
});

test('fresh install adds this repo as a marketplace, then installs the plugin', async () => {
    const system = factorySystem({ marketplaces: [] }),
        outcome = await factory.install(system);

    assert.equal(outcome.message, 'installed postman@postman-plugin');
    assert.deepEqual(system.commands, [
        'droid plugin marketplace add https://github.com/postmanlabs/postman-plugin.git',
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

const UNINSTALL = 'droid plugin uninstall postman@postman-plugin --scope user',
    REMOVE_MARKETPLACE = 'droid plugin marketplace remove postman-plugin';

test('remove uninstalls the user-scope plugin, then removes the marketplace it came from', async () => {
    const system = factorySystem({ plugins: [installed()] });

    system.runs[UNINSTALL] = (fake) => {
        fake.probes[PLUGINS] = 'No plugins installed in user scope.\n';

        return '';
    };

    assert.equal((await factory.remove(system)).message, 'uninstalled postman@postman-plugin and removed marketplace postman-plugin');
    assert.deepEqual(system.commands, [UNINSTALL, REMOVE_MARKETPLACE]);
    assert.equal((await factory.remove(factorySystem({ marketplaces: [] }))).outcome, 'skipped');
});

test('remove after an older remove still takes out the marketplace it left', async () => {
    const system = factorySystem();

    assert.equal((await factory.remove(system)).message, 'removed marketplace postman-plugin');
    assert.deepEqual(system.commands, [REMOVE_MARKETPLACE]);
});

test('remove keeps the marketplace while this project installs from it, or when it comes from elsewhere', async () => {
    const project = factorySystem({ projectPlugins: ['  postman@postman-plugin  [project]  abc1234'] }),
        foreign = factorySystem({ marketplaces: [marketplace('postman-plugin', 'github:someone/fork')] });

    assert.equal((await factory.remove(project)).outcome, 'skipped');
    assert.match(project.lines.join('\n'), /still serves postman@postman-plugin \[project\]; left alone/);
    assert.equal((await factory.remove(foreign)).outcome, 'skipped');
    assert.match(foreign.lines.join('\n'), /registered from github:someone\/fork, not postmanlabs\/postman-plugin; left alone/);
    assert.deepEqual([...project.commands, ...foreign.commands], []);
});

test('a dry-run remove counts the plugin it would uninstall as gone', async () => {
    const system = factorySystem({ plugins: [installed()] });

    Object.assign(system, { dryRun: true });
    await factory.remove(system);

    assert.deepEqual(system.commands, [UNINSTALL, REMOVE_MARKETPLACE]);
});

const TABLE_MARKETPLACES = [
        'MARKETPLACE     SOURCE                             PLUGINS  DISPLAY NAME',
        'postman-plugin  github:postmanlabs/postman-plugin        1  —',
        ''
    ].join('\n'),
    TABLE_PLUGINS = [
        'PLUGIN                  STATUS   SOURCE  VERSION',
        'postman@postman-plugin  Enabled  user    e94d308f9603',
        ''
    ].join('\n');

function tableSystem ({ marketplaces = TABLE_MARKETPLACES, plugins = TABLE_PLUGINS } = {}) {
    return fakeSystem({ bins: ['droid'], probes: { [MARKETPLACES]: marketplaces, [PLUGINS]: plugins } });
}

test('status and re-run read the table Droid 0.251.0 and later print', async () => {
    assert.equal((await factory.status(tableSystem())).installed, true);
    assert.equal((await factory.status(tableSystem({ plugins: TABLE_PLUGINS.replace('postman@', 'other@') }))).installed, false);

    const system = tableSystem();

    assert.equal((await factory.install(system)).message, 'updated postman@postman-plugin');
    assert.deepEqual(system.commands, [
        'droid plugin marketplace update postman-plugin',
        'droid plugin update postman@postman-plugin --scope user'
    ]);
});

test('reads a Windows table and ignores a project-scope row', async () => {
    assert.equal((await factory.status(tableSystem({ plugins: TABLE_PLUGINS.replaceAll('\n', '\r\n') }))).installed, true);
    assert.equal((await factory.status(tableSystem({ plugins: TABLE_PLUGINS.replace('user   ', 'project') }))).installed, false);
});

test('reads a table marketplace source that Droid wrapped onto more lines', async () => {
    const wrapped = [
            'MARKETPLACE     SOURCE                                    PLUGINS  DISPLAY NAME',
            'postman-plugin  local:/home/someone/src/a-very-long-path        1  postman-plugin',
            '                /postman-plugin',
            ''
        ].join('\n'),
        system = tableSystem({ marketplaces: wrapped }),
        outcome = await factory.install(system);

    assert.equal(outcome.outcome, 'blocked');
    assert.match(outcome.message, /local:\/home\/someone\/src\/a-very-long-path\/postman-plugin,/);
    assert.deepEqual(system.commands, []);
});
