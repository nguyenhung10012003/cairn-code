import { existsSync, readFileSync } from 'node:fs';
import { APP_DISPLAY_NAME, PROJECT_DIR } from '../config/paths.ts';
import type { Tool, TodoItem, UserQuestion } from './types.ts';

export const todoWriteTool: Tool = {
  name: 'TodoWrite',
  description:
    'Replace the whole task checklist for this session with the list you pass; it does not merge. ' +
    'Use it for work with several steps, and skip it for small tasks. The user sees how many items are done, and can list them. ' +
    'Keep at most one item in_progress and mark items completed as soon as they are done. It changes nothing on disk.',
  inputSchema: {
    type: 'object',
    properties: {
      todos: {
        type: 'array',
        description: 'The complete new checklist.',
        items: {
          type: 'object',
          properties: {
            content: { type: 'string', description: 'What to do, as one short line.' },
            status: { type: 'string', enum: ['pending', 'in_progress', 'completed'], description: 'Where this item stands.' },
          },
          required: ['content', 'status'],
          additionalProperties: false,
        },
      },
    },
    required: ['todos'],
    additionalProperties: false,
  },
  isReadOnly: () => true,
  access: () => ({ kind: 'none' }),
  async execute(input, ctx) {
    ctx.todos.items = input.todos as TodoItem[];
    const done = ctx.todos.items.filter((t) => t.status === 'completed').length;
    const summary = `${done}/${ctx.todos.items.length} done`;
    return { content: `Checklist updated: ${summary}.`, display: summary };
  },
};

export const askUserTool: Tool = {
  name: 'AskUserQuestion',
  description: `Use this tool only when you are blocked on a decision that is genuinely the user's to make: one you cannot resolve from the request, the code, or sensible defaults.

Usage notes:
- Users will always be able to select "Other" to provide custom text input
- Use multiSelect: true to allow multiple answers to be selected for a question
- If you recommend a specific option, make that the first option in the list and add "(Recommended)" at the end of the label

Plan mode note: To switch into plan mode, use EnterPlanMode (not this tool). Once in plan mode, use this tool to clarify requirements or choose between approaches BEFORE finalizing your plan. Do NOT use this tool to ask "Is my plan ready?", "Should I proceed?", or otherwise reference "the plan" in questions — the user cannot see the plan until you call ExitPlanMode for approval.

Reserve this for decisions where the user's answer changes what you do next — not for choices with a conventional default or facts you can verify in the codebase yourself. In those cases pick the obvious option, mention it in your response, and proceed.

The user may see only the question dialog: tool results and text you wrote earlier in this turn may not be on their screen while it is open. Make each question stand on its own: if it depends on something you found, say so briefly, and name the items you are asking about in the question itself.

Preview feature:
Use the optional \`preview\` field on options when presenting concrete artifacts that users need to visually compare:
- ASCII mockups of UI layouts or components
- Code snippets showing different implementations
- Diagram variations
- Configuration examples

Preview content is rendered as markdown in a monospace box. Multi-line text with newlines is supported. When any option has a preview, the UI switches to a side-by-side layout with a vertical option list on the left and preview on the right. Do not use previews for simple preference questions where labels and descriptions suffice. Note: previews are only supported for single-select questions (not multiSelect).`,
  inputSchema: {
    type: 'object',
    properties: {
      questions: {
        description: 'Questions to ask the user (1-4 questions)',
        minItems: 1,
        maxItems: 4,
        type: 'array',
        items: {
          type: 'object',
          properties: {
            question: {
              description:
                'The complete question to ask the user. Should be clear, specific, and end with a question mark. Example: "Which library should we use for date formatting?" If multiSelect is true, phrase it accordingly, e.g. "Which features do you want to enable?"',
              type: 'string',
            },
            header: {
              description: 'Very short label displayed as a chip/tag (max 12 chars). Examples: "Auth method", "Library", "Approach".',
              type: 'string',
            },
            options: {
              description:
                "The available choices for this question. Must have 2-4 options. Each option should be a distinct, mutually exclusive choice (unless multiSelect is enabled). There should be no 'Other' option, that will be provided automatically.",
              minItems: 2,
              maxItems: 4,
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  label: {
                    description: 'The display text for this option that the user will see and select. Should be concise (1-5 words) and clearly describe the choice.',
                    type: 'string',
                  },
                  description: {
                    description: 'Explanation of what this option means or what will happen if chosen. Useful for providing context about trade-offs or implications.',
                    type: 'string',
                  },
                  preview: {
                    description:
                      'Optional preview content rendered when this option is focused. Use for mockups, code snippets, or visual comparisons that help users compare options. See the tool description for the expected content format.',
                    type: 'string',
                  },
                },
                required: ['label', 'description'],
                additionalProperties: false,
              },
            },
            multiSelect: {
              description: 'Set to true to allow the user to select multiple options instead of just one. Use when choices are not mutually exclusive.',
              default: false,
              type: 'boolean',
            },
          },
          required: ['question', 'header', 'options', 'multiSelect'],
          additionalProperties: false,
        },
      },
      answers: {
        description: 'User answers collected by the permission component',
        type: 'object',
        propertyNames: { type: 'string' },
        additionalProperties: { type: 'string' },
      },
      annotations: {
        description: 'Optional per-question annotations from the user (e.g., notes on preview selections). Keyed by question text.',
        type: 'object',
        propertyNames: { type: 'string' },
        additionalProperties: {
          type: 'object',
          properties: {
            preview: { description: 'The preview content of the selected option, if the question used previews.', type: 'string' },
            notes: { description: 'Free-text notes the user added to their selection.', type: 'string' },
          },
          additionalProperties: false,
        },
      },
      metadata: {
        description: 'Optional metadata for tracking and analytics purposes. Not displayed to user.',
        type: 'object',
        properties: {
          source: {
            description: 'Optional identifier for the source of this question (e.g., "remember" for /remember command). Used for analytics tracking.',
            type: 'string',
          },
        },
        additionalProperties: false,
      },
    },
    required: ['questions'],
    additionalProperties: false,
  },
  isReadOnly: () => true,
  access: () => ({ kind: 'interactive' }),
  async execute(input, ctx) {
    const questions = input.questions as UserQuestion[];
    const answers = await ctx.prompter.questions(questions);
    if (answers === null) {
      return { content: 'Nobody is available to answer in this session. Choose a sensible default and say which you chose.', isError: true };
    }
    const pairs = questions.map((q, i) => `"${q.question}"="${answers[i] ?? ''}"`).join(', ');
    return { content: `User has answered your questions: ${pairs}. You can now continue with the user's answers in mind.` };
  },
};

