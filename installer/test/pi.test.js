import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { pi } from '../dist/hosts/pi.js';
import { fakeSystem } from './fake-system.js';

const home = '/home/user',
    settings = path.join(home, '.pi', 'agent', 'settings.json'),
    SOURCE = 'npm:@postman/postman-plugin',
    INSTALL = `pi install ${SOURCE}`,
    UPDATE = `pi update ${SOURCE}`,
    withPackages = (packages, file = settings) => ({ [file]: JSON.stringify({ theme: 'dark', packages }) });

test('detects Pi by its CLI on PATH', async () => {
    assert.equal(await pi.detect(fakeSystem({ bins: ['pi'] })), true);
    assert.equal(await pi.detect(fakeSystem()), false);
});

test('fresh install adds the npm package through pi', async () => {
    const system = fakeSystem({ bins: ['pi'] }),
        outcome = await pi.install(system);

    assert.equal(outcome.outcome, 'done');
    assert.equal(outcome.message, `installed ${SOURCE} in ${settings}`);
    assert.deepEqual(system.commands, [INSTALL]);
});

test('re-run updates the package it finds in Pi\'s settings', async () => {
    const system = fakeSystem({ bins: ['pi'], files: withPackages([SOURCE, 'npm:pi-web-access']) });

    assert.deepEqual(await pi.status(system), { installed: true, detail: `${SOURCE} in ${settings}`, notes: [] });
    assert.match((await pi.install(system)).message, /^updated /);
    assert.deepEqual(system.commands, [UPDATE]);
});

test('reads settings entries in object form and honours PI_CODING_AGENT_DIR', async () => {
    const custom = fakeSystem({ env: { PI_CODING_AGENT_DIR: '/opt/pi' }, files: withPackages([{ source: SOURCE, skills: [] }], path.join('/opt/pi', 'settings.json')) }),
        tilde = fakeSystem({ env: { PI_CODING_AGENT_DIR: '~/pi-agent' }, files: withPackages([SOURCE], path.join(home, 'pi-agent', 'settings.json')) });

    assert.equal((await pi.status(custom)).installed, true);
    assert.equal((await pi.status(tilde)).installed, true);
    assert.equal((await pi.status(fakeSystem({ env: { PI_CODING_AGENT_DIR: '/opt/pi' }, files: withPackages([SOURCE]) }))).installed, false);
});

test('a pinned version is the same package, and is left pinned', async () => {
    const system = fakeSystem({ bins: ['pi'], files: withPackages([`${SOURCE}@0.1.0`]) }),
        status = await pi.status(system);

    assert.equal(status.installed, true);
    assert.match(status.notes[0], /is pinned/);
    await pi.install(system);
    assert.deepEqual(system.commands, [UPDATE]);
});

test('install removes a git install of this repo only after the npm package is in', async () => {
    const clones = [
            'git:github.com/postmanlabs/postman-plugin@v1',
            'https://github.com/postmanlabs/postman-plugin',
            'git:git@github.com:postmanlabs/postman-plugin',
            // Pi's ref runs from the first `@` in the repo path, slashes included.
            'https://github.com/postmanlabs/postman-plugin@feature/branch',
            'git:git@github.com:postmanlabs/postman-plugin@release/1.0',
            'ssh://git@github.com/postmanlabs/postman-plugin@main'
        ],
        others = ['git:github.com/someone/postman-plugin@feature/postmanlabs/postman-plugin', 'https://github.com/postmanlabs/postman-plugin-fork@main', 'npm:postman-plugin'],
        system = fakeSystem({ bins: ['pi'], files: withPackages([...clones, ...others]) });

    assert.equal((await pi.status(system)).notes.length, clones.length);
    assert.equal((await pi.install(system)).outcome, 'done');
    assert.deepEqual(system.commands, [INSTALL, ...clones.map((clone) => `pi remove ${clone}`)]);
});

test('a failed install keeps the git copy', async () => {
    const system = fakeSystem({
            bins: ['pi'],
            files: withPackages(['https://github.com/postmanlabs/postman-plugin']),
            runs: { [INSTALL]: { code: 1, stderr: 'npm error 404' } }
        }),
        outcome = await pi.install(system);

    assert.equal(outcome.outcome, 'failed');
    assert.match(outcome.message, /npm error 404/);
    assert.deepEqual(system.commands, [INSTALL]);
});

test('settings with a byte order mark still parse, as they do in Pi', async () => {
    assert.equal((await pi.status(fakeSystem({ files: { [settings]: `\uFEFF${JSON.stringify({ packages: [SOURCE] })}` } }))).installed, true);
});

test('settings that are not JSON change nothing', async () => {
    const system = fakeSystem({ bins: ['pi'], files: { [settings]: '{ "packages": [' } });

    assert.equal((await pi.status(system)).installed, null);
    assert.equal((await pi.install(system)).outcome, 'failed');
    assert.equal((await pi.remove(system)).outcome, 'failed');
    assert.deepEqual(system.commands, []);
});

test('remove takes out the npm package and any git install of this repo', async () => {
    const system = fakeSystem({ bins: ['pi'], files: withPackages([`${SOURCE}@0.1.0`, 'git:github.com/postmanlabs/postman-plugin', 'npm:pi-web-access']) });

    assert.equal((await pi.remove(system)).outcome, 'done');
    assert.deepEqual(system.commands, [`pi remove ${SOURCE}`, 'pi remove git:github.com/postmanlabs/postman-plugin']);
});

test('remove skips when Pi has nothing of ours', async () => {
    const system = fakeSystem({ bins: ['pi'], files: withPackages(['npm:pi-web-access']) });

    assert.equal((await pi.remove(system)).outcome, 'skipped');
    assert.equal((await pi.remove(fakeSystem({ bins: ['pi'] }))).outcome, 'skipped');
    assert.deepEqual(system.commands, []);
});
