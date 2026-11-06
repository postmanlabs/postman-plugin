#!/usr/bin/env node
// `smoke-check.js installed|removed <agent>...` asks each agent, or reads the files it loads from,
// whether Postman is there. The installer's exit code can't say: an agent it skips exits 0 too.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnCliSync } from '../../scripts/lib/cli.js';
import { registeredRef } from '../dist/hosts/codex.js';
import { installedPlugins } from '../dist/hosts/factory.js';
import { parseJsonc } from '../dist/hosts/opencode-config.js';
import { cachedCopy } from '../dist/hosts/opencode.js';
import { BRANCH, OPENCODE_SHIM, OPENCODE_SPEC } from '../dist/source.js';
import { checkCodexInstall } from './codex-install-check.js';
import { POSTMAN_HOOK_KEY } from '../dist/hosts/codex-hooks.js';
import { createSystem } from '../dist/system.js';

const [mode, ...agents] = process.argv.slice(2),
    home = os.homedir(),
    // What the installer installs: the spec installer smoke tells it to, else this repo's default branch.
    openCodeSpec = process.env.POSTMAN_PLUGIN_OPENCODE_SPEC || OPENCODE_SPEC,
    openCodeConfig = path.join(process.env.XDG_CONFIG_HOME || path.join(home, '.config'), 'opencode'),
    kimiStore = path.join(process.env.KIMI_CODE_HOME || path.join(home, '.kimi-code'), 'plugins', 'installed.json');

function output (command, args) {
    const result = spawnCliSync(command, args, { encoding: 'utf8', timeout: 120000 });

    assert.equal(result.status, 0, [`${command} ${args.join(' ')} exited ${result.status}`, result.stdout, result.stderr, result.error?.message].filter(Boolean).join('\n'));

    return result.stdout;
}

/** Whether the Codex user config still holds the approval `install` wrote for Postman's session-start hook. */
async function codexHookApproved () {
    const layers = await createSystem({ log: () => {} }).withJsonRpc('codex', ['app-server'], async (rpc) => {
        await rpc.request('initialize', { clientInfo: { name: 'postman-installer-smoke', version: '1' } });
        rpc.notify('initialized');

        return (await rpc.request('config/read', { includeLayers: true })).layers;
    });

    assert.ok(Array.isArray(layers), 'codex app-server config/read returned no layers');

    return layers.some((layer) => layer.name?.type === 'user' && layer.config?.hooks?.state?.[POSTMAN_HOOK_KEY] !== undefined);
}

const lines = (text, needle) => text.split(/\r?\n/).filter((line) => line.includes(needle)).map((line) => line.trim().replace(/\s+/g, ' ')),
    present = (...files) => files.filter((file) => fs.existsSync(file));

