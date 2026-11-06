/**
 * The permission decision for every tool call. Order: deny rules, forced prompts, ask rules,
 * then the mode, hook approval, allow rules and per-kind defaults. A deny always wins, and an
 * allow rule cannot carve an exception out of one.
 */
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { analyzeShell } from './shell.ts';
import type { SimpleCommand } from './shell.ts';
import {
  allowForm,
  hasRiskyCdCombination,
  inlineShellCommands,
  isAcceptEditsCommand,
  isCriticalRemoval,
  isReadOnlyCommand,
  readPaths,
  restrictiveForms,
  writePath,
  writeTargets,
  writeTargetsAreSafe,
} from './bash-policy.ts';
import type { BashContext } from './bash-policy.ts';
import {
  canonicalize,
  isInside,
  isProtectedPath,
  matchBashPattern,
  matchDomain,
  matchPathPattern,
  parseRule,
  ruleCoversTool,
} from './rules.ts';
import type { PermissionRule, RuleBehavior, RuleSource } from './rules.ts';

export type PermissionMode = 'default' | 'acceptEdits' | 'plan' | 'dontAsk' | 'bypassPermissions';

export const PERMISSION_MODES: PermissionMode[] = ['default', 'acceptEdits', 'plan', 'dontAsk', 'bypassPermissions'];

/** What a tool call wants to touch. Each tool computes this from its validated input. */
export type AccessRequest =
  | { kind: 'none' }
  | { kind: 'interactive' }
  | { kind: 'read'; paths: string[] }
  | { kind: 'edit'; paths: string[] }
  | { kind: 'bash'; command: string; unsandboxed?: boolean }
  | { kind: 'web'; url: string }
  /** `readOnlyHint` comes from the server, so it can never skip a prompt, only avoid a refusal. */
  | { kind: 'mcp'; readOnlyHint: boolean }
  | { kind: 'skill'; name: string; args: string; privileged: boolean }
  | { kind: 'generic'; specifier?: string }
  /** Asks unless a rule or the mode settles it, such as entering plan mode or searching the web. */
  | { kind: 'confirm'; specifier?: string };

export interface RuleSuggestion {
  rule: string;
  /** True: saved to the project's workspace settings, outside the repository. False: lasts for this session only. */
  persist: boolean;
}

export interface Decision {
  behavior: RuleBehavior;
  reason: string;
  /** The prompt cannot be skipped by an allow rule or by choosing "always". */
  forced?: boolean;
  suggestions?: RuleSuggestion[];
}

export type HookVerdict = 'allow' | 'ask' | undefined;

export interface EngineOptions {
  mode: PermissionMode;
  rules: PermissionRule[];
  workingDirs: string[];
  cwd: () => string;
}

export class PermissionEngine {
  mode: PermissionMode;
  /** When set, a command the OS keeps in bounds may not need a prompt. */
  sandbox: { autoAllows(command: string, unsandboxed: boolean): boolean } | null = null;
  /** The one file plan mode lets the model write. */
  planFile: string | undefined;
  private readonly rules: PermissionRule[];
  /** Rules from an invoked skill. They last one turn and never change the tools offered. */
  private turnRules: PermissionRule[] = [];
  private readonly dirs: string[];
  private readonly cwd: () => string;

  constructor(options: EngineOptions) {
    this.mode = options.mode;
    this.rules = [...options.rules];
    this.dirs = options.workingDirs.map((dir) => canonicalize(dir));
    this.cwd = options.cwd;
  }

  workingDirs(): string[] {
    return [...this.dirs];
  }

  addWorkingDir(dir: string): void {
    const canonical = canonicalize(dir);
    if (!this.dirs.includes(canonical)) this.dirs.push(canonical);
  }

  listRules(): readonly PermissionRule[] {
    return this.rules;
  }

  addRule(text: string, behavior: RuleBehavior, source: RuleSource): PermissionRule | null {
    const rule = parseRule(text, behavior, source, this.dirs[0] ?? this.cwd());
    if (rule) this.rules.push(rule);
    return rule;
  }

  addTurnRules(allow: string[], deny: string[]): void {
    const anchor = this.dirs[0] ?? this.cwd();
    for (const [texts, behavior] of [[allow, 'allow'], [deny, 'deny']] as const) {
      for (const text of texts) {
        const rule = parseRule(text, behavior, 'session', anchor);
        if (rule) this.turnRules.push(rule);
      }
    }
  }

  clearTurnRules(): void {
    this.turnRules = [];
  }

