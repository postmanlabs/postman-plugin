import definitions from './agent-commands.json' with { type: 'json' };
import type { HostId } from './hosts/types.js';

export type AgentCommands = {
    id: HostId;
    name: string;
    executable: string;
    installExecutable?: string;
    native: boolean;
    commands: Record<string, string[]>;
    marketplace?: { name: string; repo: string };
    limitations?: { install?: string; remove?: string };
};

export const AGENT_COMMANDS = definitions as AgentCommands[];

export function commandsFor (id: HostId): Record<string, string[]> {
    const agent = AGENT_COMMANDS.find((entry) => entry.id === id);

    if (!agent) { throw new Error(`Missing command constants for ${id}`); }

    return agent.commands;
}
