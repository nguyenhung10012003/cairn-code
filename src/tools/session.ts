/** Tools that act on the session itself: worktrees, desktop notifications and web search. */
import { PROJECT_DIR } from '../config/paths.ts';
import type { Tool } from './types.ts';

export const enterWorktreeTool: Tool = {
  name: 'EnterWorktree',
  description: `Use this tool ONLY when explicitly instructed to work in a worktree — either by the user directly, or by project instructions (CAIRN.md / memory). This tool creates an isolated git worktree and switches the current session into it.

### When to Use

- The user explicitly says "worktree" (e.g., "start a worktree", "work in a worktree", "create a worktree", "use a worktree")
- CAIRN.md or memory instructions direct you to work in a worktree for the current task

### When NOT to Use

- The user asks to create a branch, switch branches, or work on a different branch — use git commands instead
- The user asks to fix a bug or work on a feature — use normal git workflow unless worktrees are explicitly requested by the user or project instructions
- Never use this tool unless "worktree" is explicitly mentioned by the user or in CAIRN.md / memory instructions

### Requirements

- Must be in a git repository
- Must not already be in a worktree session when creating a new worktree (\`name\`); switching into another existing worktree via \`path\` is allowed

### Behavior

- Creates a new git worktree inside \`${PROJECT_DIR}/worktrees/\` on a new branch. The base ref is governed by the \`worktree.baseRef\` setting: \`fresh\` (default) branches from origin/\`<default-branch>\`; \`head\` branches from your current local HEAD
- Switches the session's working directory to the new worktree
- Use ExitWorktree to leave the worktree mid-session (keep or remove). On session exit, if still in the worktree, the user will be prompted to keep or remove it

### Entering an existing worktree

Pass \`path\` instead of \`name\` to switch the session into a worktree that already exists (e.g., one you just created with \`git worktree add\`). The path must appear in \`git worktree list\` for the current repository; other paths are rejected. ExitWorktree will not remove a worktree entered this way; use \`action: "keep"\` to return to the original directory.

Switching with \`path\` also works when the session is already in a worktree (the previous worktree is left on disk, untouched, and only the new one is tracked for exit-time cleanup).

### Parameters

- \`name\` (optional): A name for a new worktree. If neither \`name\` nor \`path\` is provided, a random name is generated.
- \`path\` (optional): Path to an existing worktree to enter instead of creating one. Mutually exclusive with \`name\`.`,
  inputSchema: {
    type: 'object',
    properties: {
      name: {
        description:
          'Optional name for a new worktree. Each "/"-separated segment may contain only letters, digits, dots, underscores, and dashes; max 64 chars total. A random name is generated if not provided. Mutually exclusive with `path`.',
        type: 'string',
      },
      path: { description: 'Path to an existing worktree to switch into instead of creating a new one. Must appear in `git worktree list` for the current repo. Mutually exclusive with `name`.', type: 'string' },
    },
    additionalProperties: false,
  },
  isReadOnly: () => false,
  access: () => ({ kind: 'none' }),
  async execute(input, ctx) {
    if (!ctx.worktrees) return { content: 'Worktrees are not available here.', isError: true };
    if (input.name !== undefined && input.path !== undefined) return { content: 'Give name or path, not both.', isError: true };
    try {
      const options = {
        ...(input.name === undefined ? {} : { name: input.name as string }),
        ...(input.path === undefined ? {} : { path: input.path as string }),
      };
      return { content: await ctx.worktrees.enter(options), display: 'entered worktree' };
    } catch (error) {
      return { content: (error as Error).message, isError: true };
    }
  },
};