export const enterPlanModeTool: Tool = {
  name: 'EnterPlanMode',
  description: `Use this tool proactively when you're about to start a non-trivial implementation task. Getting user sign-off on your approach before writing code prevents wasted effort and ensures alignment. This tool transitions you into plan mode where you can explore the codebase and design an implementation approach for user approval.

### When to Use This Tool

**Prefer using EnterPlanMode** for implementation tasks unless they're simple. Use it when ANY of these conditions apply:

1. **New Feature Implementation**: Adding meaningful new functionality
   - Example: "Add a logout button" - where should it go? What should happen on click?
   - Example: "Add form validation" - what rules? What error messages?

2. **Multiple Valid Approaches**: The task can be solved in several different ways
   - Example: "Add caching to the API" - could use Redis, in-memory, file-based, etc.
   - Example: "Improve performance" - many optimization strategies possible

3. **Code Modifications**: Changes that affect existing behavior or structure
   - Example: "Update the login flow" - what exactly should change?
   - Example: "Refactor this component" - what's the target architecture?

4. **Architectural Decisions**: The task requires choosing between patterns or technologies
   - Example: "Add real-time updates" - WebSockets vs SSE vs polling
   - Example: "Implement state management" - Redux vs Context vs custom solution

5. **Multi-File Changes**: The task will likely touch more than 2-3 files
   - Example: "Refactor the authentication system"
   - Example: "Add a new API endpoint with tests"

6. **Unclear Requirements**: You need to explore before understanding the full scope
   - Example: "Make the app faster" - need to profile and identify bottlenecks
   - Example: "Fix the bug in checkout" - need to investigate root cause

7. **User Preferences Matter**: The implementation could reasonably go multiple ways
   - If you would use AskUserQuestion to clarify the approach, use EnterPlanMode instead
   - Plan mode lets you explore first, then present options with context

### When NOT to Use This Tool

Only skip EnterPlanMode for simple tasks:
- Single-line or few-line fixes (typos, obvious bugs, small tweaks)
- Adding a single function with clear requirements
- Tasks where the user has given very specific, detailed instructions
- Pure research/exploration tasks (use the Agent tool instead)

### What Happens in Plan Mode

In plan mode, you'll:
1. Thoroughly explore the codebase using \`find\`/Glob, \`grep\`/Grep, and Read
2. Understand existing patterns and architecture
3. Design an implementation approach
4. Present your plan to the user for approval
5. Use AskUserQuestion if you need to clarify approaches
6. Exit plan mode with ExitPlanMode when ready to implement

### Examples

#### GOOD - Use EnterPlanMode:
User: "Add user authentication to the app"
- Requires architectural decisions (session vs JWT, where to store tokens, middleware structure)

User: "Optimize the database queries"
- Multiple approaches possible, need to profile first, significant impact

User: "Implement dark mode"
- Architectural decision on theme system, affects many components

User: "Add a delete button to the user profile"
- Seems simple but involves: where to place it, confirmation dialog, API call, error handling, state updates

User: "Update the error handling in the API"
- Affects multiple files, user should approve the approach

#### BAD - Don't use EnterPlanMode:
User: "Fix the typo in the README"
- Straightforward, no planning needed

User: "Add a console.log to debug this function"
- Simple, obvious implementation

User: "What files handle routing?"
- Research task, not implementation planning

### Important Notes

- This tool REQUIRES user approval - they must consent to entering plan mode
- If unsure whether to use it, err on the side of planning - it's better to get alignment upfront than to redo work
- Users appreciate being consulted before significant changes are made to their codebase`,
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  isReadOnly: () => true,
  access: () => ({ kind: 'confirm' }),
  async execute(_input, ctx) {
    if (ctx.getMode() === 'plan') return { content: 'The session is already in plan mode.' };
    // Would otherwise turn off a mode the user chose for its prompts or lack of them.
    if (ctx.getMode() === 'bypassPermissions') return { content: 'Plan mode is not available while permission checks are off.', isError: true };
    if (ctx.planMode) ctx.planMode.enter();
    else ctx.setMode('plan');
    return {
      content: 'Entered plan mode. You should now focus on exploring the codebase and designing an implementation approach. Follow the plan mode instructions in the system reminder.',
      display: 'plan mode',
    };
  },
};