  /** A bare deny rule takes the tool out of the model's context entirely. */
  isToolRemoved(toolName: string): boolean {
    return this.rules.some((r) => r.behavior === 'deny' && r.specifier === undefined && ruleCoversTool(r, toolName));
  }

  isPathDenied(toolName: string, path: string): boolean {
    return this.matchPathRules('deny', toolName, [path]) !== undefined;
  }

  check(toolName: string, access: AccessRequest, hook?: HookVerdict): Decision {
    const decision = this.evaluate(toolName, access, hook);
    if (decision.behavior === 'ask' && this.mode === 'dontAsk') {
      return { behavior: 'deny', reason: `${decision.reason} (dontAsk mode denies anything that would prompt)` };
    }
    return decision;
  }

  private evaluate(toolName: string, access: AccessRequest, hook: HookVerdict): Decision {
    switch (access.kind) {
      case 'bash':
        return this.evaluateBash(toolName, access.command, hook, access.unsandboxed === true);
      case 'read':
        return this.evaluateRead(toolName, access.paths, hook);
      case 'edit':
        return this.evaluateEdit(toolName, access.paths, hook);
      case 'web':
        return this.evaluateWeb(toolName, access.url, hook);
      case 'mcp':
        return this.evaluateMcp(toolName, access.readOnlyHint, hook);
      case 'skill':
        return this.evaluateSkill(toolName, access, hook);
      case 'interactive':
        return this.evaluateGeneric(toolName, undefined, hook, this.mode === 'dontAsk' ? 'ask' : 'allow');
      case 'generic':
        return this.evaluateGeneric(toolName, access.specifier, hook, 'allow');
      case 'confirm':
        return this.evaluateConfirm(toolName, access.specifier, hook);
      case 'none':
        return this.evaluateGeneric(toolName, undefined, hook, 'allow');
    }
  }

  private rulesFor(behavior: RuleBehavior, toolName: string): PermissionRule[] {
    return [...this.rules, ...this.turnRules].filter((r) => r.behavior === behavior && ruleCoversTool(r, toolName));
  }

  private evaluateMcp(toolName: string, readOnlyHint: boolean, hook: HookVerdict): Decision {
    const denied = this.rulesFor('deny', toolName)[0];
    if (denied) return { behavior: 'deny', reason: `Denied by rule ${denied.text}` };
    const asked = this.rulesFor('ask', toolName)[0];
    if (asked) return { behavior: 'ask', reason: `Rule ${asked.text} requires confirmation`, forced: true };
    if (this.mode === 'bypassPermissions') return { behavior: 'allow', reason: 'bypassPermissions mode' };
    if (this.mode === 'plan' && !readOnlyHint) {
      return { behavior: 'deny', reason: 'Plan mode only allows MCP tools that declare themselves read-only' };
    }
    if (hook === 'ask') return { behavior: 'ask', reason: 'A hook requires confirmation' };
    if (hook === 'allow' && this.mode !== 'plan') return { behavior: 'allow', reason: 'Approved by a hook' };
    if (this.rulesFor('allow', toolName).length > 0) return { behavior: 'allow', reason: 'Approved by an allow rule' };
    return {
      behavior: 'ask',
      reason: 'Tool from an MCP server',
      suggestions: [{ rule: toolName, persist: true }],
    };
  }

  private evaluateSkill(toolName: string, access: Extract<AccessRequest, { kind: 'skill' }>, hook: HookVerdict): Decision {
    const invocation = access.args ? `${access.name} ${access.args}` : access.name;
    const matches = (rule: PermissionRule): boolean =>
      rule.specifier === undefined || matchBashPattern(rule.specifier, invocation);
    const denied = this.rulesFor('deny', toolName).find(matches);
    if (denied) return { behavior: 'deny', reason: `Denied by rule ${denied.text}` };
    const asked = this.rulesFor('ask', toolName).find(matches);
    if (asked) return { behavior: 'ask', reason: `Rule ${asked.text} requires confirmation`, forced: true };
    if (this.mode === 'bypassPermissions') return { behavior: 'allow', reason: 'bypassPermissions mode' };
    if (hook === 'ask') return { behavior: 'ask', reason: 'A hook requires confirmation' };
    if (hook === 'allow') return { behavior: 'allow', reason: 'Approved by a hook' };
    if (this.rulesFor('allow', toolName).some(matches)) return { behavior: 'allow', reason: 'Approved by an allow rule' };
    // A skill that only adds text cannot do anything by itself, so it does not need a prompt.
    if (!access.privileged) return { behavior: 'allow', reason: 'Skill only adds instructions' };
    return {
      behavior: 'ask',
      reason: `Skill "${access.name}" can run commands or pre-approve tools`,
      suggestions: [{ rule: `Skill(${access.name} *)`, persist: true }],
    };
  }

