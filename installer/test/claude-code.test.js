import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { claudeCode } from '../dist/hosts/claude-code.js';
import { fakeSystem } from './fake-system.js';

const MARKETPLACES = 'claude plugin marketplace list --json',
    PLUGINS = 'claude plugin list --json',
    ADD = 'claude plugin marketplace add postmanlabs/postman-plugin --scope user',
    SETTINGS = path.join('/home/user', '.claude', 'settings.json'),
    ours = { name: 'postman', source: 'github', repo: 'postmanlabs/postman-plugin' },
    official = { name: 'claude-plugins-official', source: 'github', repo: 'anthropics/claude-plugins-official' },
    byUrl = (url, source = 'git') => ({ name: 'postman', source, url }),
    plugin = (id, scope = 'user', extra = {}) => ({ id, scope, version: '2.0.1', ...extra }),
    declared = (entry = {}) => JSON.stringify({
        enabledPlugins: { 'postman@postman': true },
        extraKnownMarketplaces: { postman: { source: { source: 'github', repo: 'postmanlabs/postman-plugin' }, ...entry } }
    }, null, 2);

function claude ({ marketplaces = [ours], plugins = [], runs = {}, files = { [SETTINGS]: declared() }, env, dryRun } = {}) {
    return fakeSystem({
        bins: ['claude'],
        env,
        dryRun,
        files,
        probes: { [MARKETPLACES]: JSON.stringify(marketplaces), [PLUGINS]: JSON.stringify(plugins) },
        // `marketplace add` records the marketplace in user settings, as the real CLI does.
        runs: { [ADD]: (fake) => { fake.files[SETTINGS] = declared(); return ''; }, ...runs }
    });
}

const autoUpdate = (system, file = SETTINGS) => JSON.parse(system.files[file]).extraKnownMarketplaces.postman.autoUpdate;

test('detects Claude Code by its CLI on PATH', async () => {
    assert.equal(await claudeCode.detect(claude()), true);
    assert.equal(await claudeCode.detect(fakeSystem()), false);
});

test('fresh install adds this repo\'s marketplace, installs from it at user scope and turns on its auto-update', async () => {
    const system = claude({ marketplaces: [official], files: {} }),
        outcome = await claudeCode.install(system);

    assert.equal(outcome.outcome, 'done');
    assert.equal(outcome.message, 'installed postman@postman, auto-update on');
    assert.deepEqual(system.commands, [
        ADD,
        'claude plugin install postman@postman --scope user --json',
        `write ${SETTINGS}`
    ]);
    assert.equal(autoUpdate(system), true);
});

test('turning on auto-update keeps every other setting', async () => {
    const settings = JSON.parse(declared());

    settings.theme = 'dark';
    settings.enabledPlugins['other@elsewhere'] = false;

    const system = claude({ files: { [SETTINGS]: JSON.stringify(settings) } });

    await claudeCode.install(system);

    const written = JSON.parse(system.files[SETTINGS]);

    assert.equal(written.theme, 'dark');
    assert.equal(written.enabledPlugins['other@elsewhere'], false);
    assert.deepEqual(written.extraKnownMarketplaces.postman.source, { source: 'github', repo: 'postmanlabs/postman-plugin' });
});

test('writes auto-update to CLAUDE_CONFIG_DIR when it is set', async () => {
    const file = path.join('/cfg', 'settings.json'),
        system = claude({ env: { CLAUDE_CONFIG_DIR: '/cfg' }, files: { [file]: declared() } });

    await claudeCode.install(system);

    assert.equal(autoUpdate(system, file), true);
    assert.ok(!(SETTINGS in system.files));
});

test('keeps an auto-update choice the user already made, and says how to turn it back on', async () => {
    const off = claude({ files: { [SETTINGS]: declared({ autoUpdate: false }) } }),
        on = claude({ files: { [SETTINGS]: declared({ autoUpdate: true }) } });

    assert.equal((await claudeCode.install(off)).message, 'installed postman@postman');
    assert.equal(autoUpdate(off), false);
    assert.match(off.lines.join('\n'), /auto-update for postman is off .*\/plugin → Marketplaces/);
    assert.equal((await claudeCode.install(on)).message, 'installed postman@postman, auto-update on');
    for (const system of [off, on]) {
        assert.ok(!system.commands.some((command) => command.startsWith('write ')));
    }
});

