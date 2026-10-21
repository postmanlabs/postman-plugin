// Real installer + app-server, isolated from the user's configuration. The model is a local stand-in.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { codex } from '../dist/hosts/codex.js';
import { POSTMAN_HOOK_KEY } from '../dist/hosts/codex-hooks.js';
import { run as install } from '../dist/run.js';
import { createSystem } from '../dist/system.js';
import { assertMandate, runAgent, startStandIn, workspace } from '../../scripts/lib/harness.js';

export function snapshot (root) {
    const files = {};

    function walk (dir) {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
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

export async function checkCodexHookApproval () {
    const box = workspace('codex-installer-approval'),
        previousCwd = process.cwd(),
        codexBin = process.env.CODEX_BIN || 'codex',
        cli = path.resolve(import.meta.dirname, '../dist/cli.js'),
        env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(CODEX_|OPENAI_)/.test(key)));
    let standIn;

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
            system = { ...baseSystem, async withJsonRpc (...args) {
                const root = path.join(codexHome, 'plugins', 'cache', 'postman', 'postman'),
                    before = fs.existsSync(root) ? snapshot(root) : {};

                try {
                    return await baseSystem.withJsonRpc(...args);
                }
                finally {
                    const after = fs.existsSync(root) ? snapshot(root) : {};

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

        assert.ok(!fs.existsSync(codexHome));
        await runInstall();
        assert.match(logs.join('\n'), /Approved Postman's Codex session-start hook/);
        assert.doesNotMatch(logs.join('\n'), /Approve Postman's|<EXTREMELY_IMPORTANT>|session-start-context\.md|hooks[\\/]session-start/);

        const plugins = JSON.parse((await system.probe('codex', ['plugin', 'list', '--json'])).stdout),
            version = plugins.installed.find(({ pluginId }) => pluginId === 'postman@postman').version,
            installedPath = path.join(codexHome, 'plugins', 'cache', 'postman', 'postman', version),
            before = snapshot(installedPath),
            trusted = await list();

        assert.equal(trusted?.trustStatus, 'trusted');
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
        const result = await runAgent('codex', [
            'exec', '--skip-git-repo-check', '--ephemeral', '--sandbox', 'danger-full-access',
            '-c', 'model="harness"', '-c', 'model_provider="harness"',
            '-c', 'model_providers.harness.name="harness"',
            '-c', `model_providers.harness.base_url="${standIn.base}/v1"`,
            '-c', 'model_providers.harness.wire_api="responses"',
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

        // Make only this throwaway home's Postman approval stale, then exercise the
        // real CLI update path without an extra flag or an interactive terminal.
        await system.withJsonRpc('codex', ['app-server'], async (rpc) => {
            await rpc.request('initialize', { clientInfo: { name: 'postman-installer-smoke', version: '1' } });
            rpc.notify('initialized');
            await rpc.request('config/batchWrite', {
                edits: [{ keyPath: 'hooks.state', value: { [POSTMAN_HOOK_KEY]: { trusted_hash: `sha256:${'0'.repeat(64)}` } }, mergeStrategy: 'upsert' }],
                reloadUserConfig: true
            });
        });
        assert.equal((await list()).trustStatus, 'modified');
        const updated = await runAgent(process.execPath, [cli, 'install', '--yes', '--agent', 'codex'], { env, cwd: box.project });

        assert.equal(updated.code, 0, updated.stdout + updated.stderr);
        assert.match(updated.stdout, /Approved Postman's Codex session-start hook/);
        assert.doesNotMatch(updated.stdout, /Approve Postman's|<EXTREMELY_IMPORTANT>|session-start-context\.md|hooks[\\/]session-start/);
        assert.equal((await list()).trustStatus, 'trusted');
        assert.deepEqual(snapshot(installedPath), before);
        assert.deepEqual(rpcChanges, [], 'app-server changed cached files');

        const versionText = (await system.probe('codex', ['--version'])).stdout.trim();

        console.log(`${versionText}: fresh and modified hooks automatically trusted; trusted reruns skip approval; dry run writes nothing; mandate and ${manifest.skills.length} skills reach the model without bypass; ${Object.keys(before).length} cached files unchanged`);
    }
    finally {
        standIn?.server.close();
        process.chdir(previousCwd);
        box.remove();
    }
}
