import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

// The hooks/hooks.json command's scripts, run as each agent runs them: the sh script, or on Windows
// its cmd.exe twin, which both Droid and Cursor's PowerShell pick there.
const hooksDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'hooks'),
    windows = process.platform === 'win32',
    read = (file) => fs.readFileSync(path.join(hooksDir, file), 'utf8'),
    // The mandate for a session in a repository with postman/.
    repoMandate = read('session-start-postman-dir.md'),
    light = read('session-start-context.md'),
    // Session directories: one with a postman/ directory, one without, and one where postman is only a file.
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'postman-plugin-repo-')),
    noRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'postman-plugin-no-repo-')),
    fileRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'postman-plugin-file-repo-')),
    bareNames = (text) => text.replace(/`postman:([a-z0-9-]*)`/g, '`$1`'),
    agentEnv = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^(CLAUDE|CURSOR|COPILOT|DROID)_PLUGIN_ROOT$|^(CLAUDE|CURSOR)_PROJECT_DIR$/i.test(name)));

/** `droidRoot` is Droid's `DROID_PLUGIN_ROOT` hook environment variable: set on Droid, absent everywhere else. */
function runHook (dir, droidRoot, env = {}, cwd = noRepo) {
    const options = { cwd, env: { ...agentEnv, ...(droidRoot && { DROID_PLUGIN_ROOT: droidRoot }), ...env }, encoding: 'utf8' },
        result = windows ?
            // `/s` drops the outer quotes, so cmd.exe runs the rest exactly as quoted here.
            spawnSync('cmd.exe', ['/d', '/s', '/c', `""${path.join(dir, 'session-start.cmd')}""`], { ...options, windowsVerbatimArguments: true }) :
            spawnSync(path.join(dir, 'session-start'), [], options);

    assert.equal(result.status, 0, result.stderr || result.error?.message);

    return result.stdout;
}

fs.mkdirSync(path.join(repo, 'postman'));
fs.writeFileSync(path.join(fileRepo, 'postman'), '');

/** Parsed the way Cursor and Copilot CLI parse a hook's stdout; Cursor drops anything else as `invalid_json`. */
function jsonOutput (stdout) {
    return JSON.parse(stdout.trim());
}

for (const [where, cwd, expected] of [['with a postman/ directory', repo, repoMandate], ['without one', noRepo, light]]) {
    test(`Claude Code gets the message byte for byte in a repository ${where}`, () => {
        assert.equal(runHook(hooksDir, '', {}, cwd), expected);
    });

    test(`Droid gets the message with bare skill names in a repository ${where}`, () => {
        assert.equal(runHook(hooksDir, hooksDir, {}, cwd), bareNames(expected));
    });

    test(`Cursor gets JSON whose additional_context is the message with bare skill names in a repository ${where}`, () => {
        assert.deepEqual(jsonOutput(runHook(hooksDir, '', { CURSOR_PLUGIN_ROOT: path.dirname(hooksDir) }, cwd)), { additional_context: bareNames(expected) });
    });

    test(`Copilot CLI gets JSON whose additionalContext is the message with bare skill names in a repository ${where}`, () => {
        const env = { COPILOT_PLUGIN_ROOT: path.dirname(hooksDir), CLAUDE_PLUGIN_ROOT: path.dirname(hooksDir) };

        assert.deepEqual(jsonOutput(runHook(hooksDir, '', env, cwd)), { additionalContext: bareNames(expected) });
    });
}

test('a repository with postman/ gets a mandate that names the directory and the entry skill', () => {
    const output = jsonOutput(runHook(hooksDir, '', { CURSOR_PLUGIN_ROOT: path.dirname(hooksDir) }, repo)).additional_context;

    assert.match(output, /^<EXTREMELY_IMPORTANT>\s*You have the Postman plugin/);
    assert.match(output, /This repository has a postman\/ directory/);
    assert.match(output, /`api-engineer` is the default entry point/);
});

test('a repository without postman/ gets the light note, which mandates nothing', () => {
    assert.doesNotMatch(light, /EXTREMELY_IMPORTANT|load the `/);
    assert.match(light, /api-engineer/);
});

test('the project directory an agent names wins over the working directory', () => {
    // Copilot CLI runs the hook in the plugin's directory and names the project in CLAUDE_PROJECT_DIR.
    assert.equal(runHook(hooksDir, '', { CLAUDE_PROJECT_DIR: repo }, noRepo), repoMandate);
    assert.equal(runHook(hooksDir, '', { CLAUDE_PROJECT_DIR: noRepo }, repo), light);
    assert.equal(runHook(hooksDir, '', { CURSOR_PROJECT_DIR: repo }, noRepo), repoMandate);
});

test('a file named postman is not a postman/ directory', () => {
    assert.equal(runHook(hooksDir, '', {}, fileRepo), light);
});

test('a Postman/ directory is not a postman/ directory, even where the disk ignores case', () => {
    const upper = fs.mkdtempSync(path.join(os.tmpdir(), 'postman-plugin-upper-repo-'));

    fs.mkdirSync(path.join(upper, 'Postman'));
    assert.equal(runHook(hooksDir, '', {}, upper), light);
});

test('Cursor JSON survives quotes, backslashes, tabs, CRLF and non-ASCII in the message', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'postman-plugin-hook-')),
        fixture = 'Say "hi" from C:\\Users\\me\\\tthen `postman:api-engineer` — 100% done.\r\nNext line\r\n\nLast line\n';

    for (const script of ['session-start', 'session-start.cmd']) {
        fs.copyFileSync(path.join(hooksDir, script), path.join(dir, script));
    }
    fs.writeFileSync(path.join(dir, 'session-start-context.md'), fixture);

    assert.deepEqual(jsonOutput(runHook(dir, '', { CURSOR_PLUGIN_ROOT: dir })), { additional_context: bareNames(fixture) });
    assert.deepEqual(jsonOutput(runHook(dir, '', { COPILOT_PLUGIN_ROOT: dir })), { additionalContext: bareNames(fixture) });
});

test('Droid on Windows is recognised by its placeholder root, not the value', () => {
    assert.equal(runHook(hooksDir, '/PLUGIN_ROOT_NOT_EXPANDED_ERROR', {}, repo), bareNames(repoMandate));
});

test('hooks.json names no variable but CLAUDE_PLUGIN_ROOT', () => {
    const hooks = JSON.parse(fs.readFileSync(path.join(hooksDir, 'hooks.json'), 'utf8')),
        commands = Object.values(hooks.hooks).flat().flatMap((entry) => entry.hooks.map((hook) => hook.command));

    assert.ok(commands.length > 0);

    for (const command of commands) {
        assert.deepEqual([...command.matchAll(/\$\{(\w+)\}/g)].map((match) => match[1]), ['CLAUDE_PLUGIN_ROOT']);
    }
});