export const exitPlanModeTool: Tool = {
  name: 'ExitPlanMode',
  description: `Use this tool when you are in plan mode and have finished writing your plan to the plan file and are ready for user approval.

### How This Tool Works
- You should have already written your plan to the plan file specified in the plan mode system message
- This tool does NOT take the plan content as a parameter - it will read the plan from the file you wrote
- This tool simply signals that you're done planning and ready for the user to review and approve
- The user will see the contents of your plan file when they review it

### When to Use This Tool
IMPORTANT: Only use this tool when the task requires planning the implementation steps of a task that requires writing code. For research tasks where you're gathering information, searching files, reading files or in general trying to understand the codebase - do NOT use this tool.

### Before Using This Tool
Ensure your plan is complete and unambiguous:
- If you have unresolved questions about requirements or approach, use AskUserQuestion first (in earlier phases)
- Once your plan is finalized, use THIS tool to request approval

**Important:** Do NOT use AskUserQuestion to ask "Is this plan okay?" or "Should I proceed?" - that's exactly what THIS tool does. ExitPlanMode inherently requests user approval of your plan.

### Examples

1. Initial task: "Search for and understand the implementation of vim mode in the codebase" - Do not use the exit plan mode tool because you are not planning the implementation steps of a task.
2. Initial task: "Help me implement yank mode for vim" - Use the exit plan mode tool after you have finished planning the implementation steps of the task.
3. Initial task: "Add a new feature to handle user authentication" - If unsure about auth method (OAuth, JWT, etc.), use AskUserQuestion first, then use exit plan mode tool after clarifying the approach.`,
  inputSchema: {
    type: 'object',
    properties: {
      allowedPrompts: {
        description: 'Deprecated: no longer used.',
        type: 'array',
        items: {
          type: 'object',
          properties: {
            tool: { description: 'The tool this prompt applies to', type: 'string', enum: ['Bash'] },
            prompt: { description: 'Semantic description of the action, e.g. "run tests", "install dependencies"', type: 'string' },
          },
          required: ['tool', 'prompt'],
          additionalProperties: false,
        },
      },
    },
    additionalProperties: {},
  },
  isReadOnly: () => true,
  access: () => ({ kind: 'none' }),
  async execute(input, ctx) {
    if (ctx.getMode() !== 'plan') return { content: 'The session is not in plan mode.', isError: true };
    const file = ctx.planMode?.file();
    let plan = file && existsSync(file) ? readFileSync(file, 'utf8').trim() : '';
    // An older caller may still pass the plan inline.
    if (!plan && typeof input.plan === 'string') plan = input.plan;
    if (!plan) return { content: `No plan found. Write your plan to ${file ?? 'the plan file'} first, then call ExitPlanMode again.`, isError: true };
    const approved = await ctx.prompter.approvePlan(plan);
    if (!approved) return { content: 'The user did not approve this plan. Stay in plan mode and ask what to change.', isError: true };
    if (ctx.planMode) ctx.planMode.exit();
    else ctx.setMode('default');
    const saved = file ? `\n\nYour plan has been saved to: ${file}\nYou can refer back to it if needed during implementation.` : '';
    return { content: `User has approved your plan. You can now start coding. Start with updating your todo list if applicable${saved}\n\n## Approved Plan:\n${plan}` };
  },
};