  private matchPathRules(behavior: RuleBehavior, toolName: string, paths: string[]): PermissionRule | undefined {
    return this.rulesFor(behavior, toolName).find((rule) => {
      if (rule.specifier === undefined) return true;
      return paths.some((path) => this.pathRuleMatches(rule, path));
    });
  }

  private pathRuleMatches(rule: PermissionRule, path: string): boolean {
    const ctx = { cwd: this.cwd(), home: homedir(), anchor: rule.anchor, behavior: rule.behavior };
    const specifier = rule.specifier!;
    const canonical = canonicalize(path);
    // A symlink must not dodge a restrictive rule, nor stretch an allow rule to somewhere new.
    return rule.behavior === 'allow'
      ? matchPathPattern(specifier, canonical, ctx)
      : matchPathPattern(specifier, path, ctx) || matchPathPattern(specifier, canonical, ctx);
  }

  private isInsideWorkingDirs(path: string): boolean {
    const canonical = canonicalize(path);
    return this.dirs.some((dir) => isInside(canonical, dir));
  }

  private evaluateGeneric(toolName: string, specifier: string | undefined, hook: HookVerdict, fallback: RuleBehavior): Decision {
    const matches = (rule: PermissionRule): boolean => rule.specifier === undefined || rule.specifier === specifier;
    const denied = this.rulesFor('deny', toolName).find(matches);
    if (denied) return { behavior: 'deny', reason: `Denied by rule ${denied.text}` };
    const asked = this.rulesFor('ask', toolName).find(matches);
    if (asked) return { behavior: 'ask', reason: `Rule ${asked.text} requires confirmation`, forced: true };
    if (hook === 'ask') return { behavior: 'ask', reason: 'A hook requires confirmation' };
    if (fallback === 'ask') return { behavior: 'ask', reason: `${toolName} needs a person to answer` };
    return { behavior: 'allow', reason: 'No approval needed' };
  }

  private evaluateConfirm(toolName: string, specifier: string | undefined, hook: HookVerdict): Decision {
    const matches = (rule: PermissionRule): boolean => rule.specifier === undefined || rule.specifier === specifier;
    const denied = this.rulesFor('deny', toolName).find(matches);
    if (denied) return { behavior: 'deny', reason: `Denied by rule ${denied.text}` };
    const asked = this.rulesFor('ask', toolName).find(matches);
    if (asked) return { behavior: 'ask', reason: `Rule ${asked.text} requires confirmation`, forced: true };
    if (this.mode === 'bypassPermissions') return { behavior: 'allow', reason: 'bypassPermissions mode' };
    if (hook === 'ask') return { behavior: 'ask', reason: 'A hook requires confirmation' };
    if (hook === 'allow') return { behavior: 'allow', reason: 'Approved by a hook' };
    if (this.rulesFor('allow', toolName).some(matches)) return { behavior: 'allow', reason: 'Approved by an allow rule' };
    return { behavior: 'ask', reason: `${toolName} needs your approval`, suggestions: [{ rule: toolName, persist: false }] };
  }

  private evaluateRead(toolName: string, paths: string[], hook: HookVerdict): Decision {
    const denied = this.matchPathRules('deny', toolName, paths);
    if (denied) return { behavior: 'deny', reason: `Denied by rule ${denied.text}` };
    const asked = this.matchPathRules('ask', toolName, paths);
    if (asked) return { behavior: 'ask', reason: `Rule ${asked.text} requires confirmation`, forced: true };
    if (this.mode === 'bypassPermissions') return { behavior: 'allow', reason: 'bypassPermissions mode' };
    if (hook === 'ask') return { behavior: 'ask', reason: 'A hook requires confirmation' };
    if (hook === 'allow') return { behavior: 'allow', reason: 'Approved by a hook' };

    const outside = paths.filter((path) => !this.isInsideWorkingDirs(path));
    const unapproved = outside.filter((path) => !this.isPathAllowedByRule(toolName, path));
    if (unapproved.length === 0) return { behavior: 'allow', reason: 'Read inside the working directories' };
    return {
      behavior: 'ask',
      reason: `Read outside the working directories: ${unapproved.join(', ')}`,
      suggestions: unapproved.map((path) => ({ rule: `Read(/${canonicalize(path)})`, persist: false })),
    };
  }

