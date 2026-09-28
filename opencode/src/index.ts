import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Plugin as OpenCodeV2, Skill } from '@opencode/plugin';
import type { Config, Plugin } from '@opencode-ai/plugin';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'),
    stagedAssets = path.join(packageRoot, 'assets');

/** A published install carries the shared files in `assets/`; a clone reads them from the repository root. */
export const assetRoot = fs.existsSync(stagedAssets) ? stagedAssets : path.dirname(packageRoot);
export const skillsDirectory = path.join(assetRoot, 'skills');
export const sessionContextFile = path.join(assetRoot, 'hooks', 'session-start-context.md');
export const mcpConfigFile = path.join(assetRoot, 'mcp.opencode.json');

type SkillsConfig = { paths?: string[]; urls?: string[] };
type MutableConfig = Config & { skills?: SkillsConfig };
type ManifestSkill = { name: string; description: string | null };
type RemoteServer = { type: 'remote'; url: string; enabled: boolean; headers: Record<string, string> };

function readJson<T> (file: string): T {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
}

/** The route's MCP server in OpenCode v1's config shape, exactly as `mcp.opencode.json` declares it. */
export const postmanMcpServer = readJson<{ mcp: { postman: RemoteServer } }>(mcpConfigFile).mcp.postman;

function addOnce (values: string[] | undefined, value: string): string[] {
    const next = values ? [...values] : [];

    if (!next.includes(value)) {
        next.push(value);
    }

    return next;
}

/** OpenCode skill ids are un-namespaced; the shared mandate names them `postman:<skill>` for the other routes. */
export function toOpenCodeSessionContext (source: string): string {
    return source.replace(/`postman:([a-z0-9-]+)`/g, '`$1`');
}

/** Adds this package's skills and MCP server without replacing user configuration. */
export function applyPostmanConfig (config: MutableConfig): void {
    const skills = config.skills || {};

    skills.paths = addOnce(skills.paths, skillsDirectory);
    config.skills = skills;

    config.mcp ||= {};

    if (!config.mcp.postman) {
        config.mcp.postman = { ...postmanMcpServer, headers: { ...postmanMcpServer.headers } };
    }
}

const sessionContext = toOpenCodeSessionContext(fs.readFileSync(sessionContextFile, 'utf8'));

function packagedSkills (): Array<Skill.Info> {
    const manifest = readJson<{ skills: ManifestSkill[] }>(path.join(assetRoot, 'manifest.json'));

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
        const skills = packagedSkills();

        await context.skill.transform((editor) => {
            for (const skill of skills) {
                if (!editor.get(skill.id)) {
                    editor.add(skill);
                }
            }
        });

        await context.mcp.transform((editor) => {
            if (!editor.get('postman')) {
                const { enabled, ...server } = postmanMcpServer;

                editor.set('postman', { ...server, headers: { ...server.headers }, disabled: !enabled });
            }
        });

        await context.session.hook('context', (event) => {
            if (!event.system.some((part) => part.text === sessionContext)) {
                event.system.push({ type: 'text', text: sessionContext });
            }
        });
    }
} satisfies OpenCodeV2.Plugin;

/** v2 hosts call `setup`; v1 hosts read `server` from the same default export. */
export default {
    ...PostmanPluginV2,
    server: PostmanPlugin
};