export const agentTool: Tool = {
  name: 'Agent',
  description: `Launch a new agent to handle complex, multi-step tasks. Each agent type has specific capabilities and tools available to it.

Available agent types are listed in the system prompt.

When using the Agent tool, specify a subagent_type to select an agent: \`"fork"\` forks yourself (the fork inherits your full conversation context and always runs on your model — a \`model\` override is ignored); any other type — or omitting it — starts a fresh agent (general-purpose by default).

### When to use

A fresh agent costs more than it looks. It knows only what you put in the prompt, and you see only the summary it sends back — both handoffs drop detail, and neither of you can tell what the other missed. You can't watch it work, only wait or cancel. Its mistakes come back in the same confident register as its findings, and an agent handed your hypothesis tends to return it confirmed. Several at once spend tokens in a burst the user didn't ask for. Weigh those tokens against the accuracy they buy: the user pays for agents you did not need, and pays again for work you redo because you skipped one.

Reach for this when you have independent work to run in parallel, when the user asks for a side quest that shouldn't block your main thread, or when answering would mean reading across several files — delegate that and you keep the conclusion, not the file dumps.

Do the work yourself when it is a handful of tool calls or a lookup whose target you already know; don't delegate a check you could run inline. Delegate review only when you want a read that isn't anchored on yours — then give it the code, not your conclusion. Once you've delegated something, don't also run it yourself; wait for the result. When in doubt, don't spawn.

When you do spawn one, brief it like the peer it is: state the goal and what you have already ruled out, point it at the files and docs worth reading instead of retyping them, and keep the scope explicit and narrow. That brief is the only context it will have, so it is your first lever on every cost above — and if you cannot write a clear one, you do not understand the task well enough to hand it off.

A fork runs in the background and keeps its tool output out of your context. If you are the fork, execute directly — don't re-delegate. Subagents run in the background; you'll be notified when one completes. Never fabricate or predict a pending agent's results — the notification is never something you write yourself; if the user asks before it arrives, say it's still running.

- The agent's final report is not shown to the user — relay what matters.
- Use SendMessage with the agent's ID to continue a previously spawned agent with its context intact; a new Agent call starts fresh (except subagent_type: "fork", which inherits your context).
- Each agent type's model, reasoning effort, and tools come from its definition (\`${PROJECT_DIR}/agents/*.md\` frontmatter or \`--agents\`).
- \`isolation: "worktree"\` gives the agent its own git worktree (auto-cleaned if unchanged).`,
  inputSchema: {
    type: 'object',
    properties: {
      description: { description: 'A short (3-5 word) description of the task', type: 'string' },
      prompt: { description: 'The task for the agent to perform', type: 'string' },
      subagent_type: { description: 'The type of specialized agent to use for this task', type: 'string' },
      model: {
        description:
          'Optional model override for this agent. Takes precedence over the agent definition\'s model frontmatter and the configured default subagent model. If omitted, uses the agent definition\'s model, else the default (inherits from the parent unless a default subagent model is configured). Ignored for subagent_type: "fork" — forks always inherit the parent model.',
        type: 'string',
        enum: ['sonnet', 'opus', 'haiku', 'fable'],
      },
      effort: {
        description:
          'Reasoning effort for this agent. Set this ONLY when the user, or instructions such as CAIRN.md or a skill, explicitly ask that this agent or delegated work run at a specific effort level, never on your own judgment; otherwise omit it and the agent runs at its usual effort. Ignored for subagent_type: "fork": a fork runs at your own effort.',
        type: 'string',
        enum: ['low', 'medium', 'high', 'xhigh', 'max'],
      },
      isolation: {
        description: `Isolation mode. "worktree" creates a temporary git worktree so the agent works on an isolated copy of the repo. "remote" launches the agent in a remote cloud environment (not available in ${APP_DISPLAY_NAME}).`,
        type: 'string',
        enum: ['worktree', 'remote'],
      },
    },
    required: ['description', 'prompt'],
    additionalProperties: false,
  },
  // Its writes are checked individually when the subagent makes them.
  isReadOnly: () => true,
  access: (input) => {
    const type = input.subagent_type as string | undefined;
    return type === undefined ? { kind: 'generic' } : { kind: 'generic', specifier: type };
  },
  async execute(input, ctx) {
    if (input.isolation === 'remote') return { content: `Remote agents are not available in ${APP_DISPLAY_NAME}. Leave isolation unset, or use "worktree".`, isError: true };
    const request = {
      description: input.description as string,
      prompt: input.prompt as string,
      ...(input.subagent_type === undefined ? {} : { subagentType: input.subagent_type as string }),
      ...(input.model === undefined ? {} : { model: input.model as string }),
      ...(input.effort === undefined ? {} : { effort: input.effort as 'low' }),
      ...(input.isolation === 'worktree' ? { isolation: 'worktree' as const } : {}),
    };
    if (ctx.agents) {
      try {
        const id = await ctx.agents.start(request);
        return {
          content:
            `Async agent launched successfully.\nagentId: ${id} (use SendMessage with to: "${id}" to continue this agent)\n` +
            'The agent is working in the background. You will be notified automatically when it completes. ' +
            "Do not duplicate this agent's work, and do not predict or make up its results.",
          display: `agent ${id} started in the background`,
        };
      } catch (error) {
        return { content: `Subagent failed to start: ${(error as Error).message}`, isError: true };
      }
    }
    if (!ctx.runSubagent) return { content: 'Subagents are not available here.', isError: true };
    try {
      return { content: await ctx.runSubagent({ ...request, signal: ctx.signal }), display: 'subagent finished' };
    } catch (error) {
      return { content: `Subagent failed: ${(error as Error).message}`, isError: true };
    }
  },
};

