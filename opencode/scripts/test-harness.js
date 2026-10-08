#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnCliSync } from '../../scripts/lib/cli.js';
import {
    ENTRY_SKILL, assertMandate, assertMcpHeaders, assertSkillsListed, chatCompletion, mandatedSkill, pointMcpAt,
    runAgent, skillExcerpt, startStandIn
} from '../../scripts/lib/harness.js';
import { resolveOpenCodeExecutable } from './lib/opencode-executable.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'),
    repoRoot = path.dirname(root),
    // .native expands a Windows short name (RUNNER~1), which OpenCode reports in full.
    temporary = fs.realpathSync.native(
        fs.mkdtempSync(path.join(os.tmpdir(), 'postman-opencode-harness-'))
    ),
    configHome = path.join(temporary, 'xdg-config'),
    openCodeConfig = path.join(configHome, 'opencode'),
    cloneDirectory = path.join(openCodeConfig, 'postman-plugin'),
    projectDirectory = path.join(temporary, 'project'),
    nestedDirectory = path.join(projectDirectory, 'services', 'orders'),
    openCode = resolveOpenCodeExecutable(root),
    installedSkills = path.join('postman-plugin', 'skills'),
    // Must stay identical to the shim opencode/mirror-readme.md tells users to write.
    shim = "export { default } from '../postman-plugin/opencode/src/index.ts';\n";

function run (command, argumentsList, options = {}) {
    const result = spawnCliSync(command, argumentsList, {
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

/** The session's first turn loads the entry skill by the name the mandate gives it, its second says "ok". */
function answer (request, body) {
    if (!request.url.endsWith('/chat/completions') || !body.tools?.length) {
        return { body: chatCompletion.say('ok') };
    }

    return chatCompletion.hasToolResult(body) ?
        { body: chatCompletion.say('ok') } :
        { body: chatCompletion.call('skill', { name: mandatedSkill(chatCompletion.transcript(body)) }) };
}

let standIn;

try {
    standIn = await startStandIn(answer);
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

    // Offline: the clone's MCP server and the model are both the local stand-in.
    pointMcpAt(path.join(cloneDirectory, 'mcp.opencode.json'), standIn.mcpUrl, 'mcp');
    fs.writeFileSync(
        path.join(projectDirectory, 'opencode.json'),
        `${JSON.stringify({
            $schema: 'https://opencode.ai/config.json',
            model: 'harness/echo',
            provider: {
                harness: {
                    npm: '@ai-sdk/openai-compatible',
                    name: 'Harness',
                    options: { baseURL: `${standIn.base}/v1`, apiKey: 'harness' },
                    models: { echo: { name: 'echo', tool_call: true } }
                }
            }
        }, null, 2)}\n`,
        'utf8'
    );

    const environment = {
            ...process.env,
            OPENCODE_DISABLE_CLAUDE_CODE_SKILLS: '1',
            OPENCODE_DISABLE_EXTERNAL_SKILLS: '1',
            // OpenCode finds the project from $PWD, not its working directory; inherited, it is this repository.
            PWD: nestedDirectory,
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

    // The session reads the real skill bodies, not the shortened ones `debug skill` needed.
    for (const skill of manifest.skills) {
        copyFromRepo(path.join('skills', skill.name, 'SKILL.md'));
    }

    const session = await runAgent(openCode, ['run', '--format', 'json', 'Say ok.'], { cwd: nestedDirectory, env: environment }),
        turns = standIn.modelRequests.filter(({ url, body }) => url.endsWith('/chat/completions') && body.tools?.length);

    assert.equal(session.code, 0, `opencode exited ${session.code}\n${session.stdout}\n${session.stderr}`);
    assert.equal(turns.length, 2, `opencode ran ${turns.length} turns, not two\n${session.stdout}\n${session.stderr}`);

    const [first, second] = turns.map(({ body }) => chatCompletion.transcript(body));

    assertSkillsListed('OpenCode', first, (skill) => new RegExp(`<name>${skill}</name>`));
    assertMandate('OpenCode', first, { namespaced: false });
    assert.ok(second.includes(skillExcerpt(ENTRY_SKILL)), `the mandated skill did not load:\n${second.slice(-800)}`);
    assertMcpHeaders('OpenCode', standIn.mcpRequests, JSON.parse(fs.readFileSync(path.join(repoRoot, 'mcp.opencode.json'), 'utf8')).mcp.postman.headers);

    console.log(`OpenCode loaded the global local plugin and all ${actualNames.length} Postman skills from a nested directory, and sent the model the mandate and the skills.`);
}
finally {
    standIn?.server.close();
    fs.rmSync(temporary, { recursive: true, force: true });
}
