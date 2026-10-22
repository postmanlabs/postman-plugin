// Real installer + app-server, isolated from the user's configuration. The model is a local stand-in.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { codex, registeredRef } from '../dist/hosts/codex.js';
import { POSTMAN_HOOK_KEY } from '../dist/hosts/codex-hooks.js';
import { BRANCH, REPO } from '../dist/source.js';
import { run as install } from '../dist/run.js';
import { createSystem } from '../dist/system.js';
import { JsonRpcError } from '../dist/json-rpc.js';
import { assertMandate, runAgent, startStandIn, workspace } from '../../scripts/lib/harness.js';
import { checkCodexTui } from './codex-tui-check.js';

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
// Actual installer approval writes are never retried or hidden by this helper.
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

export async function checkCodexHookApproval () {
    const box = workspace('codex-installer-approval'),
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
                    // installedPath before the first approval app-server starts.
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

                return data.flatMap(({ hooks }) => hooks).find(({ key }) => key === POSTMAN_HOOK_KEY);
            });

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
        assert.match(logs.join('\n'), /Approved Postman's Codex session-start hook/);
        assert.doesNotMatch(logs.join('\n'), /Approve Postman's|<EXTREMELY_IMPORTANT>|session-start-context\.md|hooks[\\/]session-start/);

        const installedPath = cachePath,
            before = snapshot(installedPath),
            contentBefore = snapshot(installedPath, { includeMetadata: false }),
            trusted = await list();

        assert.equal(trusted?.trustStatus, 'trusted');
        assert.equal(await registeredRef(system), BRANCH, 'a fresh install must track main');
        assert.deepEqual(snapshot(installedPath), before, 'app-server startup changed the cached plugin');

        await runInstall({ isTTY: true });
        assert.match(logs.join('\n'), /already trusted/);
        assert.equal((await list()).trustStatus, 'trusted');

        const configBeforeDry = fs.readFileSync(path.join(codexHome, 'config.toml'), 'utf8'),
            dry = await runAgent(process.execPath, [cli, 'install', '--dry-run', '--agent', 'codex'], { env, cwd: box.project });

        assert.equal(dry.code, 0, dry.stdout + dry.stderr);
        assert.match(dry.stdout, /config\/batchWrite .*trusted_hash/);
        assert.doesNotMatch(dry.stdout, /\$ codex app-server/);
        assert.equal(fs.readFileSync(path.join(codexHome, 'config.toml'), 'utf8'), configBeforeDry);
        assert.deepEqual(snapshot(installedPath), before);
        assert.deepEqual(rpcChanges, [], 'app-server changed cached files, including during its first startup');

        // Use the real installed plugin unchanged. Only inference is redirected locally;
        // its MCP server still connects to Postman unauthenticated, just as for a new user.
        standIn = await startStandIn(() => ({ body: [
            { type: 'response.created', response: { id: 'approval-check' } },
            { type: 'response.output_item.done', item: { type: 'message', role: 'assistant', id: 'answer', content: [{ type: 'output_text', text: 'ok' }] } },
            { type: 'response.completed', response: { id: 'approval-check', usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } }
        ].map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('') }));
        const modelArgs = [
            '-c', 'model="harness"', '-c', 'model_provider="harness"',
            '-c', 'model_providers.harness.name="harness"',
            '-c', `model_providers.harness.base_url="${standIn.base}/v1"`,
            '-c', 'model_providers.harness.wire_api="responses"'
        ],
            tui = (expectReview) => checkCodexTui({
                // A pinned older Codex must reach hook review, not its unrelated
                // update-available modal, which depends on a background HTTP check.
                args: ['--no-alt-screen', '-c', 'check_for_update_on_startup=false', ...modelArgs],
                env, cwd: box.project, expectReview
            }),
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

        assertMandate('Codex installer', text, { namespaced: true });

        for (const { name } of manifest.skills) {
            assert.ok(text.includes(`- postman:${name}: `), `model request is missing skill ${name}`);
        }

        assert.deepEqual(snapshot(installedPath), before, 'a later Codex session changed cached contents');
        assert.equal((await list()).trustStatus, 'trusted', 'approval must survive the later session');

        if (process.platform === 'linux') {
            // Only after the fresh installer has completed, trust this throwaway
            // project so folder review cannot hide hook review. No hook trust is
            // changed here. Older TUI versions ignore a CLI project-trust override.
            await system.withJsonRpc('codex', ['app-server'], async (rpc) => {
                await rpc.request('initialize', { clientInfo: { name: 'postman-installer-smoke', version: '1' } });
                rpc.notify('initialized');
                await writeTestConfig(rpc, [{ keyPath: 'projects', value: { [box.project]: { trust_level: 'trusted' } }, mergeStrategy: 'upsert' }], 'trust the test project');
            });
            await tui(false);
        }

        // Make only this throwaway home's Postman approval stale, then exercise the
        // real CLI update path without an extra flag or an interactive terminal.
        await system.withJsonRpc('codex', ['app-server'], async (rpc) => {
            await rpc.request('initialize', { clientInfo: { name: 'postman-installer-smoke', version: '1' } });
            rpc.notify('initialized');
            await writeTestConfig(rpc, [{ keyPath: 'hooks.state', value: { [POSTMAN_HOOK_KEY]: { trusted_hash: `sha256:${'0'.repeat(64)}` } }, mergeStrategy: 'upsert' }], 'make hook trust stale for the negative control');
        });
        assert.equal((await list()).trustStatus, 'modified');

        if (process.platform === 'linux') {
            // Negative control proves the test can actually reach the warning; it
            // exits without selecting an approval or sending anything to the model.
            await tui(true);
        }
        const updated = await runAgent(process.execPath, [cli, 'install', '--yes', '--agent', 'codex'], { env, cwd: box.project });

        assert.equal(updated.code, 0, updated.stdout + updated.stderr);
        assert.match(updated.stdout, /Approved Postman's Codex session-start hook/);
        assert.doesNotMatch(updated.stdout, /Approve Postman's|<EXTREMELY_IMPORTANT>|session-start-context\.md|hooks[\\/]session-start/);
        assert.equal((await list()).trustStatus, 'trusted');

        if (process.platform === 'linux') {
            await tui(false);
        }
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
            assert.equal((await list()).trustStatus, 'trusted');
            assert.equal(logs.some((line) => line.includes('marketplace remove')), ref !== null,
                'only the legacy release branch needs re-registration');
            // Re-cloning creates new Git metadata and installation timestamps;
            // compare payloads here, while RPC snapshots above include all files.
            assert.deepEqual(snapshot(cachePath, { includeMetadata: false }), contentBefore, 'migration must deliver the same main content');

            if (process.platform === 'linux') {
                await tui(false);
            }
        }
        assert.deepEqual(rpcChanges, [], 'migration app-server startup changed cached files');

        const versionText = (await system.probe('codex', ['--version'])).stdout.trim();

        console.log(`${versionText}: installs from main; migrates codex-release and preserves unpinned main registrations; fresh and modified hooks automatically trusted; trusted reruns skip approval; dry run writes nothing; mandate and ${manifest.skills.length} skills reach the model without bypass; ${Object.keys(before).length} cached files unchanged by app-server; ${process.platform === 'linux' ? 'TUI warning appears for modified trust and disappears after installation and migration' : 'TUI check is Linux-only (trust state checked)'}`);
    }
    finally {
        standIn?.server.close();
        process.chdir(previousCwd);
        box.remove();
    }
}
