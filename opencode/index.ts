import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Plugin as OpenCodeV2, Skill } from '@opencode/plugin';
import type { Config, Plugin } from '@opencode-ai/plugin';

const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));

/** The package root in both source (`opencode/`) and compiled (`dist/`) layouts. */
export const packageRoot = path.resolve(moduleDirectory, '..');
export const skillsDirectory = path.join(packageRoot, 'skills');
export const sessionContextFile = path.join(packageRoot, 'hooks', 'session-start-context.md');

type SkillsConfig = { paths?: string[]; urls?: string[] };
type MutableConfig = Config & { skills?: SkillsConfig };
type ManifestSkill = { name: string; description: string | null };

function packageVersion (): string {
    const metadata = JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8')) as {
        version?: unknown;
    };

    if (typeof metadata.version !== 'string' || !metadata.version) {
        throw new Error('The Postman OpenCode plugin package has no version.');
    }

    return metadata.version;
}

function addOnce (values: string[] | undefined, value: string): string[] {
    const next = values ? [...values] : [];

    if (!next.includes(value)) {
        next.push(value);
    }

    return next;
}

/**
 * OpenCode skill ids are un-namespaced. Other plugin routes call the same
 * skills `postman:<name>`, so adapt the shared mandate at runtime instead of
 * maintaining a second copy of it.
 */
export function toOpenCodeSessionContext (source: string): string {
    return source.replaceAll('postman:', '');
}

/** Adds this package's skills and MCP server without replacing user configuration. */
export function applyPostmanConfig (config: MutableConfig): void {
    const skills = config.skills || {};

    skills.paths = addOnce(skills.paths, skillsDirectory);
    config.skills = skills;

    config.mcp ||= {};

    if (!config.mcp.postman) {
        const version = packageVersion();

        config.mcp.postman = {
            type: 'remote',
            url: 'https://mcp.postman.com/minimal',
            enabled: true,
            headers: {
                'X-Source': 'postman-opencode-plugin',
                'X-Plugin-Version': version,
                'User-Agent': `postman-opencode-plugin/${version}`
            }
        };
    }
}

const sessionContext = toOpenCodeSessionContext(fs.readFileSync(sessionContextFile, 'utf8'));

function packagedSkills (): Array<Skill.Info> {
    const manifest = JSON.parse(
            fs.readFileSync(path.join(packageRoot, 'manifest.json'), 'utf8')
        ) as { skills: ManifestSkill[] };

    return manifest.skills.map((skill) => {
        const skillFile = path.join(skillsDirectory, skill.name, 'SKILL.md');

        return {
            id: skill.name as Skill.Info['id'],
            name: skill.name as Skill.Info['name'],
            description: skill.description || undefined,
            path: skillFile as Skill.Info['path'],
            content: fs.readFileSync(skillFile, 'utf8')
        };
    });
}

const skills = packagedSkills();

export const PostmanPlugin: Plugin = async () => {
    return {
        config: async (config) => {
            applyPostmanConfig(config);
        },
        'experimental.chat.system.transform': async (_input, output) => {
            if (!output.system.includes(sessionContext)) {
                output.system.push(sessionContext);
            }
        }
    };
};

const PostmanPluginV2 = {
    id: 'postman',
    async setup (context) {
        await context.skill.transform((editor) => {
            for (const skill of skills) {
                if (!editor.get(skill.id)) {
                    editor.add(skill);
                }
            }
        });

        await context.mcp.transform((editor) => {
            if (!editor.get('postman')) {
                const version = packageVersion();

                editor.set('postman', {
                    type: 'remote',
                    url: 'https://mcp.postman.com/minimal',
                    disabled: false,
                    headers: {
                        'X-Source': 'postman-opencode-plugin',
                        'X-Plugin-Version': version,
                        'User-Agent': `postman-opencode-plugin/${version}`
                    }
                });
            }
        });

        await context.session.hook('context', (event) => {
            if (!event.system.some((part) => part.text === sessionContext)) {
                event.system.push({ type: 'text', text: sessionContext });
            }
        });
    }
} satisfies OpenCodeV2.Plugin;

/** OpenCode's documented transition shape: v2 calls setup; v1 calls server. */
export default {
    ...PostmanPluginV2,
    server: PostmanPlugin
};
