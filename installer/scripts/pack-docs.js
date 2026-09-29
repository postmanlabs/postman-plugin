#!/usr/bin/env node
// `npm pack` takes README and LICENSE only from installer/, so the repo's own copies are
// staged here for the tarball (`stage`, from prepack) and removed after (`clean`, from postpack).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'),
    repoRoot = path.dirname(packageRoot),
    BLOB = 'https://github.com/postmanlabs/postman-plugin/blob/main/',
    RAW = 'https://raw.githubusercontent.com/postmanlabs/postman-plugin/main/',
    STAGED = ['README.md', 'LICENSE'],
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

function stage () {
    fs.writeFileSync(path.join(packageRoot, 'README.md'), toPackageReadme(fs.readFileSync(path.join(repoRoot, 'README.md'), 'utf8')));
    fs.copyFileSync(path.join(repoRoot, 'LICENSE'), path.join(packageRoot, 'LICENSE'));
}

function clean () {
    for (const file of STAGED) {
        fs.rmSync(path.join(packageRoot, file), { force: true });
    }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
    const command = { stage, clean }[process.argv[2]];

    if (!command) {
        console.error('usage: node scripts/pack-docs.js stage|clean');
        process.exit(2);
    }

    command();
}
