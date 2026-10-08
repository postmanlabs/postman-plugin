#!/usr/bin/env node
// Builds the OpenCode plugin package that postmanlabs/opencode-plugin holds and @postman/opencode-plugin
// publishes: this package's entrypoint at the root, with the shared files it reads beside it.
// Usage: node scripts/build-mirror.js <out-dir>. Only MIRROR_PATHS are replaced: the mirror's own files,
// such as SECURITY.md, .github/ and .git, stay.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'),
    repoRoot = path.dirname(packageRoot),
    SOURCE_REPO = 'postmanlabs/postman-plugin',
    SHARED = ['LICENSE', 'manifest.json', 'mcp.opencode.json', path.join('hooks', 'session-start-context.md')];

export const MIRROR_REPO = 'postmanlabs/opencode-plugin';

/** Every top-level path buildMirror writes. */
export const MIRROR_PATHS = ['src', 'skills', 'hooks', 'LICENSE', 'manifest.json', 'mcp.opencode.json', 'README.md', 'package.json'];

/** No scripts or dependencies: npm runs a Git dependency's lifecycle scripts in every user's install. */
export function mirrorManifest (source) {
    return {
        name: source.name,
        version: source.version,
        description: source.description,
        license: source.license,
        keywords: ['postman', 'opencode', 'opencode-plugin', 'api', 'agent-skills'],
        homepage: `https://github.com/${MIRROR_REPO}#readme`,
        bugs: `https://github.com/${SOURCE_REPO}/issues`,
        // npm's provenance check requires the repository the package is built and published from.
        repository: { type: 'git', url: `git+https://github.com/${SOURCE_REPO}.git`, directory: 'opencode' },
        main: './src/index.ts',
        exports: { './server': './src/index.ts' },
        files: ['src/', 'skills/', 'hooks/', 'manifest.json', 'mcp.opencode.json'],
        engines: source.engines
    };
}

export function mirrorReadme (markdown) {
    const [title, ...rest] = markdown.split('\n'),
        notice = `> Generated from [${SOURCE_REPO}](https://github.com/${SOURCE_REPO}) on every change to its \`main\`. ` +
            `Open issues and pull requests there; changes made here to generated files are overwritten.`;

    return [title, '', notice, ...rest].join('\n');
}

export function buildMirror (out) {
    const source = JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8'));

    for (const entry of MIRROR_PATHS) {
        fs.rmSync(path.join(out, entry), { recursive: true, force: true });
    }

    fs.mkdirSync(path.join(out, 'src'), { recursive: true });
    fs.copyFileSync(path.join(packageRoot, 'src', 'index.ts'), path.join(out, 'src', 'index.ts'));

    for (const file of SHARED) {
        fs.mkdirSync(path.dirname(path.join(out, file)), { recursive: true });
        fs.copyFileSync(path.join(repoRoot, file), path.join(out, file));
    }

    // Dot-directories such as skills/.quarantine/ are local and gitignored, never published.
    fs.cpSync(path.join(repoRoot, 'skills'), path.join(out, 'skills'), {
        recursive: true,
        filter: (file) => !path.basename(file).startsWith('.')
    });
    fs.writeFileSync(path.join(out, 'README.md'), mirrorReadme(fs.readFileSync(path.join(packageRoot, 'README.md'), 'utf8')));
    fs.writeFileSync(path.join(out, 'package.json'), `${JSON.stringify(mirrorManifest(source), null, 2)}\n`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
    const out = process.argv[2];

    if (!out) {
        console.error('usage: node scripts/build-mirror.js <out-dir>');
        process.exit(2);
    }

    buildMirror(path.resolve(out));
}
