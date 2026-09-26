#!/usr/bin/env node
'use strict';

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolveOpenCodeExecutable } from './lib/opencode-executable.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'),
    temporary = fs.realpathSync(
        fs.mkdtempSync(path.join(os.tmpdir(), 'postman-opencode-harness-'))
    ),
    packageDirectory = path.join(temporary, 'package'),
    npmCache = path.join(temporary, 'npm-cache'),
    projectDirectory = path.join(temporary, 'project'),
    pluginDirectory = path.join(projectDirectory, '.opencode', 'plugins'),
    nestedDirectory = path.join(projectDirectory, 'services', 'orders'),
    openCode = resolveOpenCodeExecutable(root),
    npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';

const npmEnvironment = {
    ...process.env,
    npm_config_cache: npmCache
};

function run (command, argumentsList, options = {}) {
    const result = spawnSync(command, argumentsList, {
        cwd: options.cwd || root,
        encoding: 'utf8',
        env: options.env || process.env,
        maxBuffer: 16 * 1024 * 1024,
        timeout: 120000
    });

    if (result.status !== 0) {
        throw new Error([
            `${command} ${argumentsList.join(' ')} exited ${result.status}`,
            result.stdout,
            result.stderr,
            result.error?.message
        ].filter(Boolean).join('\n'));
    }

    return result.stdout;
}

function trailingJsonArray (output) {
    const lines = output.split('\n'),
        start = lines.findIndex((line) => line.trim() === '[');

    if (start === -1) {
        throw new Error(`npm pack did not return JSON:\n${output}`);
    }

    return JSON.parse(lines.slice(start).join('\n'));
}

function sha256 (file) {
    return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

try {
    fs.mkdirSync(packageDirectory, { recursive: true });
    fs.mkdirSync(nestedDirectory, { recursive: true });
    fs.mkdirSync(pluginDirectory, { recursive: true });

    const packOutput = trailingJsonArray(run(npm, [
            'pack', '--json', '--silent', '--pack-destination', packageDirectory
        ], { env: npmEnvironment })),
        tarball = path.join(packageDirectory, packOutput[0].filename);

    fs.writeFileSync(path.join(projectDirectory, 'package.json'), '{"private":true}\n');
    run(npm, [
        'install', '--ignore-scripts', '--no-audit', '--no-fund', tarball
    ], { cwd: projectDirectory, env: npmEnvironment });

    const installedRoot = path.join(
            projectDirectory, 'node_modules', '@postman', 'opencode-plugin'
        ),
        pluginEntry = path.join(installedRoot, 'dist', 'index.js'),
        config = {
            $schema: 'https://opencode.ai/config.json',

            // Keep the runtime harness offline. Unit tests separately prove the
            // plugin adds the default MCP server when the user has not configured it.
            mcp: {
                postman: {
                    type: 'remote',
                    url: 'https://mcp.postman.com/minimal',
                    enabled: false
                }
            }
        };

    fs.writeFileSync(
        path.join(pluginDirectory, 'postman.js'),
        `export { PostmanPlugin } from ${JSON.stringify(pathToFileURL(pluginEntry).href)};\n`,
        'utf8'
    );

    fs.writeFileSync(
        path.join(projectDirectory, 'opencode.json'),
        `${JSON.stringify(config, null, 2)}\n`,
        'utf8'
    );

    const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));

    // Prove the tarball contains the canonical bytes before shortening the
    // skill bodies for `opencode debug skill`. OpenCode 1.18 truncates that
    // command's aggregate JSON around 64 KiB, which otherwise makes its output
    // invalid for a repository with this many full-length skills.
    for (const skill of manifest.skills) {
        for (const file of skill.files) {
            const installedFile = path.join(installedRoot, file.source);

            assert.equal(fs.statSync(installedFile).size, file.bytes);
            assert.equal(sha256(installedFile), file.sha256);
        }

        fs.writeFileSync(
            path.join(installedRoot, 'skills', skill.name, 'SKILL.md'),
            [
                '---',
                `name: ${skill.name}`,
                `description: ${JSON.stringify(skill.description)}`,
                '---',
                `# ${skill.name}`,
                ''
            ].join('\n'),
            'utf8'
        );
    }

    const environment = {
            ...process.env,
            OPENCODE_DISABLE_CLAUDE_CODE_SKILLS: '1',
            OPENCODE_DISABLE_EXTERNAL_SKILLS: '1',
            XDG_CACHE_HOME: path.join(temporary, 'xdg-cache'),
            XDG_CONFIG_HOME: path.join(temporary, 'xdg-config'),
            XDG_DATA_HOME: path.join(temporary, 'xdg-data'),
            XDG_STATE_HOME: path.join(temporary, 'xdg-state')
        },
        skills = JSON.parse(run(openCode, ['debug', 'skill'], {
            cwd: nestedDirectory, env: environment
        })),
        expectedNames = manifest.skills.map((skill) => skill.name).sort(),
        actualPostmanSkills = skills.filter((skill) => {
            return skill.location.startsWith(path.join(installedRoot, 'skills'));
        }),
        actualNames = actualPostmanSkills.map((skill) => skill.name).sort();

    assert.deepEqual(actualNames, expectedNames);
    assert.equal(actualPostmanSkills.every((skill) => skill.description), true);
    assert.equal(actualPostmanSkills.every((skill) => skill.content.trim().length > 0), true);
    assert.equal(
        actualPostmanSkills.find((skill) => skill.name === 'api-engineer')?.location,
        path.join(installedRoot, 'skills', 'api-engineer', 'SKILL.md')
    );

    console.log(`OpenCode loaded all ${actualNames.length} packaged Postman skills from a nested directory.`);
}
finally {
    fs.rmSync(temporary, { recursive: true, force: true });
}
