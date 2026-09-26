#!/usr/bin/env node
'use strict';

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolveOpenCodeExecutable } from './lib/opencode-executable.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'),
    casesFile = path.join(root, 'evals', 'opencode', 'cases.json'),
    manifestFile = path.join(root, 'manifest.json'),
    cases = JSON.parse(fs.readFileSync(casesFile, 'utf8')),
    manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8')),
    argumentsList = process.argv.slice(2),
    validateOnly = argumentsList.includes('--validate');

function option (name) {
    const index = argumentsList.indexOf(name);

    return index === -1 ? undefined : argumentsList[index + 1];
}

function validateCases () {
    const published = new Set(manifest.skills.map((skill) => skill.name)),
        covered = new Set();

    for (const entry of cases) {
        if (!entry.id || typeof entry.prompt !== 'string' || !Array.isArray(entry.expected)) {
            throw new Error('Every eval case needs id, prompt, and expected fields.');
        }

        for (const skill of entry.expected) {
            if (!published.has(skill)) {
                throw new Error(`${entry.id}: expected skill "${skill}" is not in manifest.json`);
            }

            covered.add(skill);
        }
    }

    const missing = [...published].filter((skill) => !covered.has(skill));

    if (missing.length > 0) {
        throw new Error(`No positive OpenCode eval case for: ${missing.join(', ')}`);
    }

    console.log(`Validated ${cases.length} cases covering all ${published.size} skills.`);
}

function loadedSkills (stdout) {
    const loaded = [];

    for (const line of stdout.split('\n')) {
        if (!line.trim()) {
            continue;
        }

        let event;

        try {
            event = JSON.parse(line);
        }
        catch {
            continue;
        }

        if (event.type === 'tool_use' && event.part?.tool === 'skill' &&
            event.part?.state?.status === 'completed') {
            const name = event.part.state.input?.name;

            if (typeof name === 'string' && !loaded.includes(name)) {
                loaded.push(name);
            }
        }
    }

    return loaded;
}

function sameSkills (actual, expected) {
    return [...actual].sort().join('\n') === [...expected].sort().join('\n');
}

validateCases();

if (validateOnly) {
    process.exit(0);
}

const selectedCase = option('--case'),
    model = option('--model'),
    outputFile = option('--output'),
    selected = selectedCase ? cases.filter((entry) => entry.id === selectedCase) : cases,
    openCode = resolveOpenCodeExecutable(root);

if (selected.length === 0) {
    throw new Error(`Unknown eval case: ${selectedCase}`);
}

const results = [];

for (const entry of selected) {
    const routingPrompt = [
            'This is a read-only skill-routing evaluation. Do not run shell commands, call MCP tools,',
            'or modify files. Consider the request below exactly as a normal user request.',
            'If a Postman skill is relevant, load only the single best matching Postman skill with',
            'OpenCode\'s native skill tool. If no Postman skill is relevant, do not load any skill.',
            'After that, reply with only ROUTED_SKILL=<name> or ROUTED_SKILL=none.',
            '',
            `USER REQUEST: ${entry.prompt}`
        ].join('\n'),
        commandArguments = ['run', '--format', 'json', '--agent', 'plan'];

    if (model) {
        commandArguments.push('--model', model);
    }

    commandArguments.push(routingPrompt);

    const run = spawnSync(openCode, commandArguments, {
            cwd: root,
            encoding: 'utf8',
            env: {
                ...process.env,
                OPENCODE_DISABLE_CLAUDE_CODE_SKILLS: '1',
                OPENCODE_DISABLE_EXTERNAL_SKILLS: '1'
            },
            maxBuffer: 16 * 1024 * 1024,
            timeout: Number(process.env.OPENCODE_EVAL_TIMEOUT_MS || 120000)
        }),
        actual = loadedSkills(run.stdout || ''),
        passed = run.status === 0 && sameSkills(actual, entry.expected),
        result = {
            id: entry.id,
            expected: entry.expected,
            actual,
            passed,
            exitCode: run.status,
            error: run.error?.message || (run.stderr || '').trim() || undefined
        };

    results.push(result);
    console.log(`${passed ? 'PASS' : 'FAIL'} ${entry.id}: ` +
        `expected [${entry.expected.join(', ')}], loaded [${actual.join(', ')}]`);
}

const summary = {
    passed: results.filter((result) => result.passed).length,
    failed: results.filter((result) => !result.passed).length,
    total: results.length,
    results
};

if (outputFile) {
    const absolute = path.resolve(outputFile);

    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    fs.writeFileSync(absolute, `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
}

console.log(`\n${summary.passed}/${summary.total} routing evaluations passed.`);
process.exit(summary.failed === 0 ? 0 : 1);
