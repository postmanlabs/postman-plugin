import assert from 'node:assert/strict';
import test from 'node:test';
import { claudeCode } from '../dist/hosts/claude-code.js';
import { fakeSystem } from './fake-system.js';

const MARKETPLACES = 'claude plugin marketplace list --json',
    PLUGINS = 'claude plugin list --json',
    official = { name: 'claude-plugins-official', source: 'github', repo: 'anthropics/claude-plugins-official' },
    plugin = (id, scope = 'user', extra = {}) => ({ id, scope, version: '2.0.1', ...extra });

function claude ({ marketplaces = [official], plugins = [], runs = {} } = {}) {
    return fakeSystem({
        bins: ['claude'],
        probes: { [MARKETPLACES]: JSON.stringify(marketplaces), [PLUGINS]: JSON.stringify(plugins) },
        runs
    });
}

test('detects Claude Code by its CLI on PATH', async () => {
    assert.equal(await claudeCode.detect(claude()), true);
    assert.equal(await claudeCode.detect(fakeSystem()), false);
});

test('fresh install adds Anthropic\'s marketplace, then installs from it at user scope', async () => {
    const system = claude({ marketplaces: [] }),
        outcome = await claudeCode.install(system);

    assert.equal(outcome.outcome, 'done');
    assert.deepEqual(system.commands, [
        'claude plugin marketplace add anthropics/claude-plugins-official --scope user',
        'claude plugin install postman@claude-plugins-official --scope user --json'
    ]);
});

test('re-run refreshes the marketplace and updates instead of installing', async () => {
    const system = claude({ plugins: [plugin('postman@claude-plugins-official')] }),
        outcome = await claudeCode.install(system);

    assert.equal(outcome.message, 'updated postman@claude-plugins-official');
    assert.deepEqual(system.commands, [
        'claude plugin marketplace update claude-plugins-official',
        'claude plugin update postman@claude-plugins-official --scope user --json'
    ]);
});

test('installs the official copy, then uninstalls our own marketplace copy at user scope', async () => {
    const system = claude({ plugins: [plugin('postman@postman')] });

    await claudeCode.install(system);

    assert.deepEqual(system.commands, [
        'claude plugin marketplace update claude-plugins-official',
        'claude plugin install postman@claude-plugins-official --scope user --json',
        'claude plugin uninstall postman@postman --scope user --json'
    ]);
});

test('a failed install leaves our own marketplace copy in place, so Postman still works', async () => {
    const system = claude({
            plugins: [plugin('postman@postman')],
            runs: { 'claude plugin install postman@claude-plugins-official --scope user --json': { code: 1, stderr: 'network down' } }
        }),
        outcome = await claudeCode.install(system);

    assert.equal(outcome.outcome, 'failed');
    assert.ok(!system.commands.some((command) => command.includes('uninstall')));
});

test('leaves project and local scope copies alone and says so', async () => {
    const plugins = [
            plugin('postman@postman', 'local', { projectPath: '/work/a' }),
            plugin('postman@claude-plugins-official', 'project', { projectPath: '/work/b' }),
            plugin('postman@claude-plugins-official', 'local', { projectPath: '/work/b' })
        ],
        system = claude({ plugins }),
        status = await claudeCode.status(system);

    await claudeCode.install(system);

    assert.equal(status.installed, false);
    assert.deepEqual(status.notes, [
        'postman@postman is also installed at project or local scope in 1 project; left alone',
        'postman@claude-plugins-official is also installed at project or local scope in 1 project; left alone'
    ]);
    assert.ok(!system.commands.some((command) => command.includes('uninstall')));
});

test('refuses to use a claude-plugins-official marketplace registered from somewhere else', async () => {
    const system = claude({ marketplaces: [{ ...official, repo: 'someone/fork' }] }),
        outcome = await claudeCode.install(system);

    assert.equal(outcome.outcome, 'blocked');
    assert.match(outcome.message, /someone\/fork/);
    assert.deepEqual(system.commands, []);
});

test('a failed command reports its output and stops', async () => {
    const system = claude({
            runs: { 'claude plugin marketplace update claude-plugins-official': { code: 1, stderr: 'network down' } }
        }),
        outcome = await claudeCode.install(system);

    assert.equal(outcome.outcome, 'failed');
    assert.match(outcome.message, /exited 1\nnetwork down/);
    assert.equal(system.commands.length, 1);
});

test('an unreadable listing is unknown, not "not installed"', async () => {
    const system = fakeSystem({ bins: ['claude'], probes: { [PLUGINS]: 'Error: not JSON' } });

    assert.equal((await claudeCode.status(system)).installed, null);
    assert.equal((await claudeCode.install(system)).outcome, 'failed');
});

test('remove uninstalls every user-scope copy', async () => {
    const system = claude({ plugins: [plugin('postman@claude-plugins-official'), plugin('postman@postman')] }),
        outcome = await claudeCode.remove(system);

    assert.equal(outcome.outcome, 'done');
    assert.deepEqual(system.commands, [
        'claude plugin uninstall postman@claude-plugins-official --scope user --json',
        'claude plugin uninstall postman@postman --scope user --json'
    ]);
});

test('remove skips when nothing is installed at user scope', async () => {
    const system = claude({ plugins: [plugin('postman@claude-plugins-official', 'local')] });

    assert.equal((await claudeCode.remove(system)).outcome, 'skipped');
    assert.deepEqual(system.commands, []);
});