export const exitWorktreeTool: Tool = {
  name: 'ExitWorktree',
  description: `Exit a worktree session created by EnterWorktree and return the session to the original working directory.

### Scope

This tool ONLY operates on worktrees created by EnterWorktree in this session. It will NOT touch:
- Worktrees you created manually with \`git worktree add\`
- Worktrees from a previous session (even if created by EnterWorktree then)
- The directory you're in if EnterWorktree was never called

If called outside an EnterWorktree session, the tool is a **no-op**: it reports that no worktree session is active and takes no action. Filesystem state is unchanged.

### When to Use

- The user explicitly asks to "exit the worktree", "leave the worktree", "go back", or otherwise end the worktree session
- Do NOT call this proactively — only when the user asks

### Parameters

- \`action\` (required): \`"keep"\` or \`"remove"\`
  - \`"keep"\` — leave the worktree directory and branch intact on disk. Use this if the user wants to come back to the work later, or if there are changes to preserve.
  - \`"remove"\` — delete the worktree directory and its branch. Use this for a clean exit when the work is done or abandoned.
- \`discard_changes\` (optional, default false): only meaningful with \`action: "remove"\`. If the worktree has uncommitted files or commits not on the original branch, the tool will REFUSE to remove it unless this is set to \`true\`. If the tool returns an error listing changes, confirm with the user before re-invoking with \`discard_changes: true\`.

### Behavior

- Restores the session's working directory to where it was before EnterWorktree
- Once exited, EnterWorktree can be called again to create a fresh worktree`,
  inputSchema: {
    type: 'object',
    properties: {
      action: { description: '"keep" leaves the worktree and branch on disk; "remove" deletes both.', type: 'string', enum: ['keep', 'remove'] },
      discard_changes: {
        description: 'Required true when action is "remove" and the worktree has uncommitted files or unmerged commits. The tool will refuse and list them otherwise.',
        type: 'boolean',
      },
    },
    required: ['action'],
    additionalProperties: false,
  },
  isReadOnly: () => false,
  access: () => ({ kind: 'none' }),
  async execute(input, ctx) {
    if (!ctx.worktrees) return { content: 'Worktrees are not available here.', isError: true };
    return ctx.worktrees.exit(input.action as 'keep' | 'remove', input.discard_changes === true);
  },
};

export const pushNotificationTool: Tool = {
  name: 'PushNotification',
  description: `This tool sends a desktop notification in the user's terminal. It pulls their attention from whatever they're doing — a meeting, another task, dinner — to this session. That's the cost. The benefit is they learn something now that they'd want to know now: a long task finished while they were away, a build is ready, you've hit something that needs their decision before you can continue.

Because a notification they didn't need is annoying in a way that accumulates, err toward not sending one. Don't notify for routine progress, or to announce you've answered something they asked seconds ago and are clearly still watching, or when a quick task completes. Notify when there's a real chance they've walked away and there's something worth coming back for — or when they've explicitly asked you to notify them.

Keep the message under 200 characters, one line, no markdown. Lead with what they'd act on — "build failed: 2 auth tests" tells them more than "task done" and more than a status dump.

When the user is actively at the terminal, your output already reaches them — a notification on top of it would be a duplicate, so the tool skips it and says so. A "not sent" result is expected and only ever about this one notification: it was redundant, turned off, or had nowhere to go.`,
  inputSchema: {
    type: 'object',
    properties: {
      message: { description: 'The notification body. Keep it under 200 characters; mobile OSes truncate.', type: 'string', minLength: 1 },
      status: { description: 'Always "proactive".', type: 'string', const: 'proactive' },
    },
    required: ['message', 'status'],
    additionalProperties: false,
  },
  isReadOnly: () => true,
  access: () => ({ kind: 'none' }),
  async execute(input, ctx) {
    if (!ctx.pushNotification) return { content: 'Not sent: notifications have nowhere to go in this session.' };
    const result = await ctx.pushNotification((input.message as string).replace(/\s+/g, ' ').trim().slice(0, 200));
    return { content: result.sent ? `Sent: ${result.reason}` : `Not sent: ${result.reason}`, display: result.sent ? 'notification sent' : 'notification not sent' };
  },
};

