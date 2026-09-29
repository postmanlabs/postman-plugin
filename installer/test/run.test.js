import assert from 'node:assert/strict';
import test from 'node:test';
import { run } from '../dist/run.js';
import { fakeSystem } from './fake-system.js';

function fakeHost (id, { detected = true, installed = false, install, remove } = {}) {
    const host = {
        id,
        name: id,
        route: id,
        calls: [],
        installed,
        async detect () {
            return detected;
        },
        async status () {
            return { installed: host.installed, detail: host.installed ? 'installed' : 'not installed', notes: [] };
        },
        async install () {
            host.calls.push('install');

            if (install) {
                return install(host);
            }

            host.installed = true;

            return { outcome: 'done', message: 'installed' };
        },
        async remove () {
            host.calls.push('remove');

            return remove ? remove(host) : { outcome: 'done', message: 'removed' };
        }
    };

    return host;
}

const options = (overrides = {}) => ({
    command: 'install', agents: [], yes: true, isTTY: false, confirm: async () => true, ...overrides
});

test('installs into every detected host and nothing else', async () => {
    const a = fakeHost('a'),
        missing = fakeHost('missing', { detected: false });

    assert.equal(await run(fakeSystem(), [a, missing], options()), 0);
    assert.deepEqual(a.calls, ['install']);
    assert.deepEqual(missing.calls, []);
});

test('--agent limits the run, and a requested host that is missing fails it', async () => {
    const a = fakeHost('a'),
        b = fakeHost('b'),
        missing = fakeHost('missing', { detected: false });

    assert.equal(await run(fakeSystem(), [a, b, missing], options({ agents: ['b', 'missing'] })), 1);
    assert.deepEqual(a.calls, []);
    assert.deepEqual(b.calls, ['install']);
});

test('without --yes and without a terminal, refuses instead of silently doing nothing', async () => {
    const a = fakeHost('a'),
        system = fakeSystem();

    assert.equal(await run(system, [a], options({ yes: false })), 2);
    assert.deepEqual(a.calls, []);
    assert.ok(system.lines.some((line) => line.includes('--yes')));
});

test('asks once in a terminal, and a "no" changes nothing', async () => {
    const a = fakeHost('a'),
        b = fakeHost('b'),
        questions = [];

    assert.equal(await run(fakeSystem(), [a, b], options({
        yes: false, isTTY: true, confirm: async (question) => { questions.push(question); return false; }
    })), 1);
    assert.equal(questions.length, 1);
    assert.match(questions[0], /Install or update Postman in a and b\?/);
    assert.deepEqual([...a.calls, ...b.calls], []);
});

test('a dry run needs no confirmation', async () => {
    const a = fakeHost('a');

    assert.equal(await run(fakeSystem({ dryRun: true }), [a], options({ yes: false })), 0);
    assert.deepEqual(a.calls, ['install']);
});

test('a host that reports done but still is not installed counts as failed', async () => {
    const liar = fakeHost('liar', { install: () => ({ outcome: 'done', message: 'installed' }) });

    assert.equal(await run(fakeSystem(), [liar], options()), 1);
});

test('one host failing or throwing does not stop the others', async () => {
    const thrower = fakeHost('thrower', { install: () => { throw new Error('boom'); } }),
        after = fakeHost('after'),
        system = fakeSystem();

    assert.equal(await run(system, [thrower, after], options()), 1);
    assert.deepEqual(after.calls, ['install']);
    assert.ok(system.lines.some((line) => line.includes('failed') && line.includes('boom')));
});

test('skipped and manual outcomes do not fail the run', async () => {
    const skipped = fakeHost('skipped', { install: () => ({ outcome: 'skipped', message: 'already there' }) }),
        manual = fakeHost('manual', { install: () => ({ outcome: 'manual', message: 'do it yourself' }) });

    assert.equal(await run(fakeSystem(), [skipped, manual], options()), 0);
});

test('remove only touches hosts that have it installed', async () => {
    const installed = fakeHost('installed', { installed: true }),
        absent = fakeHost('absent');

    assert.equal(await run(fakeSystem(), [installed, absent], options({ command: 'remove' })), 0);
    assert.deepEqual(installed.calls, ['remove']);
    assert.deepEqual(absent.calls, []);
});

test('status changes nothing', async () => {
    const a = fakeHost('a');

    assert.equal(await run(fakeSystem(), [a], options({ command: 'status' })), 0);
    assert.deepEqual(a.calls, []);
});

test('finding no agent at all is not an error', async () => {
    const system = fakeSystem();

    assert.equal(await run(system, [fakeHost('a', { detected: false })], options()), 0);
    assert.match(system.lines[0], /No supported coding agent found/);
});
