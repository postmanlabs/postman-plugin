// Real installer + app-server, isolated from the user's configuration. The model is a local stand-in.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { codex, registeredRef } from '../dist/hosts/codex.js';
import { BRANCH, REPO } from '../dist/source.js';
import { run as install } from '../dist/run.js';
import { createSystem } from '../dist/system.js';
import { JsonRpcError } from '../dist/json-rpc.js';
import { assertSkillsListed, runAgent, startStandIn, workspace } from '../../scripts/lib/harness.js';

const PLUGIN_ID = 'postman@postman';

export function codexEnvironment (source = process.env, platform = process.platform) {
    // process.env is case-insensitive on Windows; a plain copy is not. Normalize
    // before filtering and prepending PATH, so Node/Git stay on the child's path
    // and a differently-cased CODEX_HOME cannot escape the throwaway profile.
    return Object.fromEntries(Object.entries(source)
        .map(([key, value]) => [platform === 'win32' ? key.toUpperCase() : key, value])
        .filter(([key]) => !/^(CODEX_|OPENAI_)/.test(key)));
}

export function snapshot (root, { includeMetadata = true } = {}) {
    const files = {};

    function walk (dir) {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            if (!includeMetadata && ['.git', '.codex-marketplace-install.json'].includes(entry.name)) {
                continue;
            }

            const file = path.join(dir, entry.name);

            if (entry.isDirectory()) {
                walk(file);
            }
            else {
                files[path.relative(root, file)] = createHash('sha256').update(fs.readFileSync(file)).digest('hex');
            }
        }
    }

    walk(root);

    return files;
}

// Setup only: older Windows Codex can fail an atomic config rename temporarily.
export async function writeTestConfig (rpc, edits, label, platform = process.platform, pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))) {
    for (let attempt = 0; ; attempt++) {
        try {
            await rpc.request('config/batchWrite', { edits, reloadUserConfig: true });

            return;
        }
        catch (error) {
            if (platform !== 'win32' || !(error instanceof JsonRpcError) || error.reply.code !== -32603 ||
                !/failed to persist config/.test(error.message) || attempt >= 2) {
                throw new Error(`Could not ${label} in the throwaway Codex profile`, { cause: error });
            }

            await pause(250 * (attempt + 1));
        }
    }
}

