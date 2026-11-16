# Karst

A coding agent for the terminal. Karst reads and edits your code, runs commands and works through tasks with you, and asks before doing anything you have not allowed. It works with Anthropic, OpenAI, Ollama, or any server that speaks the Chat Completions API.

```sh
npm install -g karst-code
export ANTHROPIC_API_KEY=...
karst
```

## Features

- **Your choice of model:** Anthropic (the default), OpenAI, Ollama, and Chat Completions servers such as DeepSeek, Groq, OpenRouter, Mistral, LM Studio or vLLM. `/provider` and `/model` switch in the middle of a session.
- **Tools:** reading, writing and editing files, search, shell commands that can run in the background, web fetch and search, notebooks, images and PDFs, a task checklist, plan mode, git worktrees, scheduled prompts, and subagents that work in the background.
- **You stay in control:** permission rules and modes, approval prompts answered with the arrow keys (with an optional note for the model), an operating-system sandbox for shell commands, and a trust step before a repository's own settings take effect.
- **Extensible:** MCP servers, skills, custom commands and agents, hooks and plugins. Skills and plugins written for Claude Code work too.
- **Sessions:** saved transcripts to resume, fork and rename, `/rewind` to undo file changes, automatic compaction of long conversations, and memory across sessions.
- **Scripting:** `-p` prints one answer and exits, with text, JSON or stream-JSON output and answers that follow a JSON Schema.
- **Try it without a key:** a mock provider answers from a script, so you can try the whole interface first.

## Install