  private isPathAllowedByRule(toolName: string, path: string): boolean {
    return this.rulesFor('allow', toolName).some((rule) => rule.specifier === undefined || this.pathRuleMatches(rule, path));
  }

  private evaluateEdit(toolName: string, paths: string[], hook: HookVerdict): Decision {
    const denied = this.matchPathRules('deny', toolName, paths);
    if (denied) return { behavior: 'deny', reason: `Denied by rule ${denied.text}` };
    const asked = this.matchPathRules('ask', toolName, paths);
    if (asked) return { behavior: 'ask', reason: `Rule ${asked.text} requires confirmation`, forced: true };
    if (this.mode === 'bypassPermissions') return { behavior: 'allow', reason: 'bypassPermissions mode' };
    if (this.mode === 'plan') {
      // The plan file is the one thing plan mode may write.
      const planFile = this.planFile;
      if (planFile && paths.every((path) => canonicalize(path) === canonicalize(planFile))) return { behavior: 'allow', reason: 'The plan file' };
      return { behavior: 'deny', reason: 'Plan mode does not allow file changes' };
    }
    if (hook === 'ask') return { behavior: 'ask', reason: 'A hook requires confirmation' };

    const protectedPath = paths.find((path) => isProtectedPath(path) || isProtectedPath(canonicalize(path)));
    if (protectedPath) return { behavior: 'ask', reason: `${protectedPath} is a protected path`, forced: true };
    if (hook === 'allow') return { behavior: 'allow', reason: 'Approved by a hook' };
    if (paths.every((path) => this.isPathAllowedByRule(toolName, path))) {
      return { behavior: 'allow', reason: 'Approved by an allow rule' };
    }
    const allInside = paths.every((path) => this.isInsideWorkingDirs(path));
    if (this.mode === 'acceptEdits' && allInside) return { behavior: 'allow', reason: 'acceptEdits mode' };
    return {
      behavior: 'ask',
      reason: allInside ? 'File change needs approval' : 'File change outside the working directories',
      suggestions: allInside ? this.dirs.map((dir) => ({ rule: `Edit(/${dir}/**)`, persist: false })) : [],
    };
  }

  private evaluateWeb(toolName: string, url: string, hook: HookVerdict): Decision {
    let host = '';
    try {
      host = new URL(url).hostname;
    } catch {
      return { behavior: 'deny', reason: `Invalid URL: ${url}` };
    }
    const matches = (rule: PermissionRule): boolean =>
      rule.specifier === undefined || matchDomain(rule.specifier, host);
    const denied = this.rulesFor('deny', toolName).find(matches);
    if (denied) return { behavior: 'deny', reason: `Denied by rule ${denied.text}` };
    const asked = this.rulesFor('ask', toolName).find(matches);
    if (asked) return { behavior: 'ask', reason: `Rule ${asked.text} requires confirmation`, forced: true };
    if (this.mode === 'bypassPermissions') return { behavior: 'allow', reason: 'bypassPermissions mode' };
    if (hook === 'ask') return { behavior: 'ask', reason: 'A hook requires confirmation' };
    if (hook === 'allow') return { behavior: 'allow', reason: 'Approved by a hook' };
    if (this.rulesFor('allow', toolName).some(matches)) return { behavior: 'allow', reason: 'Approved by an allow rule' };
    return {
      behavior: 'ask',
      reason: `Fetch from ${host}`,
      suggestions: [{ rule: `WebFetch(domain:${host})`, persist: true }],
    };
  }

  private bashContext(): BashContext {
    return { cwd: this.cwd(), workingDirs: this.dirs };
  }

