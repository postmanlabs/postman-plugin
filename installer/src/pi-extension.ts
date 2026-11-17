import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

type McpServer = { url: string; headers: Record<string, string> };
type BeforeAgentStart = {
    systemPrompt: string;
    systemPromptOptions: {
        /** Pi 0.86.0 and later. */
        sections?: Record<string, string>;
        skills: Array<{ name: string }>;
    };
};
type SessionContext = { ui: { notify (message: string, type: 'warning'): void } };
/** Pi's `ExtensionContext`; `cwd` is the session's project directory. */
type AgentContext = { cwd?: string };

/** The part of Pi's `ExtensionAPI` this extension calls. Pi's own types ship only inside its CLI package. */
export interface PiExtensionApi {
    /** Pi 0.99.0 and later. */
    registerMcpServer? (name: string, config: McpServer): void;
    on (event: 'before_agent_start', handler: (event: BeforeAgentStart, ctx?: AgentContext) => { systemPrompt: string } | void): void;
    on (event: 'session_start', handler: (event: unknown, ctx: SessionContext) => void): void;
}

/** In the tarball, where `prepack` staged the repo's shared files beside `dist/`. */
const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'),
    ENTRY_SKILL = 'api-engineer',
    SECTION = 'postman',
    MCP_NEEDS_NEWER_PI = 'Postman\'s MCP server needs Pi 0.99.0 or later; run `pi update` to upgrade Pi.';

/** Pi's skill names are un-namespaced; the shared mandate names them `postman:<skill>` for the other routes. */
export function toPiSessionContext (source: string): string {
    return source.replace(/`postman:([a-z0-9-]+)`/g, '`$1`');
}

/** Whether `directory` holds a directory named exactly `postman`, which a case-insensitive disk's lookup can't tell. */
function hasPostmanDir (directory: string): boolean {
    try {
        return fs.readdirSync(directory, { withFileTypes: true }).some((entry) => entry.name === 'postman' && entry.isDirectory());
    }
    catch {
        return false;
    }
}

/** Reads the mandate and the MCP config from `root`, which is laid out like the repository root. */
export function postmanExtension (root: string) {
    return (pi: PiExtensionApi): void => {
        const read = (file: string) => toPiSessionContext(fs.readFileSync(path.join(root, 'hooks', file), 'utf8')),
            // A project with a postman/ directory gets the mandate, any other the light note, as hooks/session-start picks them.
            light = read('session-start-context.md'),
            postmanDir = read('session-start-postman-dir.md'),
            { mcpServers } = JSON.parse(fs.readFileSync(path.join(root, 'mcp.pi.json'), 'utf8')) as { mcpServers: Record<string, McpServer> };

        // An extension that throws while loading stops every Pi session from starting, so an older
        // Pi still gets the skills and the mandate. Print and JSON modes drop the notice.
        if (typeof pi.registerMcpServer === 'function') {
            // A `postman` server in the user's own mcp.json takes precedence over this registration.
            for (const [name, server] of Object.entries(mcpServers)) {
                pi.registerMcpServer(name, server);
            }
        }
        else {
            pi.on('session_start', (_event, { ui }) => ui.notify(MCP_NEEDS_NEWER_PI, 'warning'));
        }

        // Pi's stand-in for the SessionStart hook. The mandate routes to a skill, so it goes only
        // where that skill loaded; `pi config` can disable it.
        pi.on('before_agent_start', (event, ctx) => {
            const { sections, skills } = event.systemPromptOptions;

            if (!skills.some((skill) => skill.name === ENTRY_SKILL)) {
                return;
            }

            const mandate = hasPostmanDir(typeof ctx?.cwd === 'string' ? ctx.cwd : process.cwd()) ? postmanDir : light;

            if (sections) {
                sections[SECTION] = mandate;

                return;
            }

            // From Pi 0.86.0 a returned prompt replaces the sectioned one whole, so only a Pi
            // without sections gets one.
            return { systemPrompt: `${event.systemPrompt}\n\n<${SECTION}>\n${mandate}\n</${SECTION}>` };
        });
    };
}

export default postmanExtension(packageRoot);
