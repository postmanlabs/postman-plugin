import assert from 'node:assert/strict';
import test from 'node:test';
import { copilot } from '../dist/hosts/copilot.js';
import { fakeSystem } from './fake-system.js';

const LIST = 'copilot plugin list --json',
    ours = (extra = {}) => ({ name: 'postman', version: '0.1.0', enabled: true, source: 'github', ...extra });

function cli ({ plugins = [], runs = {} } = {}) {
    return fakeSystem({ bins: ['copilot'], probes: { [LIST]: JSON.stringify(plugins) }, runs });
}

test('detects Copilot CLI by its binary on PATH', async () => {
    assert.equal(await copilot.detect(cli()), true);
    assert.equal(await copilot.detect(fakeSystem()), false);
});

const MARKETPLACES = 'copilot plugin marketplace list --json';

function cliWith ({ plugins = [], marketplaces = [], runs = {} } = {}) {
    return fakeSystem({
        bins: ['copilot'],
        probes: { [LIST]: JSON.stringify(plugins), [MARKETPLACES]: JSON.stringify(marketplaces) },
        runs
    });
}

test('fresh install registers this repo as a marketplace, then installs from it', async () => {
    const system = cliWith(),
        outcome = await copilot.install(system);

    assert.equal(outcome.message, 'installed postman@postman');
    assert.deepEqual(system.commands, [
        'copilot plugin marketplace add postmanlabs/postman-plugin',
        'copilot plugin install postman@postman'
    ]);
});

test('re-run refreshes the marketplace and updates', async () => {
    const system = cliWith({ plugins: [ours({ marketplace: 'postman' })], marketplaces: [{ name: 'postman' }] }),
        outcome = await copilot.install(system);

    assert.equal(outcome.message, 'updated postman@postman');
    assert.deepEqual(system.commands, ['copilot plugin marketplace update postman', 'copilot plugin update postman']);
});

test('a direct install is replaced, since the same name cannot load twice', async () => {
    const system = cliWith({ plugins: [ours()], marketplaces: [{ name: 'postman' }] });

    await copilot.install(system);

    assert.deepEqual(system.commands, [
        'copilot plugin marketplace update postman',
        'copilot plugin uninstall postman',
        'copilot plugin install postman@postman'
    ]);
});

test('another plugin does not count as ours', async () => {
    const system = cliWith({ plugins: [{ name: 'incident-io', marketplace: 'awesome-copilot', enabled: true }] });

    await copilot.install(system);

    assert.equal(system.commands.at(-1), 'copilot plugin install postman@postman');
});

test('a failed install is reported as failed', async () => {
    const system = cliWith({ runs: { 'copilot plugin install postman@postman': { code: 1, stdout: '', stderr: 'boom' } } }),
        outcome = await copilot.install(system);

    assert.equal(outcome.outcome, 'failed');
    assert.match(outcome.message, /boom/);
});

test('status reads the plugin list, and says so when it cannot', async () => {
    assert.deepEqual(await copilot.status(cli({ plugins: [ours()] })), { installed: true, detail: 'postman 0.1.0', notes: [] });
    assert.equal((await copilot.status(cli())).installed, false);
    assert.equal((await copilot.status(fakeSystem({ bins: ['copilot'] }))).installed, null);
});

test('status notes a disabled install', async () => {
    const status = await copilot.status(cli({ plugins: [ours({ enabled: false })] }));

    assert.equal(status.installed, true);
    assert.match(status.notes[0], /disabled/);
});

const OWN = { name: 'postman', source: 'GitHub: postmanlabs/postman-plugin', isDefault: false },
    DEFAULT = { name: 'awesome-copilot', source: 'GitHub: github/awesome-copilot', isDefault: true };

test('remove uninstalls, then unregisters the marketplace it came from; skips when neither is there', async () => {
    const present = cliWith({ plugins: [ours({ marketplace: 'postman' })], marketplaces: [OWN, DEFAULT] });

    present.runs['copilot plugin uninstall postman'] = (fake) => {
        fake.probes[LIST] = '[]';

        return '';
    };

    const outcome = await copilot.remove(present);

    assert.equal(outcome.message, 'uninstalled postman and removed marketplace postman');
    assert.deepEqual(present.commands, ['copilot plugin uninstall postman', 'copilot plugin marketplace remove postman']);

    const absent = cliWith({ marketplaces: [DEFAULT] });

    assert.equal((await copilot.remove(absent)).outcome, 'skipped');
    assert.deepEqual(absent.commands, []);
});

test('remove after an older remove still unregisters the marketplace it left', async () => {
    const system = cliWith({ marketplaces: [OWN, DEFAULT] });

    assert.equal((await copilot.remove(system)).message, 'removed marketplace postman');
    assert.deepEqual(system.commands, ['copilot plugin marketplace remove postman']);
});

test('remove leaves a postman marketplace from another repo, and one still serving a plugin', async () => {
    const foreign = cliWith({ marketplaces: [{ name: 'postman', source: 'GitHub: someone/postman' }] }),
        serving = cliWith({ plugins: [{ name: 'other', marketplace: 'postman' }], marketplaces: [OWN] });

    assert.equal((await copilot.remove(foreign)).outcome, 'skipped');
    assert.match(foreign.lines.join('\n'), /registered from someone\/postman, not postmanlabs\/postman-plugin; left alone/);
    assert.equal((await copilot.remove(serving)).outcome, 'skipped');
    assert.match(serving.lines.join('\n'), /still serves other; left alone/);
    assert.deepEqual([...foreign.commands, ...serving.commands], []);
});