// The installer must never trust a Postman hook. The Codex route declares none, but this installs `main`,
// which may still carry one, so a hook that is there must stay untrusted.
export async function checkCodexInstall () {
    const box = workspace('codex-installer'),
        previousCwd = process.cwd(),
        codexBin = process.env.CODEX_BIN || 'codex',
        cli = path.resolve(import.meta.dirname, '../dist/cli.js'),
        env = codexEnvironment();
    let standIn,
        cachePath;

    Object.assign(env, {
        HOME: box.home, USERPROFILE: box.home,
        XDG_CONFIG_HOME: path.join(box.home, '.config'), XDG_CACHE_HOME: path.join(box.home, '.cache'),
        XDG_DATA_HOME: path.join(box.home, '.local', 'share'), XDG_STATE_HOME: path.join(box.home, '.local', 'state')
    });

    if (codexBin !== 'codex') {
        env.PATH = `${path.dirname(path.resolve(codexBin))}${path.delimiter}${env.PATH}`;
    }

    process.chdir(box.project);

    try {
        // No .codex directory, marketplace or hook trust is seeded before installation.
        const logs = [],
            rpcChanges = [],
            codexHome = path.join(box.home, '.codex'),
            baseSystem = createSystem({ log: (line) => logs.push(line), env, home: box.home, cwd: box.project }),
            system = { ...baseSystem, async run (command, args, ...rest) {
                const result = await baseSystem.run(command, args, ...rest);

                if (command === 'codex' && args.slice(0, 3).join(' ') === 'plugin add postman@postman' && result.code === 0) {
                    // Codex's cache layout varies by platform. Capture its own
                    // installedPath before the first app-server starts.
                    cachePath = JSON.parse(result.stdout).installedPath;
                    assert.equal(typeof cachePath, 'string', 'plugin add returned no installedPath');
                    const relative = path.relative(fs.realpathSync(box.root), fs.realpathSync(cachePath));

                    assert.ok(relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative), 'plugin cache escaped the throwaway profile');
                }

                return result;
            }, async withJsonRpc (...args) {
                const before = cachePath && fs.existsSync(cachePath) ? snapshot(cachePath) : {};

                try {
                    return await baseSystem.withJsonRpc(...args);
                }
                finally {
                    const after = cachePath && fs.existsSync(cachePath) ? snapshot(cachePath) : {};

                    rpcChanges.push(...new Set([...Object.keys(before), ...Object.keys(after)]
                        .filter((file) => before[file] !== after[file])));
                }
            } },
            options = { command: 'install', agents: ['codex'], yes: true, isTTY: false, confirm: async () => { throw new Error('unexpected install prompt'); } },
            runInstall = async (extra = {}) => {
                logs.length = 0;
                assert.equal(await install(system, [codex], { ...options, ...extra }), 0, logs.join('\n'));
            },
            list = () => system.withJsonRpc('codex', ['app-server'], async (rpc) => {
                await rpc.request('initialize', { clientInfo: { name: 'postman-installer-smoke', version: '1' } });
                rpc.notify('initialized');

                const { data } = await rpc.request('hooks/list', { cwds: [box.project] });

                return data.flatMap(({ hooks }) => hooks).filter(({ pluginId }) => pluginId === PLUGIN_ID);
            }),
            assertNoneTrusted = async () => {
                const hooks = await list();

                assert.deepEqual(hooks.filter(({ trustStatus }) => trustStatus !== 'untrusted').map(({ key }) => key), [], 'the installer must not trust a Postman hook');

                return hooks;
            };

        if (process.platform === 'win32') {
            // Codex uses the native Windows profile rather than HOME/USERPROFILE.
            // Explicit CODEX_HOME requires an existing directory, so only Windows
            // needs an empty one. Linux and the fresh unit case start without it.
            fs.mkdirSync(codexHome);
            env.CODEX_HOME = codexHome;
        }
        else {
            assert.ok(!fs.existsSync(codexHome));
        }

        assert.ok(!fs.existsSync(path.join(codexHome, 'config.toml')));
        await runInstall();
        assert.doesNotMatch(logs.join('\n'), /<EXTREMELY_IMPORTANT>|session-start-context\.md/);

        const installedPath = cachePath,
            before = snapshot(installedPath),
            contentBefore = snapshot(installedPath, { includeMetadata: false });

        await assertNoneTrusted();

        assert.equal(await registeredRef(system), BRANCH, 'a fresh install must track main');
        assert.deepEqual(snapshot(installedPath), before, 'app-server startup changed the cached plugin');

        await runInstall({ isTTY: true });
        await assertNoneTrusted();

        const configBeforeDry = fs.readFileSync(path.join(codexHome, 'config.toml'), 'utf8'),
            dry = await runAgent(process.execPath, [cli, 'install', '--dry-run', '--agent', 'codex'], { env, cwd: box.project });

        assert.equal(dry.code, 0, dry.stdout + dry.stderr);
        assert.doesNotMatch(dry.stdout, /\$ codex app-server/);
        assert.equal(fs.readFileSync(path.join(codexHome, 'config.toml'), 'utf8'), configBeforeDry);
        assert.deepEqual(snapshot(installedPath), before);
        assert.deepEqual(rpcChanges, [], 'app-server changed cached files, including during its first startup');

        // Use the real installed plugin unchanged. Only inference is redirected locally;
        // its MCP server still connects to Postman unauthenticated, just as for a new user.
        standIn = await startStandIn(() => ({ body: [
            { type: 'response.created', response: { id: 'install-check' } },
            { type: 'response.output_item.done', item: { type: 'message', role: 'assistant', id: 'answer', content: [{ type: 'output_text', text: 'ok' }] } },
            { type: 'response.completed', response: { id: 'install-check', usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } }
        ].map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('') }));
        const modelArgs = [
            '-c', 'model="harness"', '-c', 'model_provider="harness"',
            '-c', 'model_providers.harness.name="harness"',
            '-c', `model_providers.harness.base_url="${standIn.base}/v1"`,
            '-c', 'model_providers.harness.wire_api="responses"'
        ],
            result = await runAgent('codex', [
                'exec', '--skip-git-repo-check', '--ephemeral', '--sandbox', 'danger-full-access', ...modelArgs,
                'Say ok.'
            ], { env, cwd: box.project });

        assert.equal(result.code, 0, result.stdout + result.stderr);
        const request = standIn.modelRequests.find(({ url }) => url.startsWith('/v1/responses'));

        assert.ok(request, 'Codex never reached the stand-in model');
        const text = [request.body.instructions ?? '', ...(request.body.input ?? []).map((item) =>
                (item.content ?? []).map((part) => part.text ?? '').join('\n'))].join('\n'),
            manifest = JSON.parse(fs.readFileSync(path.join(installedPath, 'manifest.json'), 'utf8'));

        // No hook runs, untrusted or absent, so the model gets the skills and no mandate.
        assertSkillsListed('Codex installer', text, (skill) => new RegExp(`^- postman:${skill}: `, 'm'));
        assert.doesNotMatch(text, /<EXTREMELY_IMPORTANT>/, 'Codex ran a Postman hook, but nothing trusted it');

        assert.deepEqual(snapshot(installedPath), before, 'a later Codex session changed cached contents');
        await assertNoneTrusted();

        assert.deepEqual(snapshot(installedPath), before);
        assert.deepEqual(rpcChanges, [], 'app-server changed cached files');

        // Only after the fresh-user case: exercise both historical registrations.
        // Seed the legacy ref through Codex's config writer so this test keeps
        // working when the unused remote release branch is eventually deleted.
        for (const ref of ['codex-release', null]) {
            if (ref) {
                await system.withJsonRpc('codex', ['app-server'], async (rpc) => {
                    await rpc.request('initialize', { clientInfo: { name: 'postman-installer-smoke', version: '1' } });
                    rpc.notify('initialized');
                    await writeTestConfig(rpc, [{ keyPath: 'marketplaces.postman.ref', value: ref, mergeStrategy: 'upsert' }], 'seed the legacy marketplace ref');
                });
            }
            else {
                // Removing the marketplace uninstalls its plugin too.
                for (const args of [
                    ['plugin', 'marketplace', 'remove', 'postman', '--json'],
                    ['plugin', 'marketplace', 'add', REPO, '--json'],
                    ['plugin', 'marketplace', 'upgrade', 'postman', '--json'],
                    ['plugin', 'add', 'postman@postman', '--json']
                ]) {
                    const result = await system.run('codex', args);

                    assert.equal(result.code, 0, result.stdout + result.stderr);
                }
            }

            assert.equal(await registeredRef(system), ref);
            await runInstall();
            assert.equal(await registeredRef(system), ref === null ? null : BRANCH);
            await assertNoneTrusted();
            assert.equal(logs.some((line) => line.includes('marketplace remove')), ref !== null,
                'only the legacy release branch needs re-registration');
            // Re-cloning creates new Git metadata and installation timestamps;
            // compare payloads here, while RPC snapshots above include all files.
            assert.deepEqual(snapshot(cachePath, { includeMetadata: false }), contentBefore, 'migration must deliver the same main content');
        }
        assert.deepEqual(rpcChanges, [], 'migration app-server startup changed cached files');

        const versionText = (await system.probe('codex', ['--version'])).stdout.trim();

        console.log(`${versionText}: installs from main; migrates codex-release and preserves unpinned main registrations; no Postman hook trusted after any install; dry run writes nothing; ${manifest.skills.length} skills and no mandate reach the model; ${Object.keys(before).length} cached files unchanged by app-server`);
    }
    finally {
        standIn?.server.close();
        process.chdir(previousCwd);
        box.remove();
    }
}
