import assert from 'node:assert/strict';
import test from 'node:test';
import { HOSTS } from '../dist/hosts/index.js';
import { MINIMUM_VERSIONS, parseVersion, versionWarning } from '../dist/hosts/minimum-versions.js';
import { fakeSystem } from './fake-system.js';

const host = (id) => HOSTS.find((candidate) => candidate.id === id);

test('every minimum names a real host and parses as x.y.z', () => {
    for (const [id, { minimum }] of Object.entries(MINIMUM_VERSIONS)) {
        assert.ok(host(id), `${id} is not a host`);
        assert.ok(parseVersion(minimum), `${id}'s minimum ${minimum} does not parse`);
    }
});

// Each agent's real `--version` output, with the version set just below and at its minimum.
const FORMATS = {
    'claude-code': { command: 'claude --version', old: '2.1.267 (Claude Code)', current: '2.1.268 (Claude Code)' },
    codex: { command: 'codex --version', old: 'codex-cli 0.138.0', current: 'codex-cli 0.139.0' },
    opencode: { command: 'opencode --version', old: '1.18.31', current: 'opencode v2.0.18' },
    pi: { command: 'pi --version', old: '0.87.1', current: '0.99.0' }
};

test('every checked host has its real --version format covered here', () => {
    assert.deepEqual(Object.keys(FORMATS).sort(), Object.keys(MINIMUM_VERSIONS).sort());
});

for (const [id, { command, old, current }] of Object.entries(FORMATS)) {
    test(`${id}: warns below the minimum and not at it`, async () => {
        const warning = await versionWarning(fakeSystem({ probes: { [command]: `${old}\n` } }), host(id));

        assert.match(warning, new RegExp(`^${host(id).name} ${parseVersion(old).join('\\.')} is older than ${MINIMUM_VERSIONS[id].minimum}, `));
        assert.equal(await versionWarning(fakeSystem({ probes: { [command]: `${current}\n` } }), host(id)), null);
    });
}

test('compares each part as a number, not as text', async () => {
    const claude = host('claude-code');

    assert.equal(await versionWarning(fakeSystem({ probes: { 'claude --version': '2.10.0 (Claude Code)' } }), claude), null);
    assert.equal(await versionWarning(fakeSystem({ probes: { 'claude --version': '10.0.0 (Claude Code)' } }), claude), null);
    assert.ok(await versionWarning(fakeSystem({ probes: { 'claude --version': '2.1.99 (Claude Code)' } }), claude));
});

test('says nothing when the version cannot be read', async () => {
    const claude = host('claude-code'),
        unreadable = [
            fakeSystem(),
            fakeSystem({ probes: { 'claude --version': { code: 127, stderr: 'not found' } } }),
            fakeSystem({ probes: { 'claude --version': 'Claude Code (development build)' } })
        ];

    for (const system of unreadable) {
        assert.equal(await versionWarning(system, claude), null);
    }

    const throwing = fakeSystem();

    throwing.probe = async () => { throw new Error('EACCES'); };
    assert.equal(await versionWarning(throwing, claude), null);
});

test('an agent with no minimum is never probed', async () => {
    const system = fakeSystem(),
        probed = [];

    system.probe = async (command, args) => { probed.push([command, ...args].join(' ')); return { code: 0, stdout: '0.0.1', stderr: '' }; };

    for (const unchecked of HOSTS.filter((candidate) => !MINIMUM_VERSIONS[candidate.id])) {
        assert.equal(await versionWarning(system, unchecked), null);
    }

    assert.deepEqual(probed, []);
});
