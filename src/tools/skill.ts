/** Invoking a skill, from the model through the Skill tool or from the user through `/name`. */
import { hasInjectedCommands, isPrivilegedSkill, splitInjectedCommands, substitute } from '../skills/skills.ts';
import type { Skill, SkillActivation } from '../skills/skills.ts';
import { bashTool } from './bash.ts';
import type { Tool, ToolContext } from './types.ts';

/** Exit 1 only means "nothing found" or "they differ" for these. */
const EXIT_ONE_IS_NORMAL = new Set(['grep', 'egrep', 'fgrep', 'rg', 'diff', 'cmp', 'test', '[']);
const INJECTED_COMMAND_TIMEOUT_MS = 120_000;

export class SkillError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SkillError';
  }
}

export function activationOf(skill: Skill): SkillActivation {
  const expand = (rule: string): string => rule.replaceAll('${CAIRN_SKILL_DIR}', skill.dir);
  return {
    allowedTools: skill.allowedTools.map(expand),
    disallowedTools: skill.disallowedTools.map(expand),
    ...(skill.model ? { model: skill.model } : {}),
    ...(skill.effort ? { effort: skill.effort } : {}),
  };
}

/**
 * Injected commands run while rendering, with nobody to ask. A command must already be allowed,
 * by the rules or by the skill's `allowed-tools`; anything else stops the whole skill.
 */
async function runInjectedCommand(command: string, skill: Skill, ctx: ToolContext): Promise<string> {
  const decision = ctx.skillHost!.checkShell(command);
  if (decision.behavior !== 'allow') {
    throw new SkillError(
      `Skill "${skill.name}" needs to run \`${command}\`, which is not allowed: ${decision.reason}. Add it to the skill's allowed-tools, or to your permission rules.`,
    );
  }
  // Rendering a skill must not move the session, whatever directory a command ends up in.
  const output = await bashTool.execute({ command, timeout: INJECTED_COMMAND_TIMEOUT_MS }, { ...ctx, setCwd: () => {} });
  if (!output.isError) return output.content === '(no output)' ? '' : output.content;
  const firstWord = command.trim().split(/\s+/)[0] ?? '';
  if (output.exitCode === 1 && EXIT_ONE_IS_NORMAL.has(firstWord)) {
    return output.content.replace(/\n*Exit code 1\.$/, '');
  }
  throw new SkillError(`Skill "${skill.name}" stopped because \`${command}\` failed:\n${output.content}`);
}

export async function renderSkill(skill: Skill, args: string, ctx: ToolContext): Promise<string> {
  const host = ctx.skillHost!;
  const variables = { sessionId: host.sessionId(), projectDir: host.projectDir, effort: host.effort() };
  let argumentUsed = false;
  const onUsed = (): void => {
    argumentUsed = true;
  };
  let text = '';
  for (const segment of splitInjectedCommands(skill.body)) {
    if (segment.kind === 'text') {
      text += substitute(segment.text, args, skill, variables, onUsed);
    } else {
      text += await runInjectedCommand(substitute(segment.command, args, skill, variables, onUsed), skill, ctx);
    }
  }
  if (args && !argumentUsed) text += `\n\nARGUMENTS: ${args}`;
  return text;
}

export interface InvokedSkill {
  text: string;
  activation: SkillActivation;
}

/** Applies the skill's permissions, then renders it: its commands may depend on those grants. */
export async function prepareSkill(skill: Skill, args: string, ctx: ToolContext): Promise<InvokedSkill> {
  const activation = activationOf(skill);
  ctx.activateSkill?.(activation);
  ctx.skillHost!.allowRead(skill.dir);
  ctx.skillHost!.registerHooks(skill);
  const rendered = await renderSkill(skill, args, ctx);
  return { text: `Base directory for this skill: ${skill.dir}\n\n${rendered}`, activation };
}

function lookup(name: string, ctx: ToolContext): Skill | undefined {
  return ctx.skillHost?.load().skills.get(name);
}

export const skillTool: Tool = {
  name: 'Skill',
  description: `Invoke a skill.

A skill is a packaged set of instructions the user or project has set up for a particular kind of task (deploy steps, a review checklist, a repo-specific workflow). Available skills appear in a listing in the system prompt with one-line descriptions. When the task at hand is one a listed skill covers, call this tool first — the skill's instructions load into the turn for you to follow in place of your default approach; some skills instead run in a subagent and return the finished result. Users may also ask for one by name (\`/<name>\`, or "slash command"); that's a request to invoke it.

- \`skill\`: exact name from the listing, no leading slash. Plugin skills use \`plugin:skill\`. Directory-scoped skills are listed with a path prefix (\`apps/web:deploy\`); when both scoped and unscoped variants of a name exist, pick the one whose directory contains the files you're working on (most specific wins; unscoped otherwise).
- \`args\`: optional arguments to pass through.

Only names from the listing (or that the user typed explicitly) are valid. Built-in CLI commands (\`/help\`, \`/clear\`, …) aren't skills. If a skill's instructions are already present this turn, the skill is loaded — follow it directly rather than calling again.`,
  inputSchema: {
    type: 'object',
    properties: {
      skill: { description: 'The name of a skill from the available-skills list. Do not guess names.', type: 'string' },
      args: { description: 'Optional arguments for the skill', type: 'string' },
    },
    required: ['skill'],
    additionalProperties: false,
  },
  isReadOnly: () => false,
  access(input, ctx) {
    const skill = lookup(input.skill as string, ctx);
    return {
      kind: 'skill',
      name: input.skill as string,
      args: (input.args as string | undefined) ?? '',
      privileged: skill ? isPrivilegedSkill(skill) : false,
    };
  },
  async execute(input, ctx) {
    const name = input.skill as string;
    const args = (input.args as string | undefined) ?? '';
    const skill = lookup(name, ctx);
    if (!skill) return { content: `No skill named "${name}".`, isError: true };
    if (skill.disableModelInvocation) {
      return { content: `Skill "${name}" can only be run by the user, as /${name}.`, isError: true };
    }
    try {
      const prepared = await prepareSkill(skill, args, ctx);
      if (skill.fork) {
        if (!ctx.runSubagent) return { content: 'Subagents are not available here.', isError: true };
        const report = await ctx.runSubagent({
          description: `skill ${name}`,
          prompt: prepared.text,
          signal: ctx.signal,
          ...(skill.agent ? { subagentType: skill.agent } : {}),
          ...(skill.model ? { model: skill.model } : {}),
          ...(skill.effort ? { effort: skill.effort } : {}),
        });
        return { content: report, display: 'skill finished in a subagent' };
      }
      // Skills with commands can render differently each time, so only identical text counts.
      if (ctx.noteSkillLoaded?.(name, prepared.text)) {
        return { content: `Skill "${name}" is already loaded above, unchanged. Its instructions still apply.`, display: 'already loaded' };
      }
      return { content: prepared.text, display: `loaded${hasInjectedCommands(skill.body) ? ', commands run' : ''}` };
    } catch (error) {
      if (error instanceof SkillError) return { content: error.message, isError: true };
      throw error;
    }
  },
};
