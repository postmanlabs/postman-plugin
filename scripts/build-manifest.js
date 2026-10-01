#!/usr/bin/env node
/**
 * Generates `manifest.json` — the index `postman init` fetches.
 *
 * The Claude Code plugin and the Postman CLI install the same skill files. The
 * plugin gets them by cloning this repository; the CLI has no clone, so it needs
 * an index telling it which files exist, where they land in a user's repo, and
 * what they should hash to. This script derives that index from the files
 * themselves so the two can never disagree.
 *
 * It also writes `.kimi-plugin/session-start-context.md`, the session-start
 * mandate as Kimi reads it: Kimi shows the model no hook output, and names
 * skills without the `postman:` prefix the shared mandate gives them.
 *
 * Run `node scripts/build-manifest.js` after changing any skill or the mandate.
 * CI re-runs it with `--check` and fails if either file is stale — a wrong sha256
 * makes the CLI reject a legitimate skill, which is a confusing way to find out.
 */
'use strict';

const fs = require('fs'),
    path = require('path'),
    crypto = require('crypto');

const ROOT = path.join(__dirname, '..'),
    SKILLS_DIR = path.join(ROOT, 'skills'),
    PLUGIN_MANIFEST = path.join(ROOT, '.claude-plugin', 'plugin.json'),
    MANIFEST = path.join(ROOT, 'manifest.json'),
    MANDATE = path.join(ROOT, 'hooks', 'session-start-context.md'),
    KIMI_MANDATE = path.join(ROOT, '.kimi-plugin', 'session-start-context.md'),
    SCHEMA_VERSION = 1,

    // `postman init` writes AGENTS.md naming the manifest's first skill as the entry point.
    ENTRY_SKILL = 'api-engineer';

/**
 * Lists every file under a directory, depth first, as POSIX-relative paths.
 *
 * @param {string} dir - Directory to walk.
 * @param {string} [prefix] - Accumulated relative prefix.
 * @returns {string[]} Sorted relative paths.
 */
function walk (dir, prefix = '') {
    const out = [];

    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const rel = prefix ? `${prefix}/${entry.name}` : entry.name;

        if (entry.isDirectory()) {
            out.push(...walk(path.join(dir, entry.name), rel));
        }
        else if (entry.isFile()) {
            out.push(rel);
        }
    }

    // Sorted so the manifest is stable across filesystems.
    return out.sort();
}

/**
 * @param {string} file - Absolute path.
 * @returns {string} Lowercase hex sha256 of the file's bytes.
 */
function sha256 (file) {
    return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

/**
 * Reads `name` and `description` out of a SKILL.md YAML frontmatter block.
 *
 * Deliberately not a YAML parse: the frontmatter is two scalar fields written by
 * hand, and adding a dependency to this repository to read them would be the
 * only dependency it has.
 *
 * @param {string} file - Path to SKILL.md.
 * @returns {{name: string|null, description: string|null}} Parsed fields.
 */
function frontmatter (file) {
    const text = fs.readFileSync(file, 'utf8'),
        match = /^---\n([\s\S]*?)\n---/.exec(text);

    if (!match) {
        return { name: null, description: null };
    }

    const read = (key) => {
        const found = new RegExp(`^${key}:\\s*(.+)$`, 'm').exec(match[1]);

        return found ? found[1].trim() : null;
    };

    return { name: read('name'), description: read('description') };
}

/**
 * Builds the manifest object from the files on disk.
 *
 * @returns {object} Manifest.
 */
function build () {
    const plugin = JSON.parse(fs.readFileSync(PLUGIN_MANIFEST, 'utf8')).name,
        skills = [];

    for (const skill of fs.readdirSync(SKILLS_DIR).sort()) {
        const dir = path.join(SKILLS_DIR, skill),
            entry = path.join(dir, 'SKILL.md');

        if (!fs.statSync(dir).isDirectory()) {
            continue;
        }

        // Dot-directories (e.g. skills/.quarantine/) are gitignored holding
        // pens, not skills - they have no SKILL.md of their own and must
        // never ship.
        if (skill.startsWith('.')) {
            continue;
        }

        if (!fs.existsSync(entry)) {
            throw new Error(`${skill}: no SKILL.md`);
        }

        const meta = frontmatter(entry);

        if (meta.name && meta.name !== skill) {
            throw new Error(`${skill}: frontmatter name "${meta.name}" does not match its directory`);
        }

        skills.push({
            name: skill,
            plugin,
            description: meta.description,

            // Files are listed with both ends of the copy: `source` is where
            // to fetch from (relative to this manifest, which is also the
            // Pages root), `target` is where it lands under the consuming
            // repo's `postman/skills/<name>/`.
            files: walk(dir).map((rel) => {
                const abs = path.join(dir, rel);

                return {
                    target: rel,
                    source: `skills/${skill}/${rel}`,
                    bytes: fs.statSync(abs).size,
                    sha256: sha256(abs)
                };
            })
        });
    }

    const entry = skills.findIndex((skill) => skill.name === ENTRY_SKILL);

    if (entry === -1) {
        throw new Error(`${ENTRY_SKILL}: no such skill, so \`postman init\` would route API work to ${skills[0]?.name}. If it was renamed, update ENTRY_SKILL in scripts/build-manifest.js`);
    }

    skills.unshift(...skills.splice(entry, 1));

    return { schemaVersion: SCHEMA_VERSION, skills };
}

/**
 * @returns {string} The shared mandate with `postman:<skill>` rewritten to `<skill>`.
 */
function kimiMandate () {
    return fs.readFileSync(MANDATE, 'utf8').replace(/`postman:([a-z0-9-]+)`/g, '`$1`');
}

const outputs = [
    [MANIFEST, JSON.stringify(build(), null, 2) + '\n'],
    [KIMI_MANDATE, kimiMandate()]
];

if (process.argv.includes('--check')) {
    const stale = outputs
        .filter(([file, content]) => !fs.existsSync(file) || fs.readFileSync(file, 'utf8') !== content)
        .map(([file]) => path.relative(ROOT, file));

    if (stale.length) {
        console.error(`Stale: ${stale.join(', ')}. Run \`node scripts/build-manifest.js\` and commit the result.`);
        process.exit(1);
    }

    console.log(`${outputs.map(([file]) => path.relative(ROOT, file)).join(' and ')} are up to date.`);
}
else {
    for (const [file, content] of outputs) {
        fs.writeFileSync(file, content);
        console.log(`Wrote ${path.relative(ROOT, file)}`);
    }
}
