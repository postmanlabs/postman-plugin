import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import path from 'node:path';
import test from 'node:test';
import { opencode } from '../dist/hosts/opencode.js';
import { OPENCODE_SHIM, OPENCODE_SPEC } from '../dist/source.js';
import { fakeSystem } from './fake-system.js';

const config = path.join('/home/user', '.config', 'opencode'),
    json = path.join(config, 'opencode.json'),
    jsonc = path.join(config, 'opencode.jsonc'),
    clone = path.join(config, 'postman-plugin'),
    shim = path.join(config, 'plugins', 'postman.ts'),
    GIT_URL = 'https://github.com/postmanlabs/postman-plugin.git',
    target = path.join(clone, 'opencode', 'src', 'index.ts'),
    V2 = { 'opencode --version': 'opencode v2.0.23\n' },
    V1 = { 'opencode --version': '1.18.34\n' },
    ADD2 = `opencode plugin add ${OPENCODE_SPEC}`,
    ADD1 = `opencode plugin --global ${OPENCODE_SPEC}`,
    plugins = (...items) => JSON.stringify({ plugins: items }),
    plugin = (...items) => JSON.stringify({ plugin: items }),
    cloneProbes = ({ branch = { code: 0, stdout: 'main\n' }, changes = '', ahead = '0' } = {}) => ({
        [`git -C ${clone} remote get-url origin`]: GIT_URL,
        [`git -C ${clone} symbolic-ref --short HEAD`]: branch,
        [`git -C ${clone} status --porcelain`]: changes,
        [`git -C ${clone} rev-list --count origin/main..HEAD`]: `${ahead}\n`
    }),
    ourClone = (extra = {}) => ({ dirs: [path.join(clone, '.git'), target], files: { [shim]: OPENCODE_SHIM }, ...extra }),
    withProbes = (...tables) => Object.assign({}, ...tables);

test('detects OpenCode by its CLI on PATH', async () => {
    assert.equal(await opencode.detect(fakeSystem({ bins: ['opencode'] })), true);
    assert.equal(await opencode.detect(fakeSystem()), false);
});

test('a fresh install runs `opencode plugin add` on OpenCode 2 and `plugin --global` on OpenCode 1', async () => {
    const v2 = fakeSystem({ probes: V2 }),
        v1 = fakeSystem({ probes: V1 });

    assert.equal((await opencode.install(v2)).outcome, 'done');
    assert.deepEqual(v2.commands, [ADD2]);
    assert.equal((await opencode.install(v1)).outcome, 'done');
    assert.deepEqual(v1.commands, [ADD1]);
});

