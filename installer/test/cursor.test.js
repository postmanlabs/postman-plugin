import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { cursor } from '../dist/hosts/cursor.js';
import { fakeSystem } from './fake-system.js';

const home = '/home/user',
    local = path.join(home, '.cursor', 'plugins', 'local', 'postman'),
    marketplaceCopy = path.join(home, '.cursor', 'plugins', 'cache', 'cursor-public', 'postman'),
    GIT_URL = 'https://github.com/postmanlabs/postman-plugin.git',
    origin = (url, { ahead = '0' } = {}) => ({
        [`git -C ${local} remote get-url origin`]: `${url}\n`,
        [`git -C ${local} symbolic-ref --short HEAD`]: 'main\n',
        [`git -C ${local} status --porcelain`]: '',
        [`git -C ${local} rev-list --count origin/main..HEAD`]: `${ahead}\n`
    }),
    manifest = path.join(local, '.cursor-plugin', 'plugin.json');

test('detects Cursor by its app\'s command, its CLI, its app bundle on macOS, or its config directory', async () => {
    assert.equal(await cursor.detect(fakeSystem({ bins: ['cursor'] })), true);
    assert.equal(await cursor.detect(fakeSystem({ bins: ['cursor-agent'] })), true);
    assert.equal(await cursor.detect(fakeSystem({ bins: ['agent'] })), false);
    assert.equal(await cursor.detect(fakeSystem({ platform: 'darwin', dirs: ['/Applications/Cursor.app'] })), true);
    assert.equal(await cursor.detect(fakeSystem({ dirs: [path.join(home, '.cursor')] })), true);
    assert.equal(await cursor.detect(fakeSystem({ platform: 'linux', dirs: ['/Applications/Cursor.app'] })), false);
});

test('fresh install clones this repo as a local plugin', async () => {
    const system = fakeSystem({ bins: ['git'] }),
        outcome = await cursor.install(system);

    assert.equal(outcome.outcome, 'done');
    assert.match(outcome.next, /Reload Window.*new Cursor CLI session/);
    assert.deepEqual(system.commands, [`git clone --depth 1 --branch main ${GIT_URL} ${local}`]);
});

test('re-run fast-forwards an existing clone of this repo', async () => {
    const system = fakeSystem({ bins: ['git'], dirs: [path.join(local, '.git')], probes: origin(GIT_URL) });

    assert.equal((await cursor.install(system)).message, `updated ${local}`);
    assert.deepEqual(system.commands, [`git -C ${local} pull --ff-only origin main`]);
});

test('skips when the Cursor Marketplace copy is present, and says how to check it is enabled', async () => {
    const system = fakeSystem({ bins: ['git'], dirs: [marketplaceCopy] }),
        outcome = await cursor.install(system);

    assert.equal(outcome.outcome, 'skipped');
    assert.match(outcome.next, /enable it in Cursor Settings > Plugins/);
    assert.deepEqual(system.commands, []);
});

test('refuses a directory at the clone path that is not our clone', async () => {
    const notGit = fakeSystem({ bins: ['git'], dirs: [local] }),
        otherRepo = fakeSystem({ bins: ['git'], dirs: [path.join(local, '.git')], probes: origin('https://github.com/someone/fork.git') });

    assert.equal((await cursor.install(notGit)).outcome, 'blocked');
    assert.match((await cursor.install(otherRepo)).message, /someone\/fork/);
    assert.deepEqual([...notGit.commands, ...otherRepo.commands], []);
});

test('a refusal names the other remote without the token in its URL', async () => {
    const system = fakeSystem({
            bins: ['git'], dirs: [path.join(local, '.git')], probes: origin('https://x-access-token:ghp_secret@github.com/someone/fork.git')
        }),
        { message } = await cursor.install(system);

    assert.match(message, /https:\/\/github\.com\/someone\/fork\.git/);
    assert.doesNotMatch(message, /ghp_secret|x-access-token/);
});

test('install keeps and updates our clone next to a Marketplace copy that may be disabled', async () => {
    const system = fakeSystem({ bins: ['git'], dirs: [path.join(local, '.git'), marketplaceCopy], probes: origin(GIT_URL) }),
        outcome = await cursor.install(system);

    assert.equal(outcome.outcome, 'done');
    assert.match(outcome.next, /if it's enabled, Postman loads twice/);
    assert.deepEqual(system.commands, [`git -C ${local} pull --ff-only origin main`]);
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

test('remove deletes nothing when the clone has commits that are not on origin/main', async () => {
    const system = fakeSystem({ bins: ['git'], dirs: [path.join(local, '.git')], probes: origin(GIT_URL, { ahead: '2' }) }),
        outcome = await cursor.remove(system);

    assert.equal(outcome.outcome, 'blocked');
    assert.match(outcome.message, /commits that aren't on origin\/main/);
    assert.deepEqual(system.commands, []);
});

test('a directory at the clone path counts as installed only if it holds a Cursor plugin', async () => {
    const empty = await cursor.status(fakeSystem({ dirs: [local] })),
        plugin = await cursor.status(fakeSystem({ dirs: [local, manifest] }));

    assert.equal(empty.installed, false);
    assert.match(empty.notes[0], /no \.cursor-plugin\/plugin\.json/);
    assert.equal(plugin.installed, true);
});

test('remove hands a Marketplace install back to Cursor', async () => {
    const system = fakeSystem({ dirs: [marketplaceCopy] });

    assert.equal((await cursor.remove(system)).outcome, 'manual');
    assert.deepEqual(system.commands, []);
});

test('remove with both copies deletes the clone and still reports the Marketplace copy', async () => {
    const system = fakeSystem({ bins: ['git'], dirs: [path.join(local, '.git'), marketplaceCopy], probes: origin(GIT_URL) }),
        outcome = await cursor.remove(system);

    assert.equal(outcome.outcome, 'manual');
    assert.match(outcome.message, /Marketplace copy is still installed/);
    assert.deepEqual(system.commands, [`remove ${local}`]);
});
