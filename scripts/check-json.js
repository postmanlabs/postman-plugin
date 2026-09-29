#!/usr/bin/env node
/**
 * Fails if any tracked `*.json` file does not parse. Pass paths to check only
 * those instead, e.g. a new file not yet tracked.
 *
 * Any file name works: names are listed with `git ls-files -z`, read by path,
 * and escaped before they reach a GitHub Actions workflow command.
 */
'use strict';

const fs = require('fs'),
    path = require('path'),
    { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');

/**
 * Escapes a value for a workflow command property, per @actions/core.
 *
 * @param {string} value - Raw value.
 * @returns {string} Value safe to embed in `::error file=...::`.
 */
function escapeProperty (value) {
    return value
        .replace(/%/g, '%25')
        .replace(/\r/g, '%0D')
        .replace(/\n/g, '%0A')
        .replace(/:/g, '%3A')
        .replace(/,/g, '%2C');
}

/**
 * Keeps a file name on one output line, so a newline in it cannot start a
 * workflow command of its own.
 *
 * @param {string} value - Raw value.
 * @returns {string} Single-line value.
 */
function escapeData (value) {
    return value
        .replace(/%/g, '%25')
        .replace(/\r/g, '%0D')
        .replace(/\n/g, '%0A');
}

const explicit = process.argv.slice(2),
    files = explicit.length ? explicit : execFileSync('git', ['ls-files', '-z', '--', '*.json'], { cwd: ROOT, encoding: 'utf8' })
        .split('\0')
        .filter(Boolean);

let failed = false;

for (const file of files) {
    try {
        JSON.parse(fs.readFileSync(path.resolve(ROOT, file), 'utf8'));
        console.log(`ok ${escapeData(file)}`);
    }
    catch (err) {
        console.log(`::error file=${escapeProperty(file)}::invalid JSON: ${escapeData(err.message)}`);
        failed = true;
    }
}

process.exitCode = failed ? 1 : 0;
