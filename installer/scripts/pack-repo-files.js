#!/usr/bin/env node
// `npm pack` takes files only from installer/, so the repo files the tarball ships are staged
// here (`stage`, from prepack) and removed after (`clean`, from postpack). All but README and
// LICENSE are for Pi, which installs this tarball as a Pi package (the `pi` key in package.json).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'),
    repoRoot = path.dirname(packageRoot),
    BLOB = 'https://github.com/postmanlabs/postman-plugin/blob/main/',
    RAW = 'https://raw.githubusercontent.com/postmanlabs/postman-plugin/main/',
    STAGED = ['README.md', 'LICENSE', 'skills', 'hooks', 'mcp.pi.json'],
    SESSION_CONTEXT = path.join('hooks', 'session-start-context.md'),
    // A target that already has a scheme, is protocol-relative or root-relative, or is an in-page anchor.
    NOT_RELATIVE = '(?![a-z][a-z0-9+.-]*:|/|#)(?:\\./)?';

/** The README links relative to the repo root; on npm they would resolve against installer/. */
export function toPackageReadme (markdown) {
    return markdown
        .replace(new RegExp(`(!\\[[^\\]]*\\]\\()${NOT_RELATIVE}`, 'g'), `$1${RAW}`)
        .replace(new RegExp(`(\\]\\()${NOT_RELATIVE}`, 'g'), `$1${BLOB}`)
        .replace(new RegExp(`(src=")${NOT_RELATIVE}`, 'g'), `$1${RAW}`)
        .replace(new RegExp(`(href=")${NOT_RELATIVE}`, 'g'), `$1${BLOB}`);
}

function copyFromRepo (file) {
    fs.mkdirSync(path.dirname(path.join(packageRoot, file)), { recursive: true });
    fs.copyFileSync(path.join(repoRoot, file), path.join(packageRoot, file));
}

function stage () {
    // A copy left by an interrupted pack would otherwise publish files deleted from the repo since.
    clean();
    fs.writeFileSync(path.join(packageRoot, 'README.md'), toPackageReadme(fs.readFileSync(path.join(repoRoot, 'README.md'), 'utf8')));
    copyFromRepo('LICENSE');
    copyFromRepo(SESSION_CONTEXT);
    copyFromRepo('mcp.pi.json');
    // Dot-directories such as skills/.quarantine/ are local and gitignored, never published.
    fs.cpSync(path.join(repoRoot, 'skills'), path.join(packageRoot, 'skills'), {
        recursive: true,
        filter: (source) => !path.basename(source).startsWith('.')
    });
}

function clean () {
    for (const file of STAGED) {
        fs.rmSync(path.join(packageRoot, file), { recursive: true, force: true });
    }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
    const command = { stage, clean }[process.argv[2]];

    if (!command) {
        console.error('usage: node scripts/pack-repo-files.js stage|clean');
        process.exit(2);
    }

    command();
}