Requires [Node.js](https://nodejs.org) 22 or later.

```sh
npm install -g karst-code     # installs the `karst` command
npx karst-code                # or try it without installing
```

**In a repository you do not trust, run the installed `karst`, not `npx karst-code`.** npx prefers a copy of the package from the project's own `node_modules`, so the repository could supply its own.

## Moving from Cairn

Karst was called Cairn, published as `cairn-code`, until 0.2.0. It was renamed because Cairn Code (github.com/cairn/cairn), a different terminal coding agent, uses the same `cairn` command, `~/.cairn` folder and `CAIRN.md` file.

```sh
npm uninstall -g cairn-code
npm install -g karst-code
karst migrate --dry-run   # lists what would move from ~/.cairn to ~/.karst
karst migrate
```

`karst migrate` moves settings, saved keys, trust, sessions, memory, plans, skills, agents, plugins and MCP sign-ins, and `~/.cairn/CAIRN.md` becomes `~/.karst/KARST.md`. It replaces nothing already in `~/.karst`, and leaves in `~/.cairn` anything Cairn did not write. Karst reads nothing from Cairn's places, so in your projects rename `CAIRN.md` to `KARST.md`, `CAIRN.local.md` to `KARST.local.md`, `.cairn/` to `.karst/` and a plugin's `.cairn-plugin/` to `.karst-plugin/`, and in hooks and settings use `KARST_PROJECT_DIR`, `KARST_PLUGIN_ROOT` and the other `KARST_*` variables. `karst doctor` points out what it finds.

## Quick start

```sh
cd your-project
karst                                # interactive session
karst -p "explain this repo"         # answer once and exit
cat log.txt | karst -p "find bugs"   # also reads standard input
karst -c                             # continue the latest session in this directory
karst -r <id or name>                # resume an earlier session
karst usage                          # tokens and estimated cost per day; also: projects, sessions
karst doctor                         # check the installation
karst update                         # install the latest version
karst migrate                        # move what Cairn, the earlier name, saved in ~/.cairn
```

Each session checks npm for a newer version as it starts and says when there is one. `"updateCheck": false` in `~/.karst/settings.json` turns that off, and `"autoUpdates": true` installs it in the background instead.

Karst uses an Anthropic API key from the [Console](https://platform.claude.com), or `ANTHROPIC_AUTH_TOKEN`. Instead of exporting it each time, you can save it once with `karst provider key anthropic`. Karst does not use a Claude Code login or subscription.

## Choosing a provider and model

| Provider | Needs | Default model |
| --- | --- | --- |
| `anthropic` | `ANTHROPIC_API_KEY`, or a saved key | `claude-opus-5-5` |
| `openai` | `OPENAI_API_KEY`, or a saved key | `gpt-6-astra` |
| `ollama` | Ollama on this machine, or `OLLAMA_HOST` | `qwen3-coder:30b` |
| one you add | `karst provider add` | the one you choose |

```sh
karst --provider openai --model gpt-6.1-sol
karst provider add deepseek --type openai-chat --base-url https://api.deepseek.com/v1 --model deepseek-chat
karst provider list                  # every provider, its model, and where its key comes from
karst provider use deepseek          # the default for new sessions
karst provider remove deepseek
```

`karst provider add` asks for the key without showing it. Without `--type`, it also asks for the type, the base URL and the model. The types are `anthropic`, `openai`, `openai-chat` (Chat Completions) and `ollama`.

In a session, `/provider` opens a list of providers: type to narrow it, use `↑` `↓` and `Enter` to choose, or pick "Add a provider…". `/model` lists the current provider's models; for Ollama and Chat Completions servers, the list comes from the server. The conversation carries on with the new provider, and new sessions start with your last choice.

**Keys** are saved in `~/.karst/credentials.json`, which only you can read, and never in a settings file. A key in an environment variable takes precedence over a saved one. Each saved key is only sent to the address it was saved for: if a provider's address changes, for example through a repository's settings, Karst warns and sends no key until you save one for the new address.

## Working in a session

- **Keep typing while the agent works.** The line you type and a status line stay at the bottom, and output appears above them.
- **A message waits 3 seconds before it is sent.** Anything you send in that time joins it. `Enter` on an empty line sends at once, and `Esc` brings the message back to edit.
- **Sending a message while the agent works** stops that work and continues from your new message. **`/queue <message>`** waits its turn instead.
- **The status line** shows what is running and for how long, background agents and shell commands, queued messages, and the tokens used, such as `⠹ Working 12s · Esc to stop · 2 agents · 1 shell · 3 queued · 45k tokens`.
- **After each turn,** a line shows its cost, tokens and time next to the session's, such as `▸ Cost: turn $0.42 • session $3.17 | Tokens: turn 48k • session 1.2M | Time: 1m 20s`. Once the context passes 75% of the auto-compact point, a note after each turn suggests `/compact` before you continue.
- **The input sits between two rules,** and the right end of the status line shows the model and effort level. The terminal window is titled `Karst · <project folder>`.
- **A panel opens each session** with the model, directory and git branch, the session id, the permission mode, and the instruction files, MCP servers, skills and plugins loaded. `/clear` wipes the screen and shows it again for the new session.
- **Typing `/`** opens a menu of commands that narrows as you type. `↑` `↓` choose, `Enter` runs, `Tab` completes.
- **Permission prompts** list Yes, Yes and don't ask again, and No. `↑` `↓` and `Enter` choose, `y` `a` `n` answer at once, and `Tab` adds a note for the model to the highlighted answer. An approved prompt is taken off the screen; a refused one stays.
- **Thinking** shows in a few dimmed lines above the input while it streams, then folds to one line such as `✻ Thought for 12s`.
- **Long pastes** (more than 3 lines or 800 characters) show as `[Pasted text #1 +42 lines]` and go in full with the message.
- **Images:** `Cmd+V` on macOS, or `Ctrl+V` on Windows and Linux, pastes the image on the clipboard as `[Image #1]`, and image files dropped on the terminal are attached the same way. Delete the placeholder to leave the image out. In a terminal whose `Cmd+V` pastes only text, such as iTerm2 before 3.7, use `Ctrl+V`. On Linux this needs `wl-clipboard` (Wayland) or `xclip` (X11).
- **Keys:** `Esc` or `Ctrl+C` stops the running work. `Shift+Tab` changes the permission mode. `Alt+Enter`, or a line ending in `\`, starts a new line. Pasted text keeps its line breaks. `Ctrl+D` on an empty line quits.

| Command | What it does |
| --- | --- |
| `/help` | List the commands and keys |
| `/provider`, `/model`, `/effort` | Switch provider, model or reasoning effort |
| `/mode` | Show or change the permission mode |
| `/queue` | Run a message after the current work; `/queue` alone lists them, `/queue clear` empties it |
| `/plan` | Plan mode: the agent only reads, then asks you to approve a plan |
| `/rewind` | Undo file changes from the last turn, or the last N turns |
| `/compact` | Summarize the conversation to free up context |
| `/clear`, `/resume`, `/rename` | Start a new conversation on a clear screen, go back to an earlier one, or name this one. `/clear` and `/resume` stop the background work the old conversation left running |
| `/btw <question>` | Ask a side question without adding it to the conversation |
| `/loop [interval] [prompt]` | Run a prompt again and again: `/loop 5m check the deploy` on a schedule, `/loop check the deploy` at a pace the model picks, `/loop` alone for a default prompt that tends unfinished work and the branch's pull request. `Esc` stops a self-paced loop while it waits, and `/loop stop` stops them all |
| `/cost`, `/context`, `/status` | Tokens and estimated cost, how full the context is, session details |
| `/usage` | Tokens and estimated cost on a screen of their own, in tabs: this session, then per day, project and session, like `karst usage`. `←` `→` switch tabs and `Esc` goes back. `/usage daily`, `/usage projects` or `/usage sessions` opens on that tab |
| `/tasks`, `/todos` | Background commands, agents and scheduled jobs, any of which `/tasks stop <id>` stops; and the agent's checklist |
| `/mcp`, `/skills`, `/agents` | MCP servers, skills and agents in use |
| `/init` | Write a `KARST.md` with notes about this project |
| `/exit` | Quit |

## Permissions and safety

| Mode | Behavior |
| --- | --- |
| `default` | Asks before changing files or running commands that are not read-only |
| `acceptEdits` | Approves file changes, and `mkdir`, `touch`, `mv`, `cp`, inside the working directories |
| `plan` | Read-only, until you approve a plan |
| `dontAsk` | Refuses everything that would have asked |
| `bypassPermissions` | Never asks, except for ask rules and commands that delete important paths. Use it only in an isolated environment |

Choose one with `--permission-mode`, `Shift+Tab` or `/mode`. Rules go in settings:

```json
{
  "permissions": {
    "allow": ["Bash(npm test *)", "Edit(/src/**)"],
    "ask": ["Bash(git push *)"],
    "deny": ["Read(.env)", "Bash(curl *)"]
  }
}
```

- **Rules for shell commands are guardrails, not a security boundary.** For a boundary, turn on the sandbox with `"sandbox": { "enabled": true }` in settings, or `/sandbox on` from the next start. Commands the model runs then work under Seatbelt on macOS or bubblewrap on Linux: they can write only to the working directories and temporary directories, and have no network unless you list domains in `sandbox.network.allowedDomains`. Reads are still allowed almost everywhere, including `~/.ssh`, unless you add paths to `sandbox.filesystem.denyRead`.
- **A repository's own settings wait for trust.** Its hooks, allow rules, provider settings, MCP servers, skills, commands and agents take effect only after you trust the directory, at the prompt on startup, with `/trust`, or with `--trust` for one run.
- **Commands the model runs never see your API keys.** Every provider's key variable is removed from their environment, and saved keys are never put in an environment at all.

## Configuration

Settings are read from `~/.karst/settings.json`, then the project's workspace folder, then `.karst/settings.json` in the project, then `.karst/settings.local.json`, then `--settings`. Each overrides the one before.

What Karst saves for a project (approvals saved with "don't ask again", `-s local` providers and MCP servers, memory) goes in its workspace folder, `~/.karst/workspaces/<hash>/`, outside the repository; `karst doctor` shows which one. Karst does not create `.karst/` in a repository for settings: that folder is yours, and its files override the workspace folder.

```json
{
  "provider": "anthropic",
  "model": "claude-opus-5-5",
  "effort": "medium",
  "permissions": { "allow": ["Bash(npm test *)"], "defaultMode": "default" },
  "hooks": {
    "PreToolUse": [{ "matcher": "Bash", "hooks": [{ "type": "command", "command": ".karst/hooks/check.sh" }] }]
  },
  "env": { "NODE_ENV": "development" }
}
```

- **Project instructions:** `KARST.md` files, from `~/.karst/` and from the filesystem root down to the working directory. A directory without one uses `AGENTS.md` or `CLAUDE.md`. More instructions go in `.karst/rules/*.md`, optionally only for files matching some paths.
- **MCP servers:** `karst mcp add <name> <url>` for HTTP, or `karst mcp add <name> <command> -- <args>` for stdio, such as `karst mcp add github -e GITHUB_TOKEN=... npx -- -y some-mcp-server`. Then `karst mcp list`, and `karst mcp login <name>` for servers that use OAuth.
- **Skills:** Markdown instructions in `.karst/skills/<name>/SKILL.md` or `~/.karst/skills/<name>/SKILL.md`, run as `/<name>` or by the model when relevant. `.karst/commands/<name>.md` makes a simple command.
- **Agents:** subagents defined in `.karst/agents/<name>.md`, with their own prompt, tools and model.
- **Plugins:** bundles of skills, commands, agents, hooks and MCP servers. `karst plugin install ./toolkit`, or `--plugin-dir ./toolkit` for one run.
- **Hooks** run your commands at points such as `PreToolUse`, `PostToolUse`, `UserPromptSubmit`, `SessionStart` and `Stop`, and can block or adjust what happens.

## Scripting

```sh
karst -p "summarize the changes" --output-format json
karst -p "fix the failing test" --allowedTools "Edit,Bash(npm test *)" --max-turns 20
karst -p "list the TODOs" --json-schema schema.json
git diff | karst -p "review this" --output-format stream-json
```

With `-p`, nobody is there to answer a permission prompt, so anything that would ask is refused; pre-approve it with `--allowedTools` or a rule. `--max-budget-usd` stops when the estimated spend reaches a limit. `karst --help` lists every option.

## Try it without an API key

```sh
mkdir -p /tmp/play && cd /tmp/play
karst --provider scripted
```

Replies come from a built-in script instead of a model. Type `help` to see what it does, such as `run <command>`, `demo edit`, `demo ask` or `demo agent`. The tool calls are real, which is why this runs in a scratch directory. To write your own replies, set `KARST_SCRIPT` to a JSON file of rules that match what you type.

## Your data

Karst keeps its files in `~/.karst` (or `KARST_HOME`): settings, saved keys, session transcripts, file checkpoints and memory. Each transcript also records the tokens and estimated cost of every response, which `karst usage` totals per day, `karst usage projects` per project and `karst usage sessions` per session; add `--since`, `--until`, `--project <path>` or `--json`. Scheduled prompts are saved in the workspace folder too: a session's come back when you resume it, and those the model makes durable run in every later session of the project. `karst purge --dry-run` lists the workspace folder (settings, saved approvals, MCP servers, memory and scheduled jobs), transcripts, file history and logs stored for the current project, and `karst purge --yes` deletes them. The project's own files, `.karst/` included, are not touched.

## Versions

- **0.2.0:** Cairn is now **Karst**, because Cairn Code (github.com/cairn/cairn) is another terminal coding agent with the same `cairn` command, `~/.cairn` folder and `CAIRN.md` file. The package is `karst-code` and the command is `karst`: run `npm uninstall -g cairn-code && npm install -g karst-code`, then `karst migrate` to move your settings, saved keys, sessions and memory from `~/.cairn` to `~/.karst`. Karst does not read `~/.cairn`, `CAIRN_HOME`, `CAIRN.md`, `.cairn/` or `.cairn-plugin/`, and hooks get `KARST_*` variables instead of `CAIRN_*`, so rename these in your projects to `KARST.md`, `.karst/` and `.karst-plugin/`; `karst doctor` points out the ones it finds. Also new: `karst update` installs the latest version, and each session says when a newer one is on npm (`updateCheck` and `autoUpdates` in settings). `/loop` runs a prompt again and again, on a schedule or at a pace the model picks, and `/tasks` lists background agents and scheduled jobs too, any of which `/tasks stop <id>` stops. What Karst saves for a project (approvals, `-s local` providers and MCP servers, memory) goes in `~/.karst/workspaces/<hash>/`. Each session opens with a panel showing the model, directory, branch and what was loaded. Thinking streams in dimmed lines and then folds to one, long pastes show as `[Pasted text #1 +42 lines]`, an approved permission prompt is taken off the screen, and `Cmd+V` pastes images on macOS.
- **0.1.4:** `Ctrl+V` pastes an image from the clipboard on macOS and Linux, and image files dropped on the terminal are attached too, as `[Image #1]` placeholders. `/usage` opens a screen of its own with tabs for this session, days, projects and sessions, switched with `←` `→` and closed with `Esc`. Each turn ends with a line showing its cost, tokens and time next to the session's, and with a note to `/compact` once the context is nearly full. The input sits between two rules, the status line shows the model and effort level on the right, and the terminal window is titled after the project.
- **0.1.3:** each session now saves its tokens and estimated cost. `cairn usage` reports them per day, `cairn usage projects` per project and `cairn usage sessions` per session, also as `/usage` in a session, and after a resume `/cost` shows what the session spent over every run. This is also the first version on npm with the retries from 0.1.2.
- **0.1.2:** a failed model request is retried up to 10 times, waiting longer each time (from half a second up to 5 minutes), and a reply that breaks off partway is started over. Each retry is shown as it happens. Releases are now published from GitHub Actions, with npm provenance.
- **0.1.1:** this README, written for people installing Cairn. The program is the same as in 0.1.0.
- **0.1.0:** the first release.

Development and testing happen on macOS. On Linux the sandbox has not been tried yet, and it has no network proxy, so `allowedDomains` does not work there.

Karst's behavior follows Claude Code's public documentation, and its system prompt and tool descriptions are adapted from Claude Code's published system prompts.
