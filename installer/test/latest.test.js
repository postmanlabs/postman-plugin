import assert from 'node:assert/strict';
import test from 'node:test';
import { isNewer, noteNewerRelease, wantsReleaseCheck } from '../dist/latest.js';
import { fakeSystem } from './fake-system.js';

const VIEW = 'npm view @postman/postman-plugin@latest version --fetch-retries=0 --fetch-timeout=3000';

test('a later release, or the release of the candidate this is, counts as newer', () => {
    assert.ok(isNewer('0.7.0', '0.6.0'));
    assert.ok(isNewer('0.10.0', '0.9.3'));
    assert.ok(isNewer('1.0.0', '0.99.99'));
    assert.ok(isNewer('0.7.0', '0.7.0-rc.1'));
    assert.ok(!isNewer('0.6.0', '0.6.0'));
    assert.ok(!isNewer('0.6.0', '0.7.0-rc.0'), 'a candidate ahead of latest is not told to go back');
    assert.ok(!isNewer('', '0.6.0'));
    assert.ok(!isNewer('npm ERR! 404', '0.6.0'));
});

test('an older copy says which command runs the latest release', async () => {
    const system = fakeSystem({ probes: { [VIEW]: '0.7.0\n' } });

    await noteNewerRelease(system, '0.6.0', ['remove']);

    assert.deepEqual(system.lines, ['note: this is @postman/postman-plugin 0.6.0, and 0.7.0 is out. To use it, run `npx @postman/postman-plugin@latest remove`.\n']);
});

test('the suggested command keeps the agents and flags it was run with', async () => {
    const system = fakeSystem({ probes: { [VIEW]: '0.7.0\n' } });

    await noteNewerRelease(system, '0.6.0', ['remove', '--agent', 'codex', '--dry-run']);
    await noteNewerRelease(system, '0.6.0', []);

    assert.match(system.lines[0], /run `npx @postman\/postman-plugin@latest remove --agent codex --dry-run`\.$/m);
    assert.match(system.lines[1], /run `npx @postman\/postman-plugin@latest`\.$/m);
});

test('stays quiet when up to date, offline, or the registry answers nonsense', async () => {
    for (const reply of ['0.6.0\n', { code: 1, stderr: 'ENOTFOUND' }, 'not a version']) {
        const system = fakeSystem({ probes: { [VIEW]: reply } });

        await noteNewerRelease(system, '0.6.0', []);
        assert.deepEqual(system.lines, [], JSON.stringify(reply));
    }
});

test('checks the registry only at a terminal, outside CI and unless NO_UPDATE_NOTIFIER is set', () => {
    assert.ok(wantsReleaseCheck({}, true));
    assert.ok(!wantsReleaseCheck({}, false));
    assert.ok(!wantsReleaseCheck({ CI: 'true' }, true));
    assert.ok(!wantsReleaseCheck({ NO_UPDATE_NOTIFIER: '1' }, true));
});