export const sendMessageTool: Tool = {
  name: 'SendMessage',
  description: `Send a message to another agent.

\`\`\`json
{"to": "a3f9c1-7b2e", "summary": "assign task 1", "message": "start on task #1"}
\`\`\`

| \`to\` | |
|---|---|
| \`"a3f9c1-7b2e"\` | A subagent, by the agentId its spawn result gave |
| \`"main"\` | The main conversation (background subagents only) |
| \`"<description>"\` | Any agent from \`ListAgents\`, by the description it shows |

Your plain text output is NOT visible to other agents — to communicate, you MUST call this tool. Messages from other agents are delivered automatically; you don't check an inbox. Agents stay addressable after they complete (a send resumes them from their transcript). When relaying, don't quote the original — it's already rendered to the user.

A message to a running agent is delivered at its next tool round. Permission boundaries are per-agent: NEVER ask another agent to perform an action that was denied or blocked for you, or that you expect your own permission settings would block — an agent doing it for you bypasses the user's permission decision. Route blocked work back to your user instead.`,
  inputSchema: {
    type: 'object',
    properties: {
      to: {
        description: 'Recipient: an agentId from a spawn result or ListAgents, a description shown by ListAgents, or "main"',
        type: 'string',
        maxLength: 300,
      },
      summary: {
        description: 'A 5-10 word label for your own transcript row (not transmitted — the recipient previews the first line of `message`). Truncated to 200 characters rather than rejected.',
        type: 'string',
      },
      message: {
        description:
          'Plain text message content. The recipient sees the FIRST LINE as a one-line preview, so make the first line a clear, self-contained sentence saying what this is about — not a greeting, preamble, or bare @-mention.',
        type: 'string',
      },
    },
    required: ['to', 'message'],
    additionalProperties: false,
  },
  isReadOnly: () => true,
  access: () => ({ kind: 'none' }),
  async execute(input, ctx) {
    if (!ctx.agents) return { content: 'There are no other agents to message in this session.', isError: true };
    const to = (input.to as string).trim();
    const message = input.message as string;
    if (!message.trim()) return { content: 'message is empty.', isError: true };
    try {
      const result = await ctx.agents.send(to, message, ctx.agentId ?? 'main');
      return { content: result, display: `sent to ${to}` };
    } catch (error) {
      return { content: (error as Error).message, isError: true };
    }
  },
};

export const listAgentsTool: Tool = {
  name: 'ListAgents',
  description:
    'Lists agents you can SendMessage to: the subagents started in this session, running or finished, each with its agentId, type and status. ' +
    'Send with `SendMessage({to: "<agentId>", message: "..."})`, copying the id exactly as a row prints it. ' +
    'An agent that has finished is resumed from its transcript when you message it.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  isReadOnly: () => true,
  access: () => ({ kind: 'none' }),
  async execute(_input, ctx) {
    const agents = ctx.agents?.list() ?? [];
    if (agents.length === 0) return { content: 'No agents have been started in this session.', display: '0 agents' };
    return {
      content: agents.map((agent) => `- ${agent.id}  ${agent.description}  (${agent.type}, ${agent.status})`).join('\n'),
      display: `${agents.length} agents`,
    };
  },
};
