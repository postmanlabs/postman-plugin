#!/usr/bin/env node
// Installs Postman with OpenCode's own `plugin` command under a throwaway home, then runs one session
// against a stand-in model and Postman MCP server and checks what OpenCode sent them. The route is:
//   git       the mirror scripts/build-mirror.js builds from this checkout, as a one-commit repository tagged with
//             its version, through `#semver:*` as the installer and README install it
//   github    `github:postmanlabs/opencode-plugin#semver:*`, or PLUGIN_ADD_SPEC, from GitHub
// `github` installs what is released, so it checks the skills the installed copy declares.
// Needs an OpenCode with a `plugin` install command: OPENCODE_BIN, else the pinned CLI in node_modules, else
// `opencode` on PATH. No account is used.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
    ENTRY_SKILL, assertMandate, assertMcpHeaders, chatCompletion, commit,
    mandatedSkill, pointMcpAt, readJson, run, runAgent, skillExcerpt, skills, startStandIn, workspace
} from '../../scripts/lib/harness.js';
import { MIRROR_REPO, buildMirror } from './build-mirror.js';
import { resolveOpenCodeExecutable } from './lib/opencode-executable.js';

const RANGE = '#semver:*',
    PUBLISHED = { github: `github:${MIRROR_REPO}${RANGE}` },
    ROUTES = ['git', ...Object.keys(PUBLISHED)],
    route = process.argv[2],
    openCode = resolveOpenCodeExecutable(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')),
    // OpenCode 2 is its own CLI (`@opencode/cli`) with `plugin add`; OpenCode 1's command is `plugin <module>`.
    openCodeMajor = Number(run(openCode, ['--version']).match(/(\d+)\.\d+\.\d+/)[1]),
    ADD = openCodeMajor >= 2 ? ['plugin', 'add'] : ['plugin', '--global'],
    STANDALONE = openCodeMajor >= 2 ? ['--standalone'] : [];

assert.ok(ROUTES.includes(route), `usage: node scripts/test-plugin-add.js ${ROUTES.join('|')}`);

function findFile (directory, name) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const full = path.join(directory, entry.name);

        if (entry.isDirectory()) {
            const hit = findFile(full, name);

            if (hit) {
                return hit;
            }
        }
        else if (entry.name === name) {
            return full;
        }
    }
}

const { root, home, project, remove } = workspace(`opencode-plugin-add-${route}`),
    xdg = Object.fromEntries(['config', 'cache', 'data', 'state'].map((kind) => [`XDG_${kind.toUpperCase()}_HOME`, path.join(root, `xdg-${kind}`)])),
    nested = path.join(project, 'services', 'orders');
let standIn;

