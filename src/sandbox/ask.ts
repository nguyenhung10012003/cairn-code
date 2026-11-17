/**
 * The question a sandboxed command's connection to an unlisted domain asks: yes for this session,
 * yes and remember it for this project, or no.
 */
import { settingsPathFor, updateSettingsFile } from '../config/settings.ts';
import type { Prompter } from '../tools/types.ts';

export function networkQuestion(prompter: Prompter, projectDir: string, onNotice?: (text: string) => void): (host: string, port: number) => Promise<boolean> {
  return async (host, port) => {
    const domain = host.toLowerCase();
    const answer = await prompter.permission({
      toolName: 'Network',
      input: { host, port },
      reason: `A sandboxed command wants to connect to ${host}:${port}, which sandbox.network.allowedDomains does not list.`,
      suggestions: [{ rule: domain, persist: true }],
      forced: false,
    });
    if (answer.behavior !== 'allow') return false;
    if (answer.always) {
      // In the workspace folder, outside the repository, like other approvals saved there.
      try {
        updateSettingsFile(settingsPathFor('local', projectDir), (saved) => {
          const sandbox = (saved.sandbox ??= {}) as { network?: { allowedDomains?: string[] } };
          const network = (sandbox.network ??= {});
          network.allowedDomains = [...new Set([...(network.allowedDomains ?? []), domain])];
        });
      } catch (error) {
        onNotice?.(`${domain} is allowed for this session, but could not be saved: ${(error as Error).message}`);
      }
    }
    return true;
  };
}