  private evaluateBash(toolName: string, command: string, hook: HookVerdict, unsandboxed: boolean): Decision {
    const analysis = analyzeShell(command);
    const ctx = this.bashContext();
    const commands = [...analysis.commands, ...analysis.commands.flatMap(inlineShellCommands)];
    const texts = [command.trim(), ...commands.flatMap(restrictiveForms), ...(unsandboxed ? ['dangerouslyDisableSandbox:true'] : [])];
    const restrictedBy = (behavior: RuleBehavior): PermissionRule | undefined =>
      this.rulesFor(behavior, toolName).find(
        (rule) => rule.specifier === undefined || texts.some((text) => matchBashPattern(rule.specifier!, text)),
      );

    const denied = restrictedBy('deny');
    if (denied) return { behavior: 'deny', reason: `Denied by rule ${denied.text}` };
    const fileDenied = this.deniedFileAccess(commands, ctx);
    if (fileDenied) return { behavior: 'deny', reason: fileDenied };

    if (commands.some((cmd) => isCriticalRemoval(cmd, ctx))) {
      return { behavior: 'ask', reason: 'Removes a critical path, or one that cannot be determined', forced: true };
    }
    const sandboxed = this.mode !== 'plan' && this.sandbox?.autoAllows(command, unsandboxed) === true;
    const asked = restrictedBy('ask');
    // A bare `Bash` ask rule is about prompting in general, which the sandbox replaces.
    // One that names this command still asks.
    if (asked && !(sandboxed && asked.specifier === undefined)) {
      return { behavior: 'ask', reason: `Rule ${asked.text} requires confirmation`, forced: true };
    }
    if (this.mode === 'bypassPermissions') return { behavior: 'allow', reason: 'bypassPermissions mode' };

    const readOnly =
      analysis.parseable &&
      analysis.commands.length > 0 &&
      analysis.commands.every((cmd) => isReadOnlyCommand(cmd, ctx)) &&
      !hasRiskyCdCombination(analysis.commands, ctx);

    if (this.mode === 'plan') {
      return readOnly
        ? { behavior: 'allow', reason: 'Read-only command' }
        : { behavior: 'deny', reason: 'Plan mode only allows read-only shell commands' };
    }
    if (hook === 'ask') return { behavior: 'ask', reason: 'A hook requires confirmation' };
    if (hook === 'allow') return { behavior: 'allow', reason: 'Approved by a hook' };
    if (readOnly) return { behavior: 'allow', reason: 'Read-only command' };
    if (sandboxed) return { behavior: 'allow', reason: 'Runs inside the OS sandbox' };

    const allowRules = this.rulesFor('allow', toolName);
    if (allowRules.some((rule) => rule.specifier === undefined)) {
      return { behavior: 'allow', reason: 'Approved by an allow rule' };
    }
    if (!analysis.parseable) {
      return { behavior: 'ask', reason: `Command could not be fully analyzed: ${analysis.reason}` };
    }
    if (hasRiskyCdCombination(analysis.commands, ctx)) {
      return { behavior: 'ask', reason: 'Changes directory before running git or writing a file' };
    }

    const uncovered = analysis.commands.filter((cmd) => !this.commandIsApproved(cmd, allowRules, ctx));
    if (uncovered.length === 0) return { behavior: 'allow', reason: 'Approved by allow rules' };
    return {
      behavior: 'ask',
      reason: unsandboxed && this.sandbox ? 'Bash command (unsandboxed)' : 'Shell command needs approval',
      suggestions: uncovered
        .slice(0, 5)
        .flatMap((cmd) => {
          const text = allowForm(cmd);
          // A pattern character in the saved text would widen the rule beyond this command.
          return text && !text.includes('*') ? [{ rule: `Bash(${text})`, persist: true }] : [];
        }),
    };
  }

  private commandIsApproved(cmd: SimpleCommand, allowRules: PermissionRule[], ctx: BashContext): boolean {
    if (isReadOnlyCommand(cmd, ctx)) return true;
    if (!writeTargetsAreSafe(cmd, ctx)) return false;
    if (this.mode === 'acceptEdits' && isAcceptEditsCommand(cmd, ctx)) return true;
    const text = allowForm(cmd);
    if (text === null || text === '') return false;
    return allowRules.some((rule) => rule.specifier !== undefined && matchBashPattern(rule.specifier, text));
  }

  /** Read and Edit deny rules also apply to what a shell command visibly reads or writes. */
  private deniedFileAccess(commands: SimpleCommand[], ctx: BashContext): string | undefined {
    for (const cmd of commands) {
      for (const target of writeTargets(cmd)) {
        const path = writePath(target, ctx.cwd);
        if (path === null) continue;
        const rule = this.matchPathRules('deny', 'Edit', [path]);
        if (rule?.specifier !== undefined) return `Denied by rule ${rule.text}`;
      }
      const reads = readPaths(cmd, ctx.cwd);
      for (const redirect of cmd.redirects) {
        if (redirect.op === '<') reads.push(resolve(ctx.cwd, redirect.target.value));
      }
      if (reads.length > 0) {
        const rule = this.matchPathRules('deny', 'Read', reads);
        if (rule?.specifier !== undefined) return `Denied by rule ${rule.text}`;
      }
    }
    return undefined;
  }
}
