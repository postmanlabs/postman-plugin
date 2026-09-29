import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { opencode } from '../dist/hosts/opencode.js';
import { OPENCODE_SHIM } from '../dist/source.js';
import { fakeSystem } from './fake-system.js';

const config = path.join('/home/user', '.config', 'opencode'),
    clone = path.join(config, 'postman-plugin'),
    shim = path.join(config, 'plugins', 'postman.ts'),
    GIT_URL = 'https://github.com/postmanlabs/postman-plugin.git',
    ourClone = { dirs: [path.join(clone, '.git')], probes: { [`git -C ${clone} remote get-url origin`]: GIT_URL } };

test('detects OpenCode by its CLI on PATH', async () => {
    assert.equal(await opencode.detect(fakeSystem({ bins: ['opencode'] })), true);
    assert.equal(await opencode.detect(fakeSystem()), false);
});

test('fresh install clones the repo and writes the loader shim', async () => {
    const system = fakeSystem({ bins: ['git'] });

    assert.equal((await opencode.install(system)).outcome, 'done');
    assert.deepEqual(system.commands, [`git clone --depth 1 ${GIT_URL} ${clone}`, `write ${shim}`]);
    assert.equal(system.files[shim], OPENCODE_SHIM);
});

test('honours XDG_CONFIG_HOME', async () => {
    const system = fakeSystem({ bins: ['git'], env: { XDG_CONFIG_HOME: '/xdg' } });

    await opencode.install(system);

    assert.deepEqual(system.commands, [
        `git clone --depth 1 ${GIT_URL} ${path.join('/xdg', 'opencode', 'postman-plugin')}`,
        `write ${path.join('/xdg', 'opencode', 'plugins', 'postman.ts')}`
    ]);
});

test('re-run pulls and leaves an identical shim alone', async () => {
    const system = fakeSystem({ bins: ['git'], ...ourClone, files: { [shim]: OPENCODE_SHIM } });

    assert.equal((await opencode.status(system)).installed, true);
    assert.equal((await opencode.install(system)).message, `updated ${clone}`);
    assert.deepEqual(system.commands, [`git -C ${clone} pull --ff-only`]);
});

test('refuses to overwrite a plugins/postman.ts it did not write', async () => {
    const system = fakeSystem({ bins: ['git'], files: { [shim]: 'export default {};\n' } }),
        outcome = await opencode.install(system);

    assert.equal(outcome.outcome, 'blocked');
    assert.deepEqual(system.commands, []);
    assert.match((await opencode.status(system)).notes[0], /refuse to overwrite/);
});

test('remove deletes the clone and the shim', async () => {
    const system = fakeSystem({ bins: ['git'], ...ourClone, files: { [shim]: OPENCODE_SHIM } });

    assert.equal((await opencode.remove(system)).outcome, 'done');
    assert.deepEqual(system.commands, [`remove ${clone}`, `remove ${shim}`]);
});

test('remove deletes nothing when the clone is not ours', async () => {
    const system = fakeSystem({
            bins: ['git'],
            dirs: [path.join(clone, '.git')],
            probes: { [`git -C ${clone} remote get-url origin`]: 'https://github.com/someone/fork.git' },
            files: { [shim]: OPENCODE_SHIM }
        }),
        outcome = await opencode.remove(system);

    assert.equal(outcome.outcome, 'blocked');
    assert.deepEqual(system.commands, []);
});
