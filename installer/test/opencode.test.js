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
    probes = ({ branch = { code: 0, stdout: 'main\n' }, changes = '' } = {}) => ({
        [`git -C ${clone} remote get-url origin`]: GIT_URL,
        [`git -C ${clone} symbolic-ref --short HEAD`]: branch,
        [`git -C ${clone} status --porcelain`]: changes
    }),
    ourClone = { dirs: [path.join(clone, '.git')], probes: probes() };

test('detects OpenCode by its CLI on PATH', async () => {
    assert.equal(await opencode.detect(fakeSystem({ bins: ['opencode'] })), true);
    assert.equal(await opencode.detect(fakeSystem()), false);
});

test('fresh install clones the repo and writes the loader shim', async () => {
    const system = fakeSystem({ bins: ['git'] });

    assert.equal((await opencode.install(system)).outcome, 'done');
    assert.deepEqual(system.commands, [`git clone --depth 1 --branch main ${GIT_URL} ${clone}`, `write ${shim}`]);
    assert.equal(system.files[shim], OPENCODE_SHIM);
});

test('honours XDG_CONFIG_HOME', async () => {
    const system = fakeSystem({ bins: ['git'], env: { XDG_CONFIG_HOME: '/xdg' } });

    await opencode.install(system);

    assert.deepEqual(system.commands, [
        `git clone --depth 1 --branch main ${GIT_URL} ${path.join('/xdg', 'opencode', 'postman-plugin')}`,
        `write ${path.join('/xdg', 'opencode', 'plugins', 'postman.ts')}`
    ]);
});

test('re-run pulls and leaves an identical shim alone', async () => {
    const system = fakeSystem({ bins: ['git'], ...ourClone, files: { [shim]: OPENCODE_SHIM } });

    assert.equal((await opencode.status(system)).installed, true);
    assert.equal((await opencode.install(system)).message, `updated ${clone}`);
    assert.deepEqual(system.commands, [`git -C ${clone} pull --ff-only origin main`]);
});

test('leaves a clone on another branch for its owner to switch back', async () => {
    const onBranch = fakeSystem({
            bins: ['git'], ...ourClone, probes: probes({ branch: 'feat/old-work\n' }), files: { [shim]: OPENCODE_SHIM }
        }),
        detached = fakeSystem({
            bins: ['git'], ...ourClone, probes: probes({ branch: { code: 128, stderr: 'fatal: ref HEAD is not a symbolic ref' } })
        }),
        outcome = await opencode.install(onBranch);

    assert.equal(outcome.outcome, 'blocked');
    assert.match(outcome.message, /on branch feat\/old-work, not main; run `git -C .+ switch main`/);
    assert.match((await opencode.install(detached)).message, /a detached HEAD/);
    assert.equal((await opencode.remove(onBranch)).outcome, 'blocked');
    assert.deepEqual([...onBranch.commands, ...detached.commands], []);
});

test('refuses to overwrite a plugins/postman.ts it did not write', async () => {
    const system = fakeSystem({ bins: ['git'], files: { [shim]: 'export default {};\n' } }),
        outcome = await opencode.install(system);

    assert.equal(outcome.outcome, 'blocked');
    assert.deepEqual(system.commands, []);
    assert.match((await opencode.status(system)).notes[0], /refuse to overwrite/);
});

test('a plugins/postman.ts it cannot read is never overwritten', async () => {
    const unreadable = Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' }),
        system = fakeSystem({ bins: ['git'], files: { [shim]: unreadable } }),
        outcome = await opencode.install(system);

    assert.equal(outcome.outcome, 'failed');
    assert.match(outcome.message, /EACCES/);
    assert.deepEqual(system.commands, []);
});

test('remove deletes the clone and the shim', async () => {
    const system = fakeSystem({ bins: ['git'], ...ourClone, files: { [shim]: OPENCODE_SHIM } });

    assert.equal((await opencode.remove(system)).outcome, 'done');
    assert.deepEqual(system.commands, [`remove ${clone}`, `remove ${shim}`]);
});

test('remove deletes nothing when the clone has local changes', async () => {
    const system = fakeSystem({ bins: ['git'], ...ourClone, probes: probes({ changes: ' M skills/bootstrap/SKILL.md\n' }), files: { [shim]: OPENCODE_SHIM } }),
        outcome = await opencode.remove(system);

    assert.equal(outcome.outcome, 'blocked');
    assert.match(outcome.message, /local changes/);
    assert.deepEqual(system.commands, []);
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