try {
    standIn = await startStandIn((request, body) => {
        if (!request.url.endsWith('/chat/completions') || !body.tools?.length) {
            return { body: chatCompletion.say('ok') };
        }

        // OpenCode 1's skill tool takes `name`; OpenCode 2's takes `id`.
        const argument = body.tools.find(({ function: tool }) => tool.name === 'skill')?.function.parameters?.properties?.id ? 'id' : 'name';

        return chatCompletion.hasToolResult(body) ?
            { body: chatCompletion.say('ok') } :
            { body: chatCompletion.call('skill', { [argument]: mandatedSkill(chatCompletion.transcript(body)) }) };
    });
    fs.mkdirSync(nested, { recursive: true });

    // A new user's state: no config directory, no marketplace, an empty npm config.
    const environment = { ...process.env, HOME: home, USERPROFILE: home, ...xdg, PWD: nested, NPM_CONFIG_USERCONFIG: path.join(root, 'npmrc'), OPENCODE_DISABLE_CLAUDE_CODE_SKILLS: '1', OPENCODE_DISABLE_EXTERNAL_SKILLS: '1' };
    // OpenCode 2 prefers OPENCODE_CONFIG_DIR to the XDG directory, so an inherited one would edit the contributor's own config.
    delete environment.OPENCODE_CONFIG_DIR;
    let spec;

    if (route in PUBLISHED) {
        spec = process.env.PLUGIN_ADD_SPEC || PUBLISHED[route];
    }
    else {
        const mirror = path.join(root, MIRROR_REPO.split('/')[1]);

        buildMirror(mirror);

        commit(mirror);
        // A release tag, as release.yml puts on the mirror; the range resolves to it. Stable even for a prerelease
        // source version, such as 0.2.0-rc.1, whose own tag the range would skip.
        run('git', ['-c', 'user.name=harness', '-c', 'user.email=harness@localhost', '-c', 'tag.gpgsign=false', 'tag', '-a', '-m', 'harness', `v${readJson(path.join(mirror, 'package.json')).version.split('-')[0]}`], { cwd: mirror });
        spec = `git+${pathToFileURL(mirror).href}${RANGE}`;
    }

    const added = await runAgent(openCode, [...ADD, spec], { cwd: nested, env: environment });

    assert.equal(added.code, 0, `opencode ${ADD.join(' ')} ${spec} exited ${added.code}\n${added.stdout}\n${added.stderr}`);
    assert.match(added.stdout, openCodeMajor >= 2 ? /installed and added/ : /Plugin config updated/, added.stdout);

    // Both record it in the global config, as `opencode.json` or `opencode.jsonc`; the harness's own project config is not written yet.
    const configFile = findFile(root, 'opencode.json') || findFile(root, 'opencode.jsonc');

    assert.ok(configFile, 'plugin add wrote no opencode.json');
    assert.ok(fs.readFileSync(configFile, 'utf8').includes(spec), `plugin add did not record ${spec} in ${configFile}`);

    // Offline: the installed copy's MCP server and the model are both the local stand-in.
    const installedMcp = findFile(xdg.XDG_CACHE_HOME, 'mcp.opencode.json');

    assert.ok(installedMcp, 'the installed package has no mcp.opencode.json beside the entrypoint');
    const mcpConfig = readJson(installedMcp);

    const installedRoot = path.dirname(installedMcp),
        installedSkills = readJson(path.join(installedRoot, 'manifest.json')).skills.map((skill) => skill.name);

    // Packing or copying must not drop a skill the checkout declares.
    if (!(route in PUBLISHED)) {
        assert.deepEqual(installedSkills, skills, 'the installed package declares other skills than this checkout');
    }

    pointMcpAt(installedMcp, standIn.mcpUrl, 'mcp');
    fs.writeFileSync(path.join(project, 'opencode.json'), `${JSON.stringify({
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
    }, null, 2)}\n`);

    const session = await runAgent(openCode, ['run', ...STANDALONE, '--format', 'json', 'Say ok.'], { cwd: nested, env: environment }),
        turns = standIn.modelRequests.filter(({ url, body }) => url.endsWith('/chat/completions') && body.tools?.length);

    assert.equal(session.code, 0, `opencode exited ${session.code}\n${session.stdout}\n${session.stderr}`);
    assert.equal(turns.length, 2, `opencode ran ${turns.length} turns, not two\n${session.stdout}\n${session.stderr}`);

    const [first, second] = turns.map(({ body }) => chatCompletion.transcript(body));

    for (const skill of installedSkills) {
        assert.match(first, new RegExp(`<name>${skill}</name>`), `the skill ${skill} is not in the skill list OpenCode sent the model`);
    }

    assertMandate('OpenCode', first, { namespaced: false });
    assert.ok(second.includes(skillExcerpt(ENTRY_SKILL, installedRoot)), `the mandated skill did not load:\n${second.slice(-800)}`);
    assertMcpHeaders('OpenCode', standIn.mcpRequests, mcpConfig.mcp.postman.headers);

    // OpenCode 1 has no remove command; its entry is deleted from the config by hand (see README.md's OpenCode section).
    if (openCodeMajor >= 2) {
        const removed = await runAgent(openCode, ['plugin', 'remove', spec], { cwd: nested, env: environment });

        assert.equal(removed.code, 0, `opencode plugin remove ${spec} exited ${removed.code}\n${removed.stdout}\n${removed.stderr}`);
        assert.ok(!fs.readFileSync(configFile, 'utf8').includes(spec), `plugin remove left ${spec} in ${configFile}`);
    }

    console.log(`\`opencode ${ADD.join(' ')}\` from ${route} (${spec}) installed Postman; OpenCode sent the model the mandate and every skill, and connected to the MCP server.`);
}
finally {
    standIn?.server.close();
    remove();
}