test('a settings file it can\'t read as JSON is left alone, and the install still succeeds', async () => {
    const system = claude({ files: { [SETTINGS]: '{ "theme": "dark", // a comment\n}' } }),
        outcome = await claudeCode.install(system);

    assert.equal(outcome.outcome, 'done');
    assert.equal(outcome.message, 'installed postman@postman');
    assert.match(system.lines.join('\n'), /could not turn on auto-update in .*settings\.json; turn it on under \/plugin/);
    assert.ok(!system.commands.some((command) => command.startsWith('write ')));
});

test('a dry run prints the settings write without making it', async () => {
    const system = claude({ dryRun: true }),
        before = system.files[SETTINGS];

    await claudeCode.install(system);

    assert.ok(system.commands.includes(`write ${SETTINGS}`));
    assert.equal(system.files[SETTINGS], before);
});

test('re-run refreshes the marketplace and updates instead of installing', async () => {
    const system = claude({ plugins: [plugin('postman@postman')], files: { [SETTINGS]: declared({ autoUpdate: true }) } }),
        outcome = await claudeCode.install(system);

    assert.equal(outcome.message, 'updated postman@postman, auto-update on');
    assert.deepEqual(system.commands, [
        'claude plugin marketplace update postman',
        'claude plugin update postman@postman --scope user --json'
    ]);
});

test('moves an install from Anthropic\'s marketplace: installs ours, then uninstalls the official copy at user scope', async () => {
    const system = claude({ marketplaces: [official], plugins: [plugin('postman@claude-plugins-official')], files: {} });

    await claudeCode.install(system);

    assert.deepEqual(system.commands, [
        ADD,
        'claude plugin install postman@postman --scope user --json',
        'claude plugin uninstall postman@claude-plugins-official --scope user --json',
        `write ${SETTINGS}`
    ]);
    assert.ok(!system.commands.some((command) => command.includes('marketplace remove')));
});

test('a failed install leaves the official copy in place, so Postman still works', async () => {
    const system = claude({
            plugins: [plugin('postman@claude-plugins-official')],
            runs: { 'claude plugin install postman@postman --scope user --json': { code: 1, stderr: 'network down' } }
        }),
        outcome = await claudeCode.install(system);

    assert.equal(outcome.outcome, 'failed');
    assert.ok(!system.commands.some((command) => command.includes('uninstall')));
});

test('leaves project and local scope copies alone and says so', async () => {
    const plugins = [
            plugin('postman@claude-plugins-official', 'local', { projectPath: '/work/a' }),
            plugin('postman@postman', 'project', { projectPath: '/work/b' }),
            plugin('postman@postman', 'local', { projectPath: '/work/b' })
        ],
        system = claude({ plugins }),
        status = await claudeCode.status(system);

    await claudeCode.install(system);

    assert.equal(status.installed, false);
    assert.deepEqual(status.notes, [
        'postman@claude-plugins-official is also installed at project or local scope in 1 project; left alone',
        'postman@postman is also installed at project or local scope in 1 project; left alone'
    ]);
    assert.ok(!system.commands.some((command) => command.includes('uninstall')));
});

test('status reports our copy as installed and the official copy as the duplicate it will uninstall', async () => {
    const status = await claudeCode.status(claude({ plugins: [plugin('postman@postman'), plugin('postman@claude-plugins-official')] }));

    assert.equal(status.installed, true);
    assert.equal(status.detail, 'postman@postman 2.0.1');
    assert.deepEqual(status.notes, ['postman@claude-plugins-official (user scope) duplicates it and will be uninstalled']);
});

test('refuses to use a postman marketplace registered from somewhere else', async () => {
    const system = claude({ marketplaces: [{ ...ours, repo: 'someone/fork' }] }),
        outcome = await claudeCode.install(system);

    assert.equal(outcome.outcome, 'blocked');
    assert.match(outcome.message, /someone\/fork/);
    assert.deepEqual(system.commands, []);
});

test('accepts our marketplace registered by repo, HTTPS URL with or without .git, or SSH', async () => {
    for (const marketplace of [
        ours,
        byUrl('https://github.com/postmanlabs/postman-plugin.git'),
        byUrl('https://github.com/postmanlabs/postman-plugin'),
        byUrl('git@github.com:postmanlabs/postman-plugin.git')
    ]) {
        const system = claude({ marketplaces: [marketplace] });

        assert.equal((await claudeCode.install(system)).outcome, 'done', JSON.stringify(marketplace));
        assert.equal(system.commands[0], 'claude plugin marketplace update postman');
    }
});

test('refuses a git URL to another repo, without printing its credentials', async () => {
    const system = claude({ marketplaces: [byUrl('https://x-access-token:ghp_secret@github.com/someone/fork.git')] }),
        outcome = await claudeCode.install(system);

    assert.equal(outcome.outcome, 'blocked');
    assert.match(outcome.message, /registered from https:\/\/github\.com\/someone\/fork\.git,/);
    assert.doesNotMatch(outcome.message, /ghp_secret/);
    assert.deepEqual(system.commands, []);
});

