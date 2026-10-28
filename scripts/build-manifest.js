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
 * It also writes the session-start mandate as the routes that never run
 * `hooks/` read it: `.kimi-plugin/session-start-context.md` for Kimi, which
 * shows the model no hook output, and `rules/GEMINI.md` for Antigravity, which
 * has no session-start hook and loads that file as an always-on rule. Kimi's
 * keeps the `postman:` names and says to drop the prefix where Kimi lists skills
 * bare; Antigravity's names skills bare.
 *
 * And it copies the skills, the session-start scripts and Copilot's hook config
 * into `agent-plugin/`, the Agent Plugins (agent-plugins.org) route. The spec
 * skips a skill whose files resolve outside the plugin root, so a symlink to
 * `skills/` would not do, and a Windows checkout turns one into a text file.
 *
 * Run `node scripts/build-manifest.js` after changing any skill or the mandate.
 * CI re-runs it with `--check` and fails if any of these files is stale — a wrong sha256
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
    ANTIGRAVITY_MANDATE = path.join(ROOT, 'rules', 'GEMINI.md'),
    AGENT_PLUGIN = path.join(ROOT, 'agent-plugin'),
    // What agent-plugin/ copies from the root, so a file is generated if, and only if, it is under one of these.
    AGENT_PLUGIN_SKILLS = path.join(AGENT_PLUGIN, 'skills'),
    AGENT_PLUGIN_HOOKS = path.join(AGENT_PLUGIN, 'hooks'),
    AGENT_PLUGIN_HOOK_SCRIPTS = ['session-start', 'session-start.cmd', 'session-start-context.md'],
    // Copilot CLI reads an Agent Plugins plugin's hooks only from its namespace directory.
    COPILOT_HOOKS = path.join(AGENT_PLUGIN, 'com.github.copilot', 'hooks', 'hooks.json'),
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
function bareMandate () {
    return fs.readFileSync(MANDATE, 'utf8').replace(/`postman:([a-z0-9-]+)`/g, '`$1`');
}

/**
 * @returns {string} The shared mandate, for Kimi Code 2.3.0 on, which lists plugin skills as `postman:<skill>`, and for
 * the releases before it, which list them bare.
 */
function kimiMandate () {
    const mandate = fs.readFileSync(MANDATE, 'utf8'),
        // A Windows checkout with core.autocrlf gives the mandate CRLF, and `--check` compares bytes.
        eol = mandate.includes('\r\n') ? '\r\n' : '\n',
        close = '</EXTREMELY_IMPORTANT>';

    if (!mandate.includes(close)) {
        throw new Error(`${path.relative(ROOT, MANDATE)}: no ${close} to put Kimi's naming note before`);
    }

    return mandate.replace(close, `${eol}If your skill listing names these skills without the \`postman:\` prefix, drop the prefix when you load one.${eol}${close}`);
}

/**
 * @param {object} manifest - What build() returned.
 * @returns {Array<[string, Buffer, number]>} Each agent-plugin/ copy, its source's bytes and its source's mode.
 */
function agentPluginCopies (manifest) {
    const copy = (from, to) => [to, fs.readFileSync(from), fs.statSync(from).mode & 0o777];

    return [
        ...manifest.skills.flatMap((skill) => skill.files.map((file) => copy(path.join(ROOT, file.source), path.join(AGENT_PLUGIN_SKILLS, skill.name, file.target)))),
        ...AGENT_PLUGIN_HOOK_SCRIPTS.map((name) => copy(path.join(ROOT, 'hooks', name), path.join(AGENT_PLUGIN_HOOKS, name))),
        copy(path.join(ROOT, 'hooks', 'copilot-hooks.json'), COPILOT_HOOKS)
    ];
}

/**
 * @param {string[]} generated - Absolute paths this run writes.
 * @returns {string[]} Files under agent-plugin/'s copied directories that nothing copies any more, such as a removed skill's.
 */
function leftovers (generated) {
    const keep = new Set(generated);

    return [AGENT_PLUGIN_SKILLS, AGENT_PLUGIN_HOOKS]
        .filter((dir) => fs.existsSync(dir))
        .flatMap((dir) => walk(dir).map((rel) => path.join(dir, rel)))
        .filter((file) => !keep.has(file));
}

const manifest = build(),
    outputs = [
        [MANIFEST, Buffer.from(JSON.stringify(manifest, null, 2) + '\n')],
        [KIMI_MANDATE, Buffer.from(kimiMandate())],
        [ANTIGRAVITY_MANDATE, Buffer.from(bareMandate())],
        ...agentPluginCopies(manifest)
    ],
    extra = leftovers(outputs.map(([file]) => file));

if (process.argv.includes('--check')) {
    const stale = outputs
        .filter(([file, content]) => !fs.existsSync(file) || !fs.readFileSync(file).equals(content))
        .map(([file]) => path.relative(ROOT, file))
        .concat(extra.map((file) => `${path.relative(ROOT, file)} (no longer generated)`));

    if (stale.length) {
        console.error(`Stale: ${stale.join(', ')}. Run \`node scripts/build-manifest.js\` and commit the result.`);
        process.exit(1);
    }

    console.log(`manifest.json, the mandate's copies and ${outputs.length - 3} agent-plugin/ copies are up to date.`);
}
else {
    for (const [file, content, mode] of outputs) {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, content);

        // The hook runs session-start directly, so the copy keeps the source's executable bit.
        if (mode !== undefined) {
            fs.chmodSync(file, mode);
        }
    }

    for (const file of extra) {
        fs.rmSync(file);
    }

    console.log(`Wrote manifest.json, the mandate's copies and ${outputs.length - 3} agent-plugin/ copies${extra.length ? `, and removed ${extra.length} stale ones` : ''}`);
}
