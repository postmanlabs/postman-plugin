import path from 'node:path';
import type { JsonRpc } from '../json-rpc.js';
import type { System } from '../system.js';

export const POSTMAN_HOOK_KEY = 'postman@postman:hooks/codex-hooks.json:session_start:0:0';

type Hook = { key: string; trustStatus: string; currentHash: string; sourcePath: string };

async function postmanHook (rpc: JsonRpc, cwd: string): Promise<Hook | undefined> {
    const result = await rpc.request<{ data: { hooks: Hook[]; errors?: unknown[] }[] }>('hooks/list', { cwds: [cwd] });

    if (!Array.isArray(result?.data) || result.data.some((entry) => !Array.isArray(entry.hooks) || entry.errors?.length)) {
        throw new Error('hooks/list returned no usable hook listing');
    }

    const hooks = result.data.flatMap((entry) => entry.hooks).filter((hook) => hook.key === POSTMAN_HOOK_KEY);

    if (hooks.length > 1) {
        throw new Error('hooks/list returned more than one Postman session-start hook');
    }

    return hooks[0];
}

const trustEdit = (hash: string) => ({
    edits: [{ keyPath: 'hooks.state', value: { [POSTMAN_HOOK_KEY]: { trusted_hash: hash } }, mergeStrategy: 'upsert' }],
    reloadUserConfig: true
});

/** Approves only Postman's current hook after installation; unsupported APIs never fail the install. */
export async function approvePostmanHook (system: System): Promise<void> {
    const note = (message: string) => system.log(`  note: ${message}`);
    let writeAttempted = false;

    if (system.dryRun) {
        note('Would inspect and approve Postman\'s current session-start hook after installation through codex app-server:');
        system.log(`  config/batchWrite ${JSON.stringify(trustEdit('<currentHash from hooks/list>'))}`);

        return;
    }

    try {
        await system.withJsonRpc('codex', ['app-server'], async (rpc) => {
            // Version of this small protocol client, independent of the plugin's release.
            await rpc.request('initialize', { clientInfo: { name: 'postman-plugin-installer', version: '1' } });
            rpc.notify('initialized');

            const hook = await postmanHook(rpc, system.cwd);

            if (!hook) {
                note('Postman\'s session-start hook was not found; hook approval skipped.');

                return;
            }

            if (hook.trustStatus === 'trusted') {
                note('Postman\'s Codex session-start hook is already trusted.');

                return;
            }

            if (!['untrusted', 'modified'].includes(hook.trustStatus) || !hook.currentHash || typeof hook.currentHash !== 'string') {
                throw new Error('Postman\'s hook has an unsupported trust status or hash');
            }

            // Confirm the installed instructions are present before approving their hook.
            const mandateFile = path.resolve(path.dirname(hook.sourcePath), 'session-start-context.md'),
                mandate = await system.readFile(mandateFile);

            if (!mandate?.trim()) {
                throw new Error('could not read the installed hooks/session-start-context.md');
            }

            // Startup can refresh marketplaces. A changed hash needs another check,
            // rather than approving a different version from the one inspected above.
            const current = await postmanHook(rpc, system.cwd);

            if (!current || current.currentHash !== hook.currentHash || !['untrusted', 'modified'].includes(current.trustStatus)) {
                note('Postman\'s hook changed while checking it; approval skipped. Re-run to approve the current version.');

                return;
            }

            writeAttempted = true;
            await rpc.request('config/batchWrite', trustEdit(hook.currentHash));

            const after = await postmanHook(rpc, system.cwd);

            note(after?.trustStatus === 'trusted' && after.currentHash === hook.currentHash ?
                'Approved Postman\'s Codex session-start hook.' :
                'Codex accepted the approval write, but the hook is not confirmed trusted. Review it in Codex.');
        });
    }
    catch (error) {
        // Older Codex releases may lack app-server or hooks/list. Installation still succeeds.
        note(`Hook approval ${writeAttempted ? 'could not be confirmed' : 'skipped'}: ${error instanceof Error ? error.message : String(error)}. Review the hook in Codex.`);
    }
}
