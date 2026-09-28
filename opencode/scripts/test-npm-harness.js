#!/usr/bin/env node
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolveOpenCodeExecutable } from './lib/opencode-executable.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'),
    repoRoot = path.dirname(root),
    temporary = fs.realpathSync(
        fs.mkdtempSync(path.join(os.tmpdir(), 'postman-opencode-harness-'))
    ),
    packageDirectory = path.join(temporary, 'package'),
    loadDirectory = path.join(temporary, 'load'),
    npmCache = path.join(temporary, 'npm-cache'),
    projectDirectory = path.join(temporary, 'project'),
    nestedDirectory = path.join(projectDirectory, 'services', 'orders'),
    openCode = resolveOpenCodeExecutable(root),
    npm = process.platform === 'win32' ? 'npm.cmd' : 'npm',
    packagedSkill = path.join('@postman', 'opencode-plugin', 'assets', 'skills');

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
        timeout: 180000
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

function pack (cwd, destination, extraArguments = []) {
    const output = trailingJsonArray(run(npm, [
        'pack', '--json', '--silent', '--pack-destination', destination, ...extraArguments
    ], { cwd, env: npmEnvironment }));

    return path.join(destination, output[0].filename);
}

function sha256 (file) {
    return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

try {
    fs.mkdirSync(packageDirectory, { recursive: true });
    fs.mkdirSync(loadDirectory, { recursive: true });
    fs.mkdirSync(nestedDirectory, { recursive: true });

    const tarball = pack(root, packageDirectory);

    assert.equal(fs.existsSync(path.join(root, 'assets')), false, 'postpack left staged assets in the package directory');
    assert.equal(fs.existsSync(path.join(root, 'LICENSE')), false, 'postpack left a staged LICENSE in the package directory');

    fs.writeFileSync(path.join(projectDirectory, 'package.json'), '{"private":true}\n');
    run(npm, [
        'install', '--ignore-scripts', '--no-audit', '--no-fund', tarball
    ], { cwd: projectDirectory, env: npmEnvironment });

    const installedRoot = path.join(
            projectDirectory, 'node_modules', '@postman', 'opencode-plugin'
        ),
        installedAssets = path.join(installedRoot, 'assets'),
        manifest = JSON.parse(fs.readFileSync(path.join(repoRoot, 'manifest.json'), 'utf8'));

    assert.equal(fs.existsSync(path.join(installedRoot, 'LICENSE')), true);
    assert.deepEqual(
        JSON.parse(fs.readFileSync(path.join(installedAssets, 'mcp.opencode.json'), 'utf8')),
        JSON.parse(fs.readFileSync(path.join(repoRoot, 'mcp.opencode.json'), 'utf8'))
    );

    // Prove the tarball carries the canonical bytes, then shorten the skill bodies
    // and repack: OpenCode 1.18 truncates `debug skill` output written to a pipe
    // around 64 KiB, which would otherwise make it invalid JSON.
    for (const skill of manifest.skills) {
        for (const file of skill.files) {
            const installedFile = path.join(installedAssets, file.source);

            assert.equal(fs.statSync(installedFile).size, file.bytes);
            assert.equal(sha256(installedFile), file.sha256);
        }

        fs.writeFileSync(
            path.join(installedAssets, 'skills', skill.name, 'SKILL.md'),
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

    const loadTarball = pack(installedRoot, loadDirectory, ['--ignore-scripts']),
        config = {
            $schema: 'https://opencode.ai/config.json',

            // OpenCode's own npm path: install, package.json entry, engines gate, id.
            plugin: [`@postman/opencode-plugin@file:${loadTarball}`],

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
        path.join(projectDirectory, 'opencode.json'),
        `${JSON.stringify(config, null, 2)}\n`,
        'utf8'
    );

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
        actualPostmanSkills = skills.filter((skill) => skill.location.includes(packagedSkill)),
        actualNames = actualPostmanSkills.map((skill) => skill.name).sort();

    assert.deepEqual(actualNames, expectedNames);
    assert.equal(actualPostmanSkills.every((skill) => skill.description), true);
    assert.equal(actualPostmanSkills.every((skill) => skill.content.trim().length > 0), true);
    assert.equal(
        actualPostmanSkills.find((skill) => skill.name === 'api-engineer')?.location
            .endsWith(path.join(packagedSkill, 'api-engineer', 'SKILL.md')),
        true
    );

    console.log(`OpenCode installed the package and loaded all ${actualNames.length} Postman skills from a nested directory.`);
}
finally {
    fs.rmSync(temporary, { recursive: true, force: true });
}
