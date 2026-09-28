#!/usr/bin/env node
/**
 * Copies the repository's shared files into the package for `npm pack`, and
 * removes them again with `--clean`. npm packs nothing outside the package
 * directory, and a committed copy would reach every route that clones the repo.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'),
    repoRoot = path.dirname(packageRoot),
    assets = path.join(packageRoot, 'assets'),
    license = path.join(packageRoot, 'LICENSE');

fs.rmSync(assets, { recursive: true, force: true });
fs.rmSync(license, { force: true });

if (!process.argv.includes('--clean')) {
    const manifest = JSON.parse(fs.readFileSync(path.join(repoRoot, 'manifest.json'), 'utf8')),
        skillFiles = manifest.skills.flatMap((skill) => skill.files.map((file) => file.source));

    // Staging from the manifest keeps untracked files such as skills/.quarantine/ out of the tarball.
    for (const file of [...skillFiles, 'hooks/session-start-context.md', 'manifest.json', 'mcp.opencode.json']) {
        fs.mkdirSync(path.dirname(path.join(assets, file)), { recursive: true });
        fs.copyFileSync(path.join(repoRoot, file), path.join(assets, file));
    }

    fs.copyFileSync(path.join(repoRoot, 'LICENSE'), license);
}
