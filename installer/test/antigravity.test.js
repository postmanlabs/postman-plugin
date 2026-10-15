import assert from 'node:assert/strict';
import test from 'node:test';
import { antigravity } from '../dist/hosts/antigravity.js';
import { fakeSystem } from './fake-system.js';

const LIST = 'agy plugin list --json',
    INSTALL = 'agy plugin install https://github.com/postmanlabs/postman-plugin',
    ours = (extra = {}) => ({ name: 'postman', enabled: true, version: '0.1.0', source: 'antigravity', ...extra });

function cli ({ plugins = [], runs = {} } = {}) {
    return fakeSystem({ bins: ['agy'], probes: { [LIST]: JSON.stringify(plugins) }, runs });
}

test('detects Antigravity by the agy binary on PATH', async () => {
    assert.equal(await antigravity.detect(cli()), true);
    assert.equal(await antigravity.detect(fakeSystem()), false);
});

test('fresh install installs this repo by its git URL', async () => {
    const system = cli(),
        outcome = await antigravity.install(system);

    assert.equal(outcome.message, 'installed postman');
    assert.deepEqual(system.commands, [INSTALL]);
});

test('re-run installs again, which replaces the copy in place', async () => {
    const system = cli({ plugins: [ours()] }),
        outcome = await antigravity.install(system);

    assert.equal(outcome.message, 'updated postman');
    assert.deepEqual(system.commands, [INSTALL]);
});

test('another plugin does not count as ours', async () => {
    const system = cli({ plugins: [{ name: 'sonarqube', enabled: true }] }),
        outcome = await antigravity.install(system);

    assert.equal(outcome.message, 'installed postman');
});

test('a failed install is reported as failed', async () => {
    const outcome = await antigravity.install(cli({ runs: { [INSTALL]: { code: 1, stdout: '', stderr: 'boom' } } }));

    assert.equal(outcome.outcome, 'failed');
    assert.match(outcome.message, /boom/);
});

test('an unreadable plugin list fails the install before it changes anything', async () => {
    const system = fakeSystem({ bins: ['agy'], probes: { [LIST]: 'not json' } }),
        outcome = await antigravity.install(system);

    assert.equal(outcome.outcome, 'failed');
    assert.deepEqual(system.commands, []);
});

test('status reports the installed version, and a disabled install', async () => {
    assert.deepEqual(await antigravity.status(cli({ plugins: [ours()] })), { installed: true, detail: 'postman 0.1.0', notes: [] });
    assert.equal((await antigravity.status(cli())).installed, false);
    assert.match((await antigravity.status(cli({ plugins: [ours({ enabled: false })] }))).notes[0], /agy plugin enable postman/);
    assert.equal((await antigravity.status(fakeSystem({ bins: ['agy'], probes: { [LIST]: 'nope' } }))).installed, null);
});

test('remove uninstalls by name, and skips when not installed', async () => {
    const system = cli({ plugins: [ours()] });

    assert.equal((await antigravity.remove(system)).message, 'uninstalled postman');
    assert.deepEqual(system.commands, ['agy plugin uninstall postman']);

    const absent = cli();

    assert.equal((await antigravity.remove(absent)).outcome, 'skipped');
    assert.deepEqual(absent.commands, []);
});