test('POSTMAN_PLUGIN_OPENCODE_REF installs a ref of the repo instead of its default branch', async () => {
    const system = fakeSystem({ probes: V2, env: { POSTMAN_PLUGIN_OPENCODE_REF: 'abc123' } });

    assert.match((await opencode.install(system)).message, /^installed github:postmanlabs\/postman-plugin#abc123/);
    assert.deepEqual(system.commands, [`${ADD2}#abc123`]);
});

test('refuses an OpenCode older than the first release of its major that installs Postman, running nothing', async () => {
    for (const [version, minimum] of [['2.0.3', '2.0.4'], ['1.14.32', '1.14.33'], ['1.4.9', '1.14.33']]) {
        const system = fakeSystem({ probes: { 'opencode --version': `${version}\n` } }),
            outcome = await opencode.install(system);

        assert.equal(outcome.outcome, 'blocked');
        assert.match(outcome.message, new RegExp(`older than ${minimum.replace(/\./g, '\\.')}`));
        assert.deepEqual(system.commands, []);
    }

    for (const version of ['2.0.4', '1.14.33', '3.1.0']) {
        assert.equal((await opencode.install(fakeSystem({ probes: { 'opencode --version': `v${version}\n` } }))).outcome, 'done');
    }
});

test('an OpenCode whose version cannot be read is a failure, not a guess', async () => {
    for (const probes of [{}, { 'opencode --version': 'dev build\n' }]) {
        const system = fakeSystem({ probes }),
            outcome = await opencode.install(system);

        assert.equal(outcome.outcome, 'failed');
        assert.match(outcome.message, /could not read the version/);
        assert.deepEqual(system.commands, []);
    }
});

test('status reads the global config: `plugins` for OpenCode 2, `plugin` in .json or .jsonc for OpenCode 1', async () => {
    const at = async (files) => opencode.status(fakeSystem({ files }));

    assert.equal((await at({ [json]: plugins(OPENCODE_SPEC) })).installed, true);
    assert.equal((await at({ [json]: plugin(OPENCODE_SPEC) })).installed, true);
    assert.equal((await at({ [jsonc]: `{\n  // mine\n  "plugin": ["x", "${OPENCODE_SPEC}",],\n}\n` })).installed, true);
    assert.match((await at({ [json]: plugins(OPENCODE_SPEC) })).detail, /opencode\.json/);

    for (const spec of [`${OPENCODE_SPEC}#abc123`, '@postman/postman-plugin', '@postman/postman-plugin@0.3.0', 'git+https://github.com/postmanlabs/postman-plugin.git#main']) {
        assert.equal((await at({ [json]: plugins(spec) })).installed, true, spec);
    }

    for (const other of ['github:someone/postman-plugin', '@postman/other', 'git+file:///tmp/postman-plugin']) {
        assert.equal((await at({ [json]: plugins(other, 'x') })).installed, false, other);
    }

    assert.equal((await at({})).installed, false);
});

test('status looks at the object form of an entry', async () => {
    const status = await opencode.status(fakeSystem({ files: { [json]: JSON.stringify({ plugins: [{ package: OPENCODE_SPEC, options: { a: 1 } }] }) } }));

    assert.equal(status.installed, true);
});

test('honours XDG_CONFIG_HOME', async () => {
    const files = { [path.join('/xdg', 'opencode', 'opencode.json')]: plugins(OPENCODE_SPEC) };

    assert.equal((await opencode.status(fakeSystem({ env: { XDG_CONFIG_HOME: '/xdg' }, files }))).installed, true);
    assert.equal((await opencode.status(fakeSystem({ files }))).installed, false);
});

test('a config that does not parse is unknown, and install leaves it alone', async () => {
    const system = fakeSystem({ probes: V2, files: { [json]: '{ "plugins": [' } }),
        status = await opencode.status(system),
        outcome = await opencode.install(system);

    assert.equal(status.installed, null);
    assert.equal(outcome.outcome, 'failed');
    assert.match(outcome.message, /is not valid JSON/);
    assert.deepEqual(system.commands, []);
});

const cached = path.join('/home/user', '.cache', 'opencode', 'npm'),
    copyOf = (spec, root = cached) => path.join(root, `git-postman-plugin-${createHash('sha256').update(spec).digest('hex').slice(0, 12)}`);

test('install on an installed plugin refreshes it: OpenCode 2 sets its cached copy aside and adds again, OpenCode 1 forces a re-run', async () => {
    const copy = copyOf(OPENCODE_SPEC),
        v2 = fakeSystem({
            probes: V2,
            files: { [json]: plugins(OPENCODE_SPEC) },
            dirs: [path.join(copy, '1791217846050'), copyOf(`${OPENCODE_SPEC}#other`), path.join(cached, 'git-other-repo-abc123def456')]
        }),
        v1 = fakeSystem({ probes: V1, files: { [json]: plugin(OPENCODE_SPEC) } });

    assert.match((await opencode.install(v2)).message, /^updated github:postmanlabs\/postman-plugin/);
    assert.deepEqual(v2.commands, [`remove ${copy}.previous`, `rename ${copy} ${copy}.previous`, ADD2, `remove ${copy}.previous`]);
    assert.ok(await v2.exists(copyOf(`${OPENCODE_SPEC}#other`)), 'the copy of another ref is not touched');
    assert.ok(await v2.exists(path.join(cached, 'git-other-repo-abc123def456')), 'the copy of another repo is not touched');
    assert.match((await opencode.install(v1)).message, /^updated github:postmanlabs\/postman-plugin/);
    assert.deepEqual(v1.commands, [`opencode plugin --global --force ${OPENCODE_SPEC}`]);
});

test('a failed refresh puts the cached copy back', async () => {
    const copy = copyOf(OPENCODE_SPEC),
        system = fakeSystem({
            probes: V2,
            files: { [json]: plugins(OPENCODE_SPEC), [path.join(copy, 'ts', 'package.json')]: '{}' },
            runs: { [ADD2]: (self) => {
                self.dirs.add(path.join(copy, 'half-written'));

                return { code: 1, stderr: 'network is down' };
            } }
        }),
        outcome = await opencode.install(system);

    assert.equal(outcome.outcome, 'failed');
    assert.deepEqual(system.commands, [`remove ${copy}.previous`, `rename ${copy} ${copy}.previous`, ADD2, `remove ${copy}`, `rename ${copy}.previous ${copy}`]);
    assert.ok(path.join(copy, 'ts', 'package.json') in system.files, 'the previous copy is back');
    assert.ok(!(await system.exists(path.join(copy, 'half-written'))), 'what the failed add left is gone');
});

test('install refreshes the spec the plugin is configured with, ref included, and honours XDG_CACHE_HOME', async () => {
    const spec = `${OPENCODE_SPEC}#abc`,
        copy = copyOf(spec, path.join('/xdg-cache', 'opencode', 'npm')),
        system = fakeSystem({
            probes: V2,
            env: { XDG_CACHE_HOME: '/xdg-cache' },
            files: { [json]: plugins(spec) },
            dirs: [path.join(copy, 'ts')]
        });

    await opencode.install(system);

    assert.deepEqual(system.commands, [`remove ${copy}.previous`, `rename ${copy} ${copy}.previous`, `${ADD2}#abc`, `remove ${copy}.previous`]);
});

test('install with nothing cached just adds again', async () => {
    const system = fakeSystem({ probes: V2, files: { [json]: plugins(OPENCODE_SPEC) } });

    await opencode.install(system);

    assert.deepEqual(system.commands, [ADD2]);
});

test('a plugin installed from npm is left for OpenCode to update, and nothing is run', async () => {
    for (const probes of [V1, V2]) {
        const system = fakeSystem({ probes, files: { [json]: plugins('@postman/postman-plugin') } }),
            outcome = await opencode.install(system);

        assert.equal(outcome.outcome, 'manual');
        assert.match(outcome.next, /opencode plugin update/);
        assert.deepEqual(system.commands, []);
    }
});

test('reads and edits the config in OPENCODE_CONFIG_DIR, where `plugin add` writes when it is set', async () => {
    const file = path.join('/custom', 'opencode.json'),
        env = { OPENCODE_CONFIG_DIR: '/custom' },
        system = fakeSystem({ env, files: { [file]: plugin(OPENCODE_SPEC), [json]: plugin('x') } });

    assert.equal((await opencode.status(system)).installed, true);
    assert.equal((await opencode.remove(system)).outcome, 'done');
    assert.deepEqual(system.commands, [`write ${file}`]);
    assert.equal((await opencode.status(fakeSystem({ files: { [json]: plugin('x') } }))).installed, false);
});

test('install moves an older clone-and-loader install over, after the plugin is in', async () => {
    const system = fakeSystem({ probes: withProbes(V2, cloneProbes()), bins: ['git'], ...ourClone() }),
        status = await opencode.status(system),
        outcome = await opencode.install(system);

    assert.equal(status.installed, true);
    assert.match(status.notes[0], /will be removed/);
    assert.equal(outcome.outcome, 'done');
    assert.match(outcome.message, /removed the older install at .*postman-plugin and .*postman\.ts/);
    assert.deepEqual(system.commands, [ADD2, `remove ${clone}`, `remove ${shim}`]);
});

test('a failed `plugin add` leaves the older install in place', async () => {
    const system = fakeSystem({ probes: withProbes(V2, cloneProbes()), runs: { [ADD2]: { code: 1, stderr: 'boom' } }, bins: ['git'], ...ourClone() }),
        outcome = await opencode.install(system);

    assert.equal(outcome.outcome, 'failed');
    assert.deepEqual(system.commands, [ADD2]);
    assert.ok(shim in system.files);
});

test('an older clone with local changes, another branch or unpushed commits stops the install before the plugin goes in', async () => {
    for (const probes of [cloneProbes({ changes: ' M skills/bootstrap/SKILL.md\n' }), cloneProbes({ branch: 'feat/old-work\n' }), cloneProbes({ ahead: '1' })]) {
        const system = fakeSystem({ probes: withProbes(V2, probes), bins: ['git'], ...ourClone() }),
            outcome = await opencode.install(system);

        assert.equal(outcome.outcome, 'blocked');
        assert.deepEqual(system.commands, [], 'nothing runs, so two copies never load the same skills');
    }

    const refresh = fakeSystem({ probes: withProbes(V2, cloneProbes({ ahead: '1' })), bins: ['git'], ...ourClone({ files: { [shim]: OPENCODE_SHIM, [json]: plugins(OPENCODE_SPEC) } }) });

    assert.equal((await opencode.install(refresh)).outcome, 'blocked');
    assert.deepEqual(refresh.commands, []);
});

test('a plugins/postman.ts it did not write is never removed, and with a clone beside it the install stops first', async () => {
    const system = fakeSystem({ probes: withProbes(V2, cloneProbes()), bins: ['git'], ...ourClone({ files: { [shim]: 'export { default } from "../postman-plugin/opencode/src/index.ts"\n' } }) }),
        outcome = await opencode.install(system);

    assert.equal(outcome.outcome, 'blocked');
    assert.match(outcome.message, /may load/);
    assert.deepEqual(system.commands, []);
});

test('a plugins/postman.ts with other contents and no clone is none of our business', async () => {
    const system = fakeSystem({ probes: V2, files: { [shim]: 'export default {};\n' } });

    assert.equal((await opencode.install(system)).outcome, 'done');
    assert.deepEqual(system.commands, [ADD2]);
});

test('a plugins/postman.ts it cannot read is never touched', async () => {
    const unreadable = Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' }),
        system = fakeSystem({ probes: V2, files: { [shim]: unreadable } }),
        outcome = await opencode.install(system);

    assert.equal(outcome.outcome, 'failed');
    assert.match(outcome.message, /EACCES/);
    assert.deepEqual(system.commands.filter((command) => command.startsWith('remove') || command.startsWith('write')), []);
});

test('status of the older install alone: installed, with a note that install replaces it', async () => {
    const status = await opencode.status(fakeSystem(ourClone()));

    assert.equal(status.installed, true);
    assert.match(status.detail, /clone at/);
    assert.match(status.notes[0], /will be removed/);
});

test('a clone without the file the loader imports is not installed', async () => {
    const status = await opencode.status(fakeSystem({ dirs: [clone], files: { [shim]: OPENCODE_SHIM } }));

    assert.equal(status.installed, false);
    assert.match(status.notes.join('\n'), /no opencode\/src\/index\.ts/);
});

test('remove on OpenCode 2 runs `opencode plugin remove` with the configured spec', async () => {
    const system = fakeSystem({ files: { [json]: plugins('x', `${OPENCODE_SPEC}#abc`) } }),
        outcome = await opencode.remove(system);

    assert.equal(outcome.outcome, 'done');
    assert.deepEqual(system.commands, [`opencode plugin remove ${OPENCODE_SPEC}#abc`]);
});

test('remove on OpenCode 1 takes the entry out of the config and keeps the rest as written', async () => {
    const text = `{\n  // mine\n  "plugin": [\n    "a", // first\n    "${OPENCODE_SPEC}",\n    "c"\n  ]\n}\n`,
        system = fakeSystem({ files: { [jsonc]: text } }),
        outcome = await opencode.remove(system);

    assert.equal(outcome.outcome, 'done');
    assert.deepEqual(system.commands, [`write ${jsonc}`]);
    assert.equal(system.files[jsonc], '{\n  // mine\n  "plugin": [\n    "a", // first\n    "c"\n  ]\n}\n');
});

test('remove on OpenCode 1 refuses an entry in a form it cannot take out without rewriting the file', async () => {
    const text = `{ "plugin": [{ "package": "${OPENCODE_SPEC}", "options": {} }] }`,
        system = fakeSystem({ files: { [json]: text } }),
        outcome = await opencode.remove(system);

    assert.equal(outcome.outcome, 'blocked');
    assert.match(outcome.message, /delete that entry yourself/);
    assert.deepEqual(system.commands, []);
    assert.equal(system.files[json], text);
});

test('an entry that only mentions this repo inside a nested list is not ours', async () => {
    const system = fakeSystem({ files: { [json]: `{ "plugin": [["${OPENCODE_SPEC}", {}]] }` } });

    assert.equal((await opencode.status(system)).installed, false);
    assert.equal((await opencode.remove(system)).outcome, 'skipped');
    assert.deepEqual(system.commands, []);
});

test('remove also deletes the older clone and loader', async () => {
    const system = fakeSystem({ probes: cloneProbes(), bins: ['git'], ...ourClone({ files: { [shim]: OPENCODE_SHIM, [json]: plugins(OPENCODE_SPEC) } }) }),
        outcome = await opencode.remove(system);

    assert.equal(outcome.outcome, 'done');
    assert.deepEqual(system.commands, [`opencode plugin remove ${OPENCODE_SPEC}`, `remove ${clone}`, `remove ${shim}`]);
});

test('remove deletes nothing of the older install when the clone is not ours, has local changes or unpushed commits', async () => {
    for (const probes of [cloneProbes({ changes: ' M x\n' }), cloneProbes({ ahead: '1' }), { [`git -C ${clone} remote get-url origin`]: 'https://github.com/someone/fork.git' }]) {
        const system = fakeSystem({ probes, bins: ['git'], ...ourClone() }),
            outcome = await opencode.remove(system);

        assert.equal(outcome.outcome, 'blocked');
        assert.deepEqual(system.commands, []);
    }
});

test('remove keeps the clone while a plugins/postman.ts it did not write may still load it', async () => {
    const system = fakeSystem({ probes: cloneProbes(), bins: ['git'], ...ourClone({ files: { [shim]: "export { default } from '../postman-plugin/opencode/src/index.ts'\n" } }) }),
        outcome = await opencode.remove(system);

    assert.equal(outcome.outcome, 'blocked');
    assert.match(outcome.message, /may load/);
    assert.deepEqual(system.commands, []);
});

test('remove has nothing to do when nothing of Postman is there', async () => {
    const system = fakeSystem({ files: { [json]: plugins('x') } });

    assert.equal((await opencode.remove(system)).outcome, 'skipped');
    assert.deepEqual(system.commands, []);
});

test('commands act on the config directory the entry was found in, not on a custom OPENCODE_CONFIG_DIR', async () => {
    const env = { OPENCODE_CONFIG_DIR: '/custom' },
        remove = fakeSystem({ env, files: { [json]: plugins(OPENCODE_SPEC) } }),
        refresh = fakeSystem({ env, probes: V2, files: { [json]: plugins(OPENCODE_SPEC) } });

    await opencode.remove(remove);
    await opencode.install(refresh);

    assert.deepEqual(remove.commands, [`opencode plugin remove ${OPENCODE_SPEC}`]);
    assert.deepEqual(remove.runEnv[`opencode plugin remove ${OPENCODE_SPEC}`], { OPENCODE_CONFIG_DIR: config });
    assert.deepEqual(refresh.runEnv[ADD2], { OPENCODE_CONFIG_DIR: config });
});

test('OpenCode 1 forces its re-run in the config directory the entry was found in', async () => {
    const system = fakeSystem({ env: { OPENCODE_CONFIG_DIR: '/custom' }, probes: V1, files: { [json]: plugin(OPENCODE_SPEC) } });

    await opencode.install(system);

    assert.deepEqual(system.commands, [`opencode plugin --global --force ${OPENCODE_SPEC}`]);
    assert.deepEqual(system.runEnv[`opencode plugin --global --force ${OPENCODE_SPEC}`], { OPENCODE_CONFIG_DIR: config });
});

test('commands leave the environment alone when the entry is in the directory OpenCode already uses', async () => {
    const custom = path.join('/custom', 'opencode.json'),
        system = fakeSystem({ env: { OPENCODE_CONFIG_DIR: '/custom' }, files: { [custom]: plugins(OPENCODE_SPEC) } });

    await opencode.remove(system);

    assert.equal(system.runEnv[`opencode plugin remove ${OPENCODE_SPEC}`], undefined);
});

test('remove checks the older install before it removes the plugin, so a refusal changes nothing', async () => {
    for (const probes of [cloneProbes({ changes: ' M x\n' }), cloneProbes({ ahead: '1' })]) {
        const system = fakeSystem({ probes, bins: ['git'], ...ourClone({ files: { [shim]: OPENCODE_SHIM, [json]: plugins(OPENCODE_SPEC) } }) }),
            outcome = await opencode.remove(system);

        assert.equal(outcome.outcome, 'blocked');
        assert.deepEqual(system.commands, []);
    }

    const foreign = fakeSystem({ probes: cloneProbes(), bins: ['git'], ...ourClone({ files: { [shim]: 'export default {};\n', [json]: plugins(OPENCODE_SPEC) } }) });

    assert.equal((await opencode.remove(foreign)).outcome, 'blocked');
    assert.deepEqual(foreign.commands, []);
});
