import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

type McpServer = { url: string; headers: Record<string, string> };
type BeforeAgentStart = { systemPromptOptions: { sections: Record<string, string>; skills: Array<{ name: string }> } };

/** The part of Pi's `ExtensionAPI` this extension calls. Pi's own types ship only inside its CLI package. */
export interface PiExtensionApi {
    registerMcpServer (name: string, config: McpServer): void;
    on (event: 'before_agent_start', handler: (event: BeforeAgentStart) => void): void;
}

/** In the tarball, where `prepack` staged the repo's shared files beside `dist/`. */
const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'),
    ENTRY_SKILL = 'api-engineer',
    SECTION = 'postman';

/** Pi's skill names are un-namespaced; the shared mandate names them `postman:<skill>` for the other routes. */
export function toPiSessionContext (source: string): string {
    return source.replace(/`postman:([a-z0-9-]+)`/g, '`$1`');
}

/** Reads the mandate and the MCP config from `root`, which is laid out like the repository root. */
export function postmanExtension (root: string) {
    return (pi: PiExtensionApi): void => {
        const mandate = toPiSessionContext(fs.readFileSync(path.join(root, 'hooks', 'session-start-context.md'), 'utf8')),
            { mcpServers } = JSON.parse(fs.readFileSync(path.join(root, 'mcp.pi.json'), 'utf8')) as { mcpServers: Record<string, McpServer> };

        // A `postman` server in the user's own mcp.json takes precedence over this registration.
        for (const [name, server] of Object.entries(mcpServers)) {
            pi.registerMcpServer(name, server);
        }

        // Pi's stand-in for the SessionStart hook. The mandate routes to a skill, so it goes only
        // where that skill loaded; `pi config` can disable it.
        pi.on('before_agent_start', ({ systemPromptOptions }) => {
            if (systemPromptOptions.skills.some((skill) => skill.name === ENTRY_SKILL)) {
                systemPromptOptions.sections[SECTION] = mandate;
            }
        });
    };
}

export default postmanExtension(packageRoot);
