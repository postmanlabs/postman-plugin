#!/usr/bin/env node
// `smoke-check.js installed|removed <agent>...` asks each agent, or reads the files it loads from,
// whether Postman is there. The installer's exit code can't say: an agent it skips exits 0 too.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnCliSync } from '../../scripts/lib/cli.js';
import { OPENCODE_SHIM } from '../dist/source.js';

const [mode, ...agents] = process.argv.slice(2),
    home = os.homedir(),
    openCodeConfig = path.join(process.env.XDG_CONFIG_HOME || path.join(home, '.config'), 'opencode'),
    kimiStore = path.join(process.env.KIMI_CODE_HOME || path.join(home, '.kimi-code'), 'plugins', 'installed.json');

function output (command, args) {
    const result = spawnCliSync(command, args, { encoding: 'utf8', timeout: 120000 });

    assert.equal(result.status, 0, [`${command} ${args.join(' ')} exited ${result.status}`, result.stdout, result.stderr, result.error?.message].filter(Boolean).join('\n'));

    return result.stdout;
}

const lines = (text, needle) => text.split(/\r?\n/).filter((line) => line.includes(needle)).map((line) => line.trim().replace(/\s+/g, ' ')),
    present = (...files) => files.filter((file) => fs.existsSync(file));

// `expected` must all be found after an install; nothing at all may be found after a remove.
const AGENTS = {
    'claude-code': {
        expected: ['postman@claude-plugins-official [user]'],
        found: () => JSON.parse(output('claude', ['plugin', 'list', '--json']))
            .filter(({ id }) => id.startsWith('postman@')).map(({ id, scope }) => `${id} [${scope}]`)
    },
    codex: {
        expected: ['postman@postman'],
        found: () => JSON.parse(output('codex', ['plugin', 'list', '--json'])).installed
            .map(({ pluginId }) => pluginId).filter((id) => id.startsWith('postman@'))
    },
    cursor: {
        expected: [path.join(home, '.cursor', 'plugins', 'local', 'postman', '.cursor-plugin', 'plugin.json')],
        found: () => present(path.join(home, '.cursor', 'plugins', 'local', 'postman', '.cursor-plugin', 'plugin.json'))
    },
    factory: {
        expected: ['postman@postman-plugin [user]'],
        found: () => lines(output('droid', ['plugin', 'list', '--scope', 'user']), 'postman@')
    },
    kimi: {
        expected: ['postman'],
        found: () => (fs.existsSync(kimiStore) ? JSON.parse(fs.readFileSync(kimiStore, 'utf8')).plugins : [])
            .map(({ id }) => id).filter((id) => id === 'postman')
    },
    opencode: {
        expected: [path.join(openCodeConfig, 'postman-plugin', 'opencode', 'src', 'index.ts'), path.join(openCodeConfig, 'plugins', 'postman.ts')],
        found: () => [
            ...present(path.join(openCodeConfig, 'postman-plugin', 'opencode', 'src', 'index.ts')),
            ...present(path.join(openCodeConfig, 'plugins', 'postman.ts'))
                .filter((shim) => fs.readFileSync(shim, 'utf8') === OPENCODE_SHIM)
        ]
    },
    pi: {
        expected: ['npm:@postman/postman-plugin'],
        found: () => lines(output('pi', ['list']), '@postman/postman-plugin')
    }
};

assert.ok(['installed', 'removed'].includes(mode) && agents.length > 0, 'usage: smoke-check.js installed|removed <agent>...');

for (const agent of agents) {
    assert.ok(AGENTS[agent], `no check for the agent ${agent}`);

    const { expected, found } = AGENTS[agent],
        actual = found();

    if (mode === 'installed') {
        assert.deepEqual(expected.filter((entry) => !actual.includes(entry)), [], `${agent} is missing Postman; it has ${JSON.stringify(actual)}`);
    }
    else {
        assert.deepEqual(actual, [], `${agent} still has Postman`);
    }

    console.log(`${agent}: ${mode === 'installed' ? actual.join(', ') : 'nothing of Postman left'}`);
}
