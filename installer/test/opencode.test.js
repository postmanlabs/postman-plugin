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
    // An install from the mirror's repository, which `opencode plugin add github:...` writes and the installer recognizes.
    MIRROR = 'github:postmanlabs/opencode-plugin',
    // What the installer installs: the newest release tag.
    SPEC = OPENCODE_SPEC,
    V2 = { 'opencode --version': 'opencode v2.0.23\n' },
    V1 = { 'opencode --version': '1.18.34\n' },
    ADD2 = `opencode plugin add ${SPEC}`,
    // A git spec only re-installs when POSTMAN_PLUGIN_OPENCODE_SPEC names it, as installer smoke does with a built mirror.
    GIT = { POSTMAN_PLUGIN_OPENCODE_SPEC: MIRROR },
    ADD1 = `opencode plugin --global ${SPEC}`,
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

test('POSTMAN_PLUGIN_OPENCODE_SPEC installs that spec instead of the mirror, and status and remove find it', async () => {
    const spec = 'git+file:///tmp/build/opencode-plugin',
        env = { POSTMAN_PLUGIN_OPENCODE_SPEC: spec },
        system = fakeSystem({ probes: V2, env });

    assert.ok((await opencode.install(system)).message.startsWith(`installed ${spec}`));
    assert.deepEqual(system.commands, [`opencode plugin add ${spec}`]);

    const installed = fakeSystem({ probes: V2, env, files: { [json]: plugins(spec) } });

    assert.equal((await opencode.status(installed)).installed, true);
    assert.equal((await opencode.status(fakeSystem({ files: { [json]: plugins(spec) } }))).installed, false, 'only while the variable names it');
    assert.equal((await opencode.remove(installed)).outcome, 'done');
    assert.deepEqual(installed.commands, [`opencode plugin remove ${spec}`]);
});

