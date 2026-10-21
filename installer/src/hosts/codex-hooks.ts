import path from 'node:path';
import type { JsonRpc } from '../json-rpc.js';
import type { System } from '../system.js';
import type { InstallOptions } from './types.js';

export const POSTMAN_HOOK_KEY = 'postman@postman:hooks/codex-hooks.json:session_start:0:0';
export const HOOK_PROMPT = 'Approve Postman\'s Codex session-start hook for this installed version? [y/N] ';

type Hook = { key: string; trustStatus: string; currentHash: string; sourcePath: string; command: string };

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

/** Optional install step. Only an explicit, separate consent can reach the config writer. */
export async function approvePostmanHook (system: System, options: InstallOptions = {}): Promise<void> {
    const note = (message: string) => system.log(`  note: ${message}`);
    let writeAttempted = false;

    if (system.dryRun) {
        note('Would inspect Postman\'s session-start hook after installation; with explicit hook approval, write through codex app-server:');
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

            if (!options.approveCodexHook && !options.confirmHook) {
                note('Hook approval skipped: no interactive terminal. --yes does not approve hooks. Review it in Codex, or re-run with --yes --approve-codex-hook.');

                return;
            }

            // Display the installed mandate, not a bundled copy that may differ from this plugin.
            const mandateFile = path.resolve(path.dirname(hook.sourcePath), 'session-start-context.md'),
                mandate = await system.readFile(mandateFile);

            if (!mandate?.trim()) {
                throw new Error('could not read the installed hooks/session-start-context.md');
            }

            system.log(`  Postman's Codex session-start hook (${hook.trustStatus}) runs: ${hook.command}`);
            system.log(`  It prints ${mandateFile} into Codex's session, directing API work to Postman's skills:`);
            system.log(mandate.trim());
            system.log('  Approval saves trust in your Codex user configuration and allows this command to run at session start.');

            if (!options.approveCodexHook && !(await options.confirmHook!(HOOK_PROMPT))) {
                note('Hook approval declined; Postman remains installed and the hook is not approved.');

                return;
            }

            // The app-server can refresh marketplaces, and the user can take time reviewing.
            // A changed hash needs a new review, never an automatic approval of the newer hash.
            const current = await postmanHook(rpc, system.cwd);

            if (!current || current.currentHash !== hook.currentHash || !['untrusted', 'modified'].includes(current.trustStatus)) {
                note('Postman\'s hook changed during review; approval skipped. Re-run to review it again.');

                return;
            }

            writeAttempted = true;
            await rpc.request('config/batchWrite', trustEdit(hook.currentHash));

            const after = await postmanHook(rpc, system.cwd);

            note(after?.trustStatus === 'trusted' && after.currentHash === hook.currentHash ?
                'Approved Postman\'s Codex session-start hook through Codex\'s config API.' :
                'Codex accepted the approval write, but the hook is not confirmed trusted. Review it in Codex.');
        });
    }
    catch (error) {
        // Older Codex releases may lack app-server or hooks/list. Installation still succeeds.
        note(`Hook approval ${writeAttempted ? 'could not be confirmed' : 'skipped'}: ${error instanceof Error ? error.message : String(error)}. Review the hook in Codex.`);
    }
}
