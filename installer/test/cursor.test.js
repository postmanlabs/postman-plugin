import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { cursor } from '../dist/hosts/cursor.js';
import { fakeSystem } from './fake-system.js';

const home = '/home/user',
    local = path.join(home, '.cursor', 'plugins', 'local', 'postman'),
    marketplaceCopy = path.join(home, '.cursor', 'plugins', 'cache', 'cursor-public', 'postman'),
    GIT_URL = 'https://github.com/postmanlabs/postman-plugin.git',
    origin = (url) => ({ [`git -C ${local} remote get-url origin`]: `${url}\n` });

test('detects Cursor by CLI, by app bundle on macOS, or by its config directory', async () => {
    assert.equal(await cursor.detect(fakeSystem({ bins: ['cursor'] })), true);
    assert.equal(await cursor.detect(fakeSystem({ platform: 'darwin', dirs: ['/Applications/Cursor.app'] })), true);
    assert.equal(await cursor.detect(fakeSystem({ dirs: [path.join(home, '.cursor')] })), true);
    assert.equal(await cursor.detect(fakeSystem({ platform: 'linux', dirs: ['/Applications/Cursor.app'] })), false);
});

test('fresh install clones this repo as a local plugin', async () => {
    const system = fakeSystem({ bins: ['git'] }),
        outcome = await cursor.install(system);

    assert.equal(outcome.outcome, 'done');
    assert.deepEqual(system.commands, [`git clone --depth 1 ${GIT_URL} ${local}`]);
});

test('re-run fast-forwards an existing clone of this repo', async () => {
    const system = fakeSystem({ bins: ['git'], dirs: [path.join(local, '.git')], probes: origin(GIT_URL) });

    assert.equal((await cursor.install(system)).message, `updated ${local}`);
    assert.deepEqual(system.commands, [`git -C ${local} pull --ff-only`]);
});

test('skips when the Cursor Marketplace copy is installed, so skills do not load twice', async () => {
    const system = fakeSystem({ bins: ['git'], dirs: [marketplaceCopy] });

    assert.equal((await cursor.install(system)).outcome, 'skipped');
    assert.deepEqual(system.commands, []);
});

test('refuses a directory at the clone path that is not our clone', async () => {
    const notGit = fakeSystem({ bins: ['git'], dirs: [local] }),
        otherRepo = fakeSystem({ bins: ['git'], dirs: [path.join(local, '.git')], probes: origin('https://github.com/someone/fork.git') });

    assert.equal((await cursor.install(notGit)).outcome, 'blocked');
    assert.match((await cursor.install(otherRepo)).message, /someone\/fork/);
    assert.deepEqual([...notGit.commands, ...otherRepo.commands], []);
});

test('blocks without git', async () => {
    const outcome = await cursor.install(fakeSystem());

    assert.equal(outcome.outcome, 'blocked');
    assert.match(outcome.message, /git is not on PATH/);
});

test('remove deletes our clone', async () => {
    const system = fakeSystem({ bins: ['git'], dirs: [path.join(local, '.git')], probes: origin(GIT_URL) });

    assert.equal((await cursor.remove(system)).outcome, 'done');
    assert.deepEqual(system.commands, [`remove ${local}`]);
});

test('remove hands a Marketplace install back to Cursor', async () => {
    const system = fakeSystem({ dirs: [marketplaceCopy] });

    assert.equal((await cursor.remove(system)).outcome, 'manual');
    assert.deepEqual(system.commands, []);
});