test('refuses an OpenCode older than the first release of its major that installs Postman, running nothing', async () => {
    for (const [version, minimum] of [['2.0.3', '2.0.4'], ['1.14.32', '1.14.33'], ['1.4.9', '1.14.33']]) {
        const system = fakeSystem({ probes: { 'opencode --version': `${version}\n`,  } }),
            outcome = await opencode.install(system);

        assert.equal(outcome.outcome, 'blocked');
        assert.match(outcome.message, new RegExp(`older than ${minimum.replace(/\./g, '\\.')}`));
        assert.deepEqual(system.commands, []);
    }

    for (const version of ['2.0.4', '1.14.33', '3.1.0']) {
        assert.equal((await opencode.install(fakeSystem({ probes: { 'opencode --version': `v${version}\n`,  } }))).outcome, 'done');
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

    assert.equal((await at({ [json]: plugins(MIRROR) })).installed, true);
    assert.equal((await at({ [json]: plugin(MIRROR) })).installed, true);
    assert.equal((await at({ [jsonc]: `{\n  // mine\n  "plugin": ["x", "${MIRROR}",],\n}\n` })).installed, true);
    assert.match((await at({ [json]: plugins(MIRROR) })).detail, /opencode\.json/);

    for (const spec of [SPEC, `${MIRROR}#abc123`, 'git+https://github.com/postmanlabs/opencode-plugin.git#main']) {
        assert.equal((await at({ [json]: plugins(spec) })).installed, true, spec);
    }

    for (const other of ['github:someone/opencode-plugin', 'github:postmanlabs/postman-plugin', '@postman/postman-plugin', '@postman/other', 'git+file:///tmp/opencode-plugin']) {
        assert.equal((await at({ [json]: plugins(other, 'x') })).installed, false, other);
    }

    assert.equal((await at({})).installed, false);
});

test('status looks at the object form of an entry', async () => {
    const status = await opencode.status(fakeSystem({ files: { [json]: JSON.stringify({ plugins: [{ package: MIRROR, options: { a: 1 } }] }) } }));

    assert.equal(status.installed, true);
});

test('honours XDG_CONFIG_HOME', async () => {
    const files = { [path.join('/xdg', 'opencode', 'opencode.json')]: plugins(MIRROR) };

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
    copyOf = (spec, root = cached, slug = 'opencode-plugin') => path.join(root, `git-${slug}-${createHash('sha256').update(spec).digest('hex').slice(0, 12)}`);

test('install on an installed plugin refreshes it: OpenCode 2 sets its cached copy aside and adds again, OpenCode 1 forces a re-run', async () => {
    const copy = copyOf(MIRROR),
        v2 = fakeSystem({
            probes: V2,
            env: GIT,
            files: { [json]: plugins(MIRROR) },
            dirs: [path.join(copy, '1791217846050'), copyOf(`${MIRROR}#other`), path.join(cached, 'git-other-repo-abc123def456')]
        }),
        v1 = fakeSystem({ probes: V1, env: GIT, files: { [json]: plugin(MIRROR) } });

    assert.match((await opencode.install(v2)).message, /^updated github:postmanlabs\/opencode-plugin/);
    assert.deepEqual(v2.commands, [`remove ${copy}.previous`, `rename ${copy} ${copy}.previous`, `opencode plugin add ${MIRROR}`, `remove ${copy}.previous`]);
    assert.ok(await v2.exists(copyOf(`${MIRROR}#other`)), 'the copy of another ref is not touched');
    assert.ok(await v2.exists(path.join(cached, 'git-other-repo-abc123def456')), 'the copy of another repo is not touched');
    assert.match((await opencode.install(v1)).message, /^updated github:postmanlabs\/opencode-plugin/);
    assert.deepEqual(v1.commands, [`opencode plugin --global --force ${MIRROR}`]);
});

test('a failed refresh puts the cached copy back', async () => {
    const copy = copyOf(MIRROR),
        system = fakeSystem({
            probes: V2,
            env: GIT,
            files: { [json]: plugins(MIRROR), [path.join(copy, 'ts', 'package.json')]: '{}' },
            runs: { [`opencode plugin add ${MIRROR}`]: (self) => {
                self.dirs.add(path.join(copy, 'half-written'));

                return { code: 1, stderr: 'network is down' };
            } }
        }),
        outcome = await opencode.install(system);

    assert.equal(outcome.outcome, 'failed');
    assert.deepEqual(system.commands, [`remove ${copy}.previous`, `rename ${copy} ${copy}.previous`, `opencode plugin add ${MIRROR}`, `remove ${copy}`, `rename ${copy}.previous ${copy}`]);
    assert.ok(path.join(copy, 'ts', 'package.json') in system.files, 'the previous copy is back');
    assert.ok(!(await system.exists(path.join(copy, 'half-written'))), 'what the failed add left is gone');
});

test('install refreshes the spec the plugin is configured with, ref included, and honours XDG_CACHE_HOME', async () => {
    const spec = `${MIRROR}#abc`,
        copy = copyOf(spec, path.join('/xdg-cache', 'opencode', 'npm')),
        system = fakeSystem({
            probes: V2,
            env: { XDG_CACHE_HOME: '/xdg-cache', POSTMAN_PLUGIN_OPENCODE_SPEC: spec },
            files: { [json]: plugins(spec) },
            dirs: [path.join(copy, 'ts')]
        });

    await opencode.install(system);

    assert.deepEqual(system.commands, [`remove ${copy}.previous`, `rename ${copy} ${copy}.previous`, `opencode plugin add ${spec}`, `remove ${copy}.previous`]);
});

test('the cached copy is named by the spec\'s last path segment, as OpenCode 2 names it', async () => {
    const spec = 'git+file:///C:/build/Opencode%20Plugin.git',
        copy = copyOf(spec, cached, 'Opencode-Plugin'),
        system = fakeSystem({ probes: V2, env: { POSTMAN_PLUGIN_OPENCODE_SPEC: spec }, files: { [json]: plugins(spec) }, dirs: [path.join(copy, 'ts')] });

    await opencode.install(system);

    assert.deepEqual(system.commands, [`remove ${copy}.previous`, `rename ${copy} ${copy}.previous`, `opencode plugin add ${spec}`, `remove ${copy}.previous`]);
});

test('finds an entry in .opencode/opencode.json, which OpenCode 2 edits only when neither direct file exists', async () => {
    const nested = path.join(config, '.opencode', 'opencode.json'),
        alone = fakeSystem({ probes: V2, files: { [nested]: plugins(MIRROR) } });

    assert.equal((await opencode.status(alone)).installed, true);
    assert.equal((await opencode.remove(alone)).outcome, 'done');
    assert.deepEqual(alone.commands, [`opencode plugin remove ${MIRROR}`]);

    const shadowed = fakeSystem({ probes: V2, env: GIT, files: { [nested]: plugins(MIRROR), [jsonc]: plugins('x') } });

    assert.equal((await opencode.install(shadowed)).outcome, 'blocked', 'plugin add would write opencode.jsonc');
    assert.equal((await opencode.remove(shadowed)).outcome, 'done');
    assert.ok(!shadowed.commands.some((command) => command.startsWith('opencode plugin')), shadowed.commands.join('\n'));
    assert.ok(!shadowed.files[nested].includes(MIRROR));
});

test('OpenCode 1 does not refresh an entry in OPENCODE_CONFIG_DIR, since `plugin --global` writes the default directory', async () => {
    const file = path.join('/custom', 'opencode.json'),
        custom = fakeSystem({ probes: V1, env: { OPENCODE_CONFIG_DIR: '/custom', ...GIT }, files: { [file]: plugin(MIRROR) } }),
        outcome = await opencode.install(custom);

    assert.equal(outcome.outcome, 'blocked');
    assert.ok(outcome.message.includes(`write to ${json}`), outcome.message);
    assert.deepEqual(custom.commands, []);

    const usual = fakeSystem({ probes: V1, env: { OPENCODE_CONFIG_DIR: '/custom', ...GIT }, files: { [json]: plugin(MIRROR) } });

    assert.equal((await opencode.install(usual)).outcome, 'done');
});

test('install with nothing cached just adds again', async () => {
    const system = fakeSystem({ probes: V2, env: GIT, files: { [json]: plugins(MIRROR) } });

    await opencode.install(system);

    assert.deepEqual(system.commands, [`opencode plugin add ${MIRROR}`]);
});

test('a re-run refreshes the range spec in place, so it moves to the newest release tag', async () => {
    const copy = copyOf(SPEC),
        v2 = fakeSystem({ probes: V2, files: { [json]: plugins(SPEC) }, dirs: [path.join(copy, 'ts')] }),
        v1 = fakeSystem({ probes: V1, files: { [json]: plugin(SPEC) } });

    assert.ok((await opencode.install(v2)).message.startsWith(`updated ${SPEC}`));
    assert.deepEqual(v2.commands, [`remove ${copy}.previous`, `rename ${copy} ${copy}.previous`, ADD2, `remove ${copy}.previous`]);
    await opencode.install(v1);
    assert.deepEqual(v1.commands, [`opencode plugin --global --force ${SPEC}`]);
});

test('any other spec of the repository is replaced by the range spec', async () => {
    for (const old of [MIRROR, `${MIRROR}#main`, `${MIRROR}#v0.1.0`, 'git+https://github.com/postmanlabs/opencode-plugin.git']) {
        const v2 = fakeSystem({ probes: V2, files: { [json]: plugins(old) } }),
            outcome = await opencode.install(v2);

        assert.equal(outcome.outcome, 'done', old);
        assert.ok(outcome.message.startsWith(`replaced ${old} with ${SPEC}`), outcome.message);
        assert.deepEqual(v2.commands, [ADD2, `opencode plugin remove ${old}`], old);

        const v1 = fakeSystem({ probes: V1, files: { [json]: plugin('x', old) } });

        assert.equal((await opencode.install(v1)).outcome, 'done', old);
        assert.deepEqual(v1.commands.slice(0, 1), [`opencode plugin --global --force ${SPEC}`], old);
        assert.ok(!v1.files[json].includes(`"${old}"`), 'OpenCode 1 has no remove command, so the old entry is edited out');
    }
});

test('an old entry OpenCode already replaced in place is not removed again, which would leave nothing', async () => {
    const old = `${MIRROR}#v0.1.0`,
        system = fakeSystem({
            probes: V1,
            files: { [json]: plugin('x', old) },
            runs: { [`opencode plugin --global --force ${SPEC}`]: (self) => {
                self.files[json] = plugin('x', SPEC);

                return { code: 0 };
            } }
        });

    assert.equal((await opencode.install(system)).outcome, 'done');
    assert.equal(system.files[json], plugin('x', SPEC));
});

test('a replacement that could not take out the old entry adds nothing', async () => {
    const text = `{ "plugin": [["${MIRROR}", {}]] }`,
        system = fakeSystem({ probes: V1, files: { [json]: text } }),
        outcome = await opencode.install(system);

    assert.equal(outcome.outcome, 'blocked');
    assert.deepEqual(system.commands, []);
    assert.equal(system.files[json], text);
});

test('an entry in opencode.jsonc beside an opencode.json is not refreshed on OpenCode 2, which would register it twice', async () => {
    const copy = copyOf(MIRROR),
        system = fakeSystem({ probes: V2, env: GIT, files: { [json]: plugins('x'), [jsonc]: plugins(MIRROR) }, dirs: [path.join(copy, 'ts')] }),
        outcome = await opencode.install(system);

    assert.equal(outcome.outcome, 'blocked');
    assert.ok(outcome.message.includes(`write to ${json}; move the entry, with any options, there`), outcome.message);
    assert.deepEqual(system.commands, []);
    assert.ok(await system.exists(path.join(copy, 'ts')), 'the cached copy is left in place');
});

test('a re-run with the plugin installed still removes the older clone and loader, so no skill loads twice', async () => {
    const system = fakeSystem({ probes: withProbes(V2, cloneProbes()), bins: ['git'], ...ourClone({ files: { [shim]: OPENCODE_SHIM, [json]: plugins(SPEC) } }) }),
        outcome = await opencode.install(system);

    assert.equal(outcome.outcome, 'done');
    assert.match(outcome.message, /removed the older install/);
    assert.deepEqual(system.commands.slice(-2), [`remove ${clone}`, `remove ${shim}`]);
});

test('reads and edits the config in OPENCODE_CONFIG_DIR, where `plugin add` writes when it is set', async () => {
    const file = path.join('/custom', 'opencode.json'),
        env = { OPENCODE_CONFIG_DIR: '/custom' },
        system = fakeSystem({ env, files: { [file]: plugin(MIRROR), [json]: plugin('x') } });

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

    const refresh = fakeSystem({ probes: withProbes(V2, cloneProbes({ ahead: '1' })), bins: ['git'], ...ourClone({ files: { [shim]: OPENCODE_SHIM, [json]: plugins(MIRROR) } }) });

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
    const system = fakeSystem({ probes: V2, files: { [json]: plugins('x', `${MIRROR}#abc`) } }),
        outcome = await opencode.remove(system);

    assert.equal(outcome.outcome, 'done');
    assert.deepEqual(system.commands, [`opencode plugin remove ${MIRROR}#abc`]);
});

test('remove on OpenCode 1 takes the entry out of the config and keeps the rest as written', async () => {
    const text = `{\n  // mine\n  "plugin": [\n    "a", // first\n    "${MIRROR}",\n    "c"\n  ]\n}\n`,
        system = fakeSystem({ files: { [jsonc]: text } }),
        outcome = await opencode.remove(system);

    assert.equal(outcome.outcome, 'done');
    assert.deepEqual(system.commands, [`write ${jsonc}`]);
    assert.equal(system.files[jsonc], '{\n  // mine\n  "plugin": [\n    "a", // first\n    "c"\n  ]\n}\n');
});

test('remove on OpenCode 1 refuses an entry in a form it cannot take out without rewriting the file', async () => {
    const text = `{ "plugin": [{ "package": "${MIRROR}", "options": {} }] }`,
        system = fakeSystem({ files: { [json]: text } }),
        outcome = await opencode.remove(system);

    assert.equal(outcome.outcome, 'blocked');
    assert.match(outcome.message, /delete that entry yourself/);
    assert.deepEqual(system.commands, []);
    assert.equal(system.files[json], text);
});

test('an OpenCode 1 `[spec, options]` entry is ours, and remove refuses it rather than rewrite the config', async () => {
    const text = `{ "plugin": [["${MIRROR}", {}]] }`,
        system = fakeSystem({ files: { [json]: text } }),
        outcome = await opencode.remove(system);

    assert.equal((await opencode.status(system)).installed, true);
    assert.equal(outcome.outcome, 'blocked');
    assert.match(outcome.message, /delete that entry yourself/);
    assert.deepEqual(system.commands, []);
    assert.equal(system.files[json], text);
});

test('remove edits opencode.jsonc itself when opencode.json beside it is the file `plugin remove` would edit', async () => {
    const system = fakeSystem({ probes: V2, files: { [json]: plugins('x'), [jsonc]: plugins(MIRROR) } }),
        outcome = await opencode.remove(system);

    assert.equal(outcome.outcome, 'done');
    assert.ok(!system.commands.some((command) => command.startsWith('opencode plugin remove')), system.commands.join('\n'));
    assert.ok(!system.files[jsonc].includes(MIRROR));
    assert.equal(system.files[json], plugins('x'));
});

test('remove refuses an object entry in opencode.jsonc that `plugin remove` would not reach, removing nothing', async () => {
    const text = JSON.stringify({ plugins: [{ package: MIRROR }] }),
        system = fakeSystem({ probes: V2, files: { [json]: plugins('x'), [jsonc]: text } }),
        outcome = await opencode.remove(system);

    assert.equal(outcome.outcome, 'blocked');
    assert.deepEqual(system.commands, []);
    assert.equal(system.files[jsonc], text);
});

test('remove also deletes the older clone and loader', async () => {
    const system = fakeSystem({ probes: withProbes(V2, cloneProbes()), bins: ['git'], ...ourClone({ files: { [shim]: OPENCODE_SHIM, [json]: plugins(MIRROR) } }) }),
        outcome = await opencode.remove(system);

    assert.equal(outcome.outcome, 'done');
    assert.deepEqual(system.commands, [`opencode plugin remove ${MIRROR}`, `remove ${clone}`, `remove ${shim}`]);
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
        remove = fakeSystem({ env, probes: V2, files: { [json]: plugins(MIRROR) } }),
        refresh = fakeSystem({ env, probes: V2, files: { [json]: plugins(MIRROR) } });

    await opencode.remove(remove);
    await opencode.install(refresh);

    assert.deepEqual(remove.commands, [`opencode plugin remove ${MIRROR}`]);
    assert.deepEqual(remove.runEnv[`opencode plugin remove ${MIRROR}`], { OPENCODE_CONFIG_DIR: config });
    assert.deepEqual(refresh.runEnv[ADD2], { OPENCODE_CONFIG_DIR: config });
});

test('OpenCode 1 forces its re-run in the config directory the entry was found in', async () => {
    const system = fakeSystem({ env: { OPENCODE_CONFIG_DIR: '/custom', ...GIT }, probes: V1, files: { [json]: plugin(MIRROR) } });

    await opencode.install(system);

    assert.deepEqual(system.commands, [`opencode plugin --global --force ${MIRROR}`]);
    assert.deepEqual(system.runEnv[`opencode plugin --global --force ${MIRROR}`], { OPENCODE_CONFIG_DIR: config });
});

test('commands leave the environment alone when the entry is in the directory OpenCode already uses', async () => {
    const custom = path.join('/custom', 'opencode.json'),
        system = fakeSystem({ env: { OPENCODE_CONFIG_DIR: '/custom' }, files: { [custom]: plugins(MIRROR) } });

    await opencode.remove(system);

    assert.equal(system.runEnv[`opencode plugin remove ${MIRROR}`], undefined);
});

test('remove checks the older install before it removes the plugin, so a refusal changes nothing', async () => {
    for (const probes of [cloneProbes({ changes: ' M x\n' }), cloneProbes({ ahead: '1' })]) {
        const system = fakeSystem({ probes, bins: ['git'], ...ourClone({ files: { [shim]: OPENCODE_SHIM, [json]: plugins(MIRROR) } }) }),
            outcome = await opencode.remove(system);

        assert.equal(outcome.outcome, 'blocked');
        assert.deepEqual(system.commands, []);
    }

    const foreign = fakeSystem({ probes: cloneProbes(), bins: ['git'], ...ourClone({ files: { [shim]: 'export default {};\n', [json]: plugins(MIRROR) } }) });

    assert.equal((await opencode.remove(foreign)).outcome, 'blocked');
    assert.deepEqual(foreign.commands, []);
});

test('a fresh install or a replacement sets aside a cached copy an earlier `plugin remove` left, so a newer release arrives', async () => {
    const copy = copyOf(SPEC),
        fresh = fakeSystem({ probes: V2, dirs: [path.join(copy, 'ts')] }),
        replacing = fakeSystem({ probes: V2, files: { [json]: plugins(MIRROR) }, dirs: [path.join(copy, 'ts')] });

    await opencode.install(fresh);
    assert.deepEqual(fresh.commands, [`remove ${copy}.previous`, `rename ${copy} ${copy}.previous`, ADD2, `remove ${copy}.previous`]);
    await opencode.install(replacing);
    assert.deepEqual(replacing.commands.slice(0, 4), [`remove ${copy}.previous`, `rename ${copy} ${copy}.previous`, ADD2, `remove ${copy}.previous`]);
});

test('more than one Postman entry is refused before anything changes, naming each', async () => {
    const system = fakeSystem({ probes: V2, files: { [json]: plugins(SPEC, `${MIRROR}#v0.1.0`) } }),
        outcome = await opencode.install(system);

    assert.equal(outcome.outcome, 'blocked');
    assert.match(outcome.message, /found 2 entries for Postman .*#v0\.1\.0.*keep one/);
    assert.deepEqual(system.commands, []);
});

test('an opencode.json entry that the opencode.jsonc plugin list replaces on OpenCode 1 is not loaded, and install refuses it', async () => {
    const files = { [json]: plugin(SPEC), [jsonc]: plugin('x') },
        status = await opencode.status(fakeSystem({ files })),
        install = fakeSystem({ probes: V1, files: { ...files } }),
        remove = fakeSystem({ probes: V1, files: { ...files } });

    assert.equal(status.installed, false);
    assert.ok(status.notes.some((note) => note.includes('reads the opencode.jsonc beside it')), status.notes.join('\n'));
    assert.equal((await opencode.install(install)).outcome, 'blocked');
    assert.deepEqual(install.commands, []);
    assert.equal((await opencode.remove(remove)).outcome, 'done', 'the stored entry still comes out');
    assert.equal(remove.files[json], plugin());
});

test('OPENCODE_CONFIG_DIR naming the default directory another way is read once', async () => {
    const env = { OPENCODE_CONFIG_DIR: `${config}${path.sep}` },
        system = fakeSystem({ env, probes: V1, files: { [json]: plugin(SPEC) } });

    assert.equal((await opencode.status(system)).installed, true);
    assert.equal((await opencode.remove(system)).outcome, 'done');
    assert.equal(system.files[json], plugin());
});

test('an install message never shows the user-info of a spec, in a refusal or a fresh install', async () => {
    const spec = 'git+https://someone:secret-token@github.com/postmanlabs/opencode-plugin.git#semver:*',
        refused = await opencode.install(fakeSystem({ probes: V1, env: { POSTMAN_PLUGIN_OPENCODE_SPEC: SPEC }, files: { [json]: `{ "plugin": [["${spec}", {}]] }` } })),
        fresh = await opencode.install(fakeSystem({ probes: V2, env: { POSTMAN_PLUGIN_OPENCODE_SPEC: spec } }));

    assert.equal(refused.outcome, 'blocked');
    assert.equal(fresh.outcome, 'done');

    for (const outcome of [refused, fresh]) {
        assert.ok(!outcome.message.includes('secret-token'), outcome.message);
    }
});

test('OpenCode 1 refreshes or replaces only an entry in the file `plugin --global` writes: opencode.json when it exists', async () => {
    for (const entry of [SPEC, MIRROR]) {
        const system = fakeSystem({ probes: V1, files: { [json]: plugin('x'), [jsonc]: plugin(entry) } }),
            outcome = await opencode.install(system);

        assert.equal(outcome.outcome, 'blocked', entry);
        assert.ok(outcome.message.includes(`write to ${json}`), outcome.message);
        assert.deepEqual(system.commands, [], entry);
    }

    assert.equal((await opencode.install(fakeSystem({ probes: V1, files: { [jsonc]: plugin(SPEC) } }))).outcome, 'done', 'with no opencode.json, opencode.jsonc is the one it writes');
});

test('remove edits an OpenCode 2 `plugins` entry itself when the opencode on PATH is OpenCode 1, which has no `plugin remove`', async () => {
    const system = fakeSystem({ probes: V1, files: { [json]: plugins('x', SPEC) } }),
        outcome = await opencode.remove(system);

    assert.equal(outcome.outcome, 'done');
    assert.ok(!system.commands.some((command) => command.startsWith('opencode plugin remove')), system.commands.join('\n'));
    assert.equal(system.files[json], plugins('x'));
});