test('refuses a url source, which fetches one marketplace.json, even at this repo\'s URL', async () => {
    const system = claude({ marketplaces: [byUrl('https://github.com/postmanlabs/postman-plugin', 'url')] });

    assert.equal((await claudeCode.install(system)).outcome, 'blocked');
    assert.deepEqual(system.commands, []);
});

test('a failed command reports its output and stops', async () => {
    const system = claude({
            runs: { 'claude plugin marketplace update postman': { code: 1, stderr: 'network down' } }
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

// Makes the fake `claude plugin uninstall <id>` drop that ID from the listing, as the real CLI does.
function uninstalls (system, ids) {
    for (const id of ids) {
        system.runs[`claude plugin uninstall ${id} --scope user --json`] = (fake) => {
            fake.probes[PLUGINS] = JSON.stringify(JSON.parse(fake.probes[PLUGINS]).filter((entry) => entry.id !== id));

            return '';
        };
    }

    return system;
}

const REMOVE_OURS = 'claude plugin marketplace remove postman --scope user --json';

test('remove uninstalls every user-scope copy, then removes our marketplace', async () => {
    const system = uninstalls(claude({ plugins: [plugin('postman@postman'), plugin('postman@claude-plugins-official')] }),
            ['postman@postman', 'postman@claude-plugins-official']),
        outcome = await claudeCode.remove(system);

    assert.equal(outcome.outcome, 'done');
    assert.equal(outcome.message, 'uninstalled postman@postman, postman@claude-plugins-official and removed marketplace postman');
    assert.deepEqual(system.commands, [
        'claude plugin uninstall postman@postman --scope user --json',
        'claude plugin uninstall postman@claude-plugins-official --scope user --json',
        REMOVE_OURS
    ]);
});

test('remove fails when an uninstall exits 0 but leaves the official copy installed', async () => {
    const system = uninstalls(claude({ plugins: [plugin('postman@postman'), plugin('postman@claude-plugins-official')] }),
            ['postman@postman']),
        outcome = await claudeCode.remove(system);

    assert.equal(outcome.outcome, 'failed');
    assert.match(outcome.message, /postman@claude-plugins-official is still installed/);
});

test('remove skips when nothing is installed at user scope', async () => {
    const system = claude({ marketplaces: [official], plugins: [plugin('postman@postman', 'local')] });

    assert.equal((await claudeCode.remove(system)).outcome, 'skipped');
    assert.deepEqual(system.commands, []);
});

test('remove after an earlier remove still takes out our marketplace, at user scope only', async () => {
    const system = claude({ marketplaces: [official, ours] }),
        outcome = await claudeCode.remove(system);

    assert.equal(outcome.outcome, 'done');
    assert.equal(outcome.message, 'removed marketplace postman');
    assert.deepEqual(system.commands, [REMOVE_OURS]);
});

test('remove keeps our marketplace while a project still installs from it, or when it comes from elsewhere', async () => {
    const project = claude({ plugins: [plugin('postman@postman', 'project', { projectPath: '/work/api' })] }),
        foreign = claude({ marketplaces: [{ name: 'postman', source: 'github', repo: 'someone/postman' }] });

    assert.equal((await claudeCode.remove(project)).outcome, 'skipped');
    assert.match(project.lines.join('\n'), /still serves postman@postman \(\/work\/api\); left alone/);
    assert.equal((await claudeCode.remove(foreign)).outcome, 'skipped');
    assert.match(foreign.lines.join('\n'), /registered from someone\/postman, not postmanlabs\/postman-plugin; left alone/);
    assert.deepEqual([...project.commands, ...foreign.commands], []);
});

test('never removes Anthropic\'s marketplace, which other plugins come from', async () => {
    const system = uninstalls(claude({ marketplaces: [official, ours], plugins: [plugin('postman@claude-plugins-official')] }),
        ['postman@claude-plugins-official']);

    await claudeCode.remove(system);

    assert.ok(!system.commands.some((line) => line.includes('marketplace remove claude-plugins-official')));
});

test('a marketplace declared only in a project is reported, not a failed remove', async () => {
    const system = claude({ runs: { [REMOVE_OURS]: { code: 1, stderr: 'not found in user settings' } } }),
        outcome = await claudeCode.remove(system);

    assert.equal(outcome.outcome, 'skipped');
    assert.match(system.lines.join('\n'), /could not remove marketplace postman from user settings, so it was left alone: not found in user settings/);
});
