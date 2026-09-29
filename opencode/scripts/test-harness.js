#!/usr/bin/env node
import assert from 'node:assert/strict';
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
    configHome = path.join(temporary, 'xdg-config'),
    openCodeConfig = path.join(configHome, 'opencode'),
    cloneDirectory = path.join(openCodeConfig, 'postman-plugin'),
    projectDirectory = path.join(temporary, 'project'),
    nestedDirectory = path.join(projectDirectory, 'services', 'orders'),
    openCode = resolveOpenCodeExecutable(root),
    installedSkills = path.join('postman-plugin', 'skills'),
    // Must stay identical to the shim opencode/README.md tells users to write.
    shim = "export { default } from '../postman-plugin/opencode/src/index.ts';\n";

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

function copyFromRepo (file) {
    fs.mkdirSync(path.dirname(path.join(cloneDirectory, file)), { recursive: true });
    fs.copyFileSync(path.join(repoRoot, file), path.join(cloneDirectory, file));
}

try {
    fs.mkdirSync(nestedDirectory, { recursive: true });
    fs.mkdirSync(path.join(openCodeConfig, 'plugins'), { recursive: true });

    const manifest = JSON.parse(fs.readFileSync(path.join(repoRoot, 'manifest.json'), 'utf8'));

    // The files a clone gives the plugin at runtime, laid out as the clone lays them out.
    for (const file of [
        'opencode/src/index.ts', 'hooks/session-start-context.md', 'manifest.json', 'mcp.opencode.json',
        ...manifest.skills.flatMap((skill) => skill.files.map((entry) => entry.source))
    ]) {
        copyFromRepo(file);
    }

    // OpenCode 1.18 truncates `debug skill` output written to a pipe around 64 KiB,
    // which would otherwise make it invalid JSON, so shorten the skill bodies.
    for (const skill of manifest.skills) {
        fs.writeFileSync(
            path.join(cloneDirectory, 'skills', skill.name, 'SKILL.md'),
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

    fs.writeFileSync(path.join(openCodeConfig, 'plugins', 'postman.ts'), shim, 'utf8');

    // Keep the runtime harness offline. Unit tests separately prove the plugin
    // adds the default MCP server when the user has not configured it.
    fs.writeFileSync(
        path.join(projectDirectory, 'opencode.json'),
        `${JSON.stringify({
            $schema: 'https://opencode.ai/config.json',
            mcp: {
                postman: {
                    type: 'remote',
                    url: 'https://mcp.postman.com/minimal',
                    enabled: false
                }
            }
        }, null, 2)}\n`,
        'utf8'
    );

    const environment = {
            ...process.env,
            OPENCODE_DISABLE_CLAUDE_CODE_SKILLS: '1',
            OPENCODE_DISABLE_EXTERNAL_SKILLS: '1',
            XDG_CACHE_HOME: path.join(temporary, 'xdg-cache'),
            XDG_CONFIG_HOME: configHome,
            XDG_DATA_HOME: path.join(temporary, 'xdg-data'),
            XDG_STATE_HOME: path.join(temporary, 'xdg-state')
        },
        skills = JSON.parse(run(openCode, ['debug', 'skill'], {
            cwd: nestedDirectory, env: environment
        })),
        expectedNames = manifest.skills.map((skill) => skill.name).sort(),
        actualPostmanSkills = skills.filter((skill) => skill.location.includes(installedSkills)),
        actualNames = actualPostmanSkills.map((skill) => skill.name).sort();

    assert.deepEqual(actualNames, expectedNames);
    assert.equal(actualPostmanSkills.every((skill) => skill.description), true);
    assert.equal(actualPostmanSkills.every((skill) => skill.content.trim().length > 0), true);
    assert.equal(
        actualPostmanSkills.find((skill) => skill.name === 'api-engineer')?.location
            .endsWith(path.join(installedSkills, 'api-engineer', 'SKILL.md')),
        true
    );

    console.log(`OpenCode loaded the global local plugin and all ${actualNames.length} Postman skills from a nested directory.`);
}
finally {
    fs.rmSync(temporary, { recursive: true, force: true });
}
