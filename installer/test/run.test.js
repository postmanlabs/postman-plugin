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

            if (remove) {
                return remove(host);
            }

            host.installed = false;

            return { outcome: 'done', message: 'removed' };
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

test('an install whose status cannot be read afterwards is not counted as done', async () => {
    const unreadable = fakeHost('unreadable', { install: (host) => { host.installed = null; return { outcome: 'done', message: 'installed' }; } }),
        system = fakeSystem();

    assert.equal(await run(system, [unreadable], options()), 1);
    assert.ok(system.lines.some((line) => line.includes('could not be confirmed')));
});

test('one host failing or throwing does not stop the others', async () => {
    const thrower = fakeHost('thrower', { install: () => { throw new Error('boom'); } }),
        after = fakeHost('after'),
        system = fakeSystem();

    assert.equal(await run(system, [thrower, after], options()), 1);
    assert.deepEqual(after.calls, ['install']);
    assert.ok(system.lines.some((line) => line.includes('failed') && line.includes('boom')));
});

test('a remove that reports done but leaves it installed counts as failed', async () => {
    const noop = fakeHost('noop', { installed: true, remove: () => ({ outcome: 'done', message: 'removed' }) }),
        system = fakeSystem();

    assert.equal(await run(system, [noop], options({ command: 'remove' })), 1);
    assert.ok(system.lines.some((line) => line.includes('still reports it as installed')));
});

test('a remove whose status cannot be read afterwards is not counted as done', async () => {
    const unreadable = fakeHost('unreadable', {
        installed: true, remove: (host) => { host.installed = null; return { outcome: 'done', message: 'removed' }; }
    });

    assert.equal(await run(fakeSystem(), [unreadable], options({ command: 'remove' })), 1);
});

test('a skipped host does not fail the run', async () => {
    const skipped = fakeHost('skipped', { install: () => ({ outcome: 'skipped', message: 'already there' }) });

    assert.equal(await run(fakeSystem(), [skipped], options()), 0);
});

test('a manual step left for the user fails the run, so a script can tell', async () => {
    const manual = fakeHost('manual', { installed: true, remove: () => ({ outcome: 'manual', message: 'do it yourself' }) });

    assert.equal(await run(fakeSystem(), [manual], options({ command: 'remove' })), 1);
});

test('remove reaches every detected host, even one whose status says not installed', async () => {
    const installed = fakeHost('installed', { installed: true }),
        duplicateOnly = fakeHost('duplicate-only', { remove: () => ({ outcome: 'done', message: 'removed a duplicate' }) }),
        absent = fakeHost('absent', { remove: () => ({ outcome: 'skipped', message: 'not installed' }) }),
        missing = fakeHost('missing', { detected: false });

    assert.equal(await run(fakeSystem(), [installed, duplicateOnly, absent, missing], options({ command: 'remove' })), 0);
    assert.deepEqual([installed.calls, duplicateOnly.calls, absent.calls, missing.calls], [['remove'], ['remove'], ['remove'], []]);
});

test('a host whose status throws is reported unknown, and the run goes on', async () => {
    const broken = fakeHost('broken'),
        after = fakeHost('after'),
        system = fakeSystem();

    broken.status = async () => { throw new Error('EACCES: permission denied'); };

    assert.equal(await run(system, [broken, after], options({ command: 'status' })), 0);
    assert.ok(system.lines.some((line) => line.includes('broken') && line.includes('unknown') && line.includes('EACCES')));
    assert.ok(system.lines.some((line) => line.includes('after')));
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
