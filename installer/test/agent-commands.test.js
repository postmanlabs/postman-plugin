import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { AGENT_COMMANDS, commandsFor } from '../dist/agent-commands.js';
import { HOSTS } from '../dist/hosts/index.js';
import { fakeSystem } from './fake-system.js';

test('the published constants cover every installer host exactly once', () => {
    assert.deepEqual(AGENT_COMMANDS.map((entry) => entry.id), HOSTS.map((host) => host.id));
    assert.equal(new Set(AGENT_COMMANDS.map((entry) => entry.id)).size, HOSTS.length);
    assert.deepEqual(JSON.parse(fs.readFileSync(new URL('../dist/agent-commands.json', import.meta.url), 'utf8')), AGENT_COMMANDS);
    for (const entry of AGENT_COMMANDS) {
        assert.equal(commandsFor(entry.id), entry.commands);
        if (!entry.native) {
            assert.equal(typeof entry.limitations.install, 'string');
            assert.equal(typeof entry.limitations.remove, 'string');
        }
    }
});

for (const entry of AGENT_COMMANDS.filter((agent) => agent.native)) {
    test(`${entry.id} fresh install uses its shared command arguments`, async () => {
        const system = fakeSystem({
            bins: [entry.executable],
            probes: {
                'agy plugin list --json': '[]',
                'claude plugin list --json': '[]',
                'claude plugin marketplace list --json': '[]',
                'codex plugin list --json': '{"installed":[]}',
                'codex plugin marketplace list --json': '{"marketplaces":[]}',
                'copilot plugin list --json': '[]',
                'copilot plugin marketplace list --json': '[]',
                'droid plugin list --scope user': 'No plugins installed',
                'droid plugin marketplace list': 'No marketplaces registered'
            }
        });
        const outcome = await HOSTS.find((host) => host.id === entry.id).install(system);

        assert.equal(outcome.outcome, 'done');
        assert.ok(system.commands.includes([entry.executable, ...entry.commands.install].join(' ')));
        if (entry.marketplace) {
            assert.ok(system.commands.includes([entry.executable, ...entry.commands.addMarketplace].join(' ')));
        }
    });
}
