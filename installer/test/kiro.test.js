import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { kiro } from '../dist/hosts/kiro.js';
import { fakeSystem } from './fake-system.js';

test('detects Kiro by its command, its app bundle on macOS, or its config directory', async () => {
    assert.equal(await kiro.detect(fakeSystem({ bins: ['kiro'] })), true);
    assert.equal(await kiro.detect(fakeSystem({ platform: 'darwin', dirs: ['/Applications/Kiro.app'] })), true);
    assert.equal(await kiro.detect(fakeSystem({ platform: 'linux', dirs: ['/Applications/Kiro.app'] })), false);
    assert.equal(await kiro.detect(fakeSystem({ dirs: [path.join('/home/user', '.kiro')] })), true);
    assert.equal(await kiro.detect(fakeSystem()), false);
});

test('install hands the user the power URL and runs no command', async () => {
    const system = fakeSystem(),
        outcome = await kiro.install(system);

    assert.equal(outcome.outcome, 'manual');
    assert.ok(outcome.next.includes('https://github.com/postmanlabs/postman-plugin/tree/main/kiro'), outcome.next);
    assert.deepEqual(system.commands, []);
});

test('a re-run gives the same steps, since Kiro updates a power from its panel', async () => {
    assert.deepEqual(await kiro.install(fakeSystem({ dirs: ['/home/user/.kiro'] })), await kiro.install(fakeSystem()));
});

test('remove points at the Powers panel and runs no command', async () => {
    const system = fakeSystem(),
        outcome = await kiro.remove(system);

    assert.equal(outcome.outcome, 'manual');
    assert.match(outcome.next, /Powers panel/);
    assert.deepEqual(system.commands, []);
});

test('status cannot tell whether the power is installed', async () => {
    assert.equal((await kiro.status(fakeSystem())).installed, null);
});