// `expected` must all be found after an install; nothing at all may be found after a remove, and `alsoRemoved`
// checks what a remove takes out besides the plugin.
const AGENTS = {
    'claude-code': {
        expected: ['postman@claude-plugins-official [user]'],
        found: () => JSON.parse(output('claude', ['plugin', 'list', '--json']))
            .filter(({ id }) => id.startsWith('postman@')).map(({ id, scope }) => `${id} [${scope}]`),
        alsoRemoved: () => assert.ok(!JSON.parse(output('claude', ['plugin', 'marketplace', 'list', '--json'])).some(({ name }) => name === 'postman'),
            'Claude Code still has the postman marketplace')
    },
    codex: {
        expected: ['postman@postman'],
        found: () => JSON.parse(output('codex', ['plugin', 'list', '--json'])).installed
            .map(({ pluginId }) => pluginId).filter((id) => id.startsWith('postman@')),
        alsoInstalled: async () => assert.ok([BRANCH, null].includes(await registeredRef(createSystem({ log: () => {} }))),
            `Codex's config/read doesn't report the postman marketplace tracking ${BRANCH}`),
        alsoRemoved: async () => {
            assert.ok(!(JSON.parse(output('codex', ['plugin', 'marketplace', 'list', '--json'])).marketplaces ?? []).some(({ name }) => name === 'postman'),
                'Codex still has the postman marketplace');
            assert.ok(!(await codexHookApproved()), 'Codex still holds the approval of Postman\'s session-start hook');
        }
    },
    copilot: {
        expected: ['postman@postman'],
        found: () => JSON.parse(output('copilot', ['plugin', 'list', '--json']))
            .filter(({ name }) => name === 'postman').map(({ name, marketplace }) => `${name}@${marketplace}`),
        alsoRemoved: () => assert.ok(!JSON.parse(output('copilot', ['plugin', 'marketplace', 'list', '--json'])).some(({ name }) => name === 'postman'),
            'Copilot CLI still has the postman marketplace')
    },
    cursor: {
        expected: [path.join(home, '.cursor', 'plugins', 'local', 'postman', '.cursor-plugin', 'plugin.json')],
        found: () => present(path.join(home, '.cursor', 'plugins', 'local', 'postman', '.cursor-plugin', 'plugin.json'))
    },
    factory: {
        expected: ['postman@postman-plugin [user]'],
        found: () => installedPlugins(output('droid', ['plugin', 'list', '--scope', 'user'])).filter((plugin) => plugin.startsWith('postman@')),
        alsoRemoved: () => assert.ok(!/^\s*postman-plugin\s/m.test(output('droid', ['plugin', 'marketplace', 'list'])),
            'Factory Droid still has the postman-plugin marketplace')
    },
    kimi: {
        expected: ['postman'],
        found: () => (fs.existsSync(kimiStore) ? JSON.parse(fs.readFileSync(kimiStore, 'utf8')).plugins : [])
            .map(({ id }) => id).filter((id) => id === 'postman')
    },
    opencode: {
        expected: [openCodeSpec],
        // The plugin's entry in the global config (`plugin` on OpenCode 1, `plugins` on OpenCode 2, in `.json` or `.jsonc`),
        // and anything left of the older clone-and-loader install.
        found: () => [
            ...['opencode.json', 'opencode.jsonc'].flatMap((name) => {
                const file = path.join(openCodeConfig, name),
                    config = fs.existsSync(file) ? parseJsonc(fs.readFileSync(file, 'utf8')) : null;

                return ['plugin', 'plugins'].flatMap((key) => (Array.isArray(config?.[key]) ? config[key] : []))
                    .map((entry) => (typeof entry === 'string' ? entry : Array.isArray(entry) ? entry[0] : entry?.package))
                    .filter((spec) => typeof spec === 'string' && (spec === openCodeSpec || /postmanlabs\/postman-plugin/i.test(spec)));
            }),
            ...present(path.join(openCodeConfig, 'postman-plugin', 'opencode', 'src', 'index.ts')),
            ...present(path.join(openCodeConfig, 'plugins', 'postman.ts'))
                .filter((shim) => fs.readFileSync(shim, 'utf8') === OPENCODE_SHIM)
        ],
        alsoRemoved: () => {
            const system = createSystem({ log: () => {} }),
                left = present(...[openCodeSpec, OPENCODE_SPEC].map((spec) => cachedCopy(system, spec)).flatMap((copy) => [copy, `${copy}.previous`]));

            assert.deepEqual(left, [], 'OpenCode 2 still has a cached copy of Postman');
        }
    },
    pi: {
        expected: ['npm:@postman/postman-plugin'],
        found: () => lines(output('pi', ['list']), '@postman/postman-plugin')
    }
};

if (mode === 'codex-install') {
    await checkCodexInstall();
    process.exit(0);
}

assert.ok(['installed', 'removed'].includes(mode) && agents.length > 0, 'usage: smoke-check.js installed|removed <agent>... | codex-install');

for (const agent of agents) {
    assert.ok(AGENTS[agent], `no check for the agent ${agent}`);

    const { expected, found, alsoInstalled, alsoRemoved } = AGENTS[agent],
        actual = found();

    if (mode === 'installed') {
        assert.deepEqual(expected.filter((entry) => !actual.includes(entry)), [], `${agent} is missing Postman; it has ${JSON.stringify(actual)}`);
        await alsoInstalled?.();
    }
    else {
        assert.deepEqual(actual, [], `${agent} still has Postman`);
        await alsoRemoved?.();
    }

    console.log(`${agent}: ${mode === 'installed' ? actual.join(', ') : 'nothing of Postman left'}`);
}
