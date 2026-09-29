import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { kimi } from '../dist/hosts/kimi.js';
import { fakeSystem } from './fake-system.js';

const home = '/home/user',
    defaultHome = path.join(home, '.kimi-code'),
    INSTALL = 'npx -y --package=plugins@1.3.4 plugins add postmanlabs/postman-plugin --target kimi --yes',
    installedJson = (kimiHome, ids) => ({
        [path.join(kimiHome, 'plugins', 'installed.json')]: JSON.stringify({ plugins: ids.map((id) => ({ id })) })
    });

test('detects Kimi Code on PATH or in the places the plugins CLI looks', async () => {
    assert.equal(await kimi.detect(fakeSystem({ bins: ['kimi'] })), true);
    assert.equal(await kimi.detect(fakeSystem({ files: { [path.join(defaultHome, 'bin', 'kimi')]: '' } })), true);
    assert.equal(await kimi.detect(fakeSystem({ env: { KIMI_CODE_HOME: '/opt/kimi' }, files: { [path.join('/opt/kimi', 'bin', 'kimi')]: '' } })), true);
    assert.equal(await kimi.detect(fakeSystem()), false);
});

test('reads installed state from Kimi\'s plugin store, honouring KIMI_CODE_HOME', async () => {
    assert.equal((await kimi.status(fakeSystem({ files: installedJson(defaultHome, ['postman']) }))).installed, true);
    assert.equal((await kimi.status(fakeSystem({ files: installedJson(defaultHome, ['other']) }))).installed, false);
    assert.equal((await kimi.status(fakeSystem())).installed, false);
    assert.equal((await kimi.status(fakeSystem({
        env: { KIMI_CODE_HOME: '/opt/kimi' },
        files: installedJson('/opt/kimi', ['postman'])
    }))).installed, true);
    assert.equal((await kimi.status(fakeSystem({ files: { [path.join(defaultHome, 'plugins', 'installed.json')]: '{' } }))).installed, null);
});

test('installs through the pinned plugins CLI, targeting only Kimi, with telemetry off', async () => {
    const system = fakeSystem({ bins: ['npx'] }),
        outcome = await kimi.install(system);

    assert.equal(outcome.outcome, 'done');
    assert.deepEqual(system.commands, [INSTALL]);
    assert.deepEqual(system.runEnv[INSTALL], { DISABLE_TELEMETRY: '1', DO_NOT_TRACK: '1' });
});

test('reports a re-install as an update', async () => {
    const system = fakeSystem({ bins: ['npx'], files: installedJson(defaultHome, ['postman']) });

    assert.match((await kimi.install(system)).message, /^updated postman/);
    assert.match((await kimi.install(fakeSystem({ bins: ['npx'] }))).message, /^installed postman/);
});

test('installs even when the plugin store cannot be read', async () => {
    const system = fakeSystem({
            bins: ['npx'],
            files: { [path.join(defaultHome, 'plugins', 'installed.json')]: new Error('EACCES: permission denied') }
        }),
        outcome = await kimi.install(system);

    assert.equal(outcome.outcome, 'done');
    assert.deepEqual(system.commands, [INSTALL]);
});

test('blocks without npx', async () => {
    assert.equal((await kimi.install(fakeSystem())).outcome, 'blocked');
});

test('remove is a manual step, since Kimi has no shell command for it', async () => {
    const installed = fakeSystem({ files: installedJson(defaultHome, ['postman']) }),
        outcome = await kimi.remove(installed);

    assert.equal(outcome.outcome, 'manual');
    assert.match(outcome.next, /\/plugins remove postman/);
    assert.equal((await kimi.remove(fakeSystem())).outcome, 'skipped');
});
