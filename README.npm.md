# Cairn

A coding agent for the terminal. Cairn reads and edits your code, runs commands and works through tasks with you, and asks before doing anything you have not allowed. It works with Anthropic, OpenAI, Ollama, or any server that speaks the Chat Completions API.

```sh
npm install -g cairn-code
export ANTHROPIC_API_KEY=...
cairn
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
npm install -g cairn-code     # installs the `cairn` command
npx cairn-code                # or try it without installing
```

**In a repository you do not trust, run the installed `cairn`, not `npx cairn-code`.** npx prefers a copy of the package from the project's own `node_modules`, so the repository could supply its own.

## Quick start

```sh
cd your-project
cairn                                # interactive session
cairn -p "explain this repo"         # answer once and exit
cat log.txt | cairn -p "find bugs"   # also reads standard input
cairn -c                             # continue the latest session in this directory
cairn -r <id or name>                # resume an earlier session
cairn usage                          # tokens and estimated cost per day; also: projects, sessions
cairn doctor                         # check the installation
```

Cairn uses an Anthropic API key from the [Console](https://platform.claude.com), or `ANTHROPIC_AUTH_TOKEN`. Instead of exporting it each time, you can save it once with `cairn provider key anthropic`. Cairn does not use a Claude Code login or subscription.

## Choosing a provider and model

| Provider | Needs | Default model |
| --- | --- | --- |
| `anthropic` | `ANTHROPIC_API_KEY`, or a saved key | `claude-opus-5-5` |
| `openai` | `OPENAI_API_KEY`, or a saved key | `gpt-6-astra` |
| `ollama` | Ollama on this machine, or `OLLAMA_HOST` | `qwen3-coder:30b` |
| one you add | `cairn provider add` | the one you choose |

```sh
cairn --provider openai --model gpt-6.1-sol
cairn provider add deepseek --type openai-chat --base-url https://api.deepseek.com/v1 --model deepseek-chat
cairn provider list                  # every provider, its model, and where its key comes from
cairn provider use deepseek          # the default for new sessions
cairn provider remove deepseek
```

`cairn provider add` asks for the key without showing it. Without `--type`, it also asks for the type, the base URL and the model. The types are `anthropic`, `openai`, `openai-chat` (Chat Completions) and `ollama`.

In a session, `/provider` opens a list of providers: type to narrow it, use `↑` `↓` and `Enter` to choose, or pick "Add a provider…". `/model` lists the current provider's models; for Ollama and Chat Completions servers, the list comes from the server. The conversation carries on with the new provider, and new sessions start with your last choice.

**Keys** are saved in `~/.cairn/credentials.json`, which only you can read, and never in a settings file. A key in an environment variable takes precedence over a saved one. Each saved key is only sent to the address it was saved for: if a provider's address changes, for example through a repository's settings, Cairn warns and sends no key until you save one for the new address.

## Working in a session

- **Keep typing while the agent works.** The line you type and a status line stay at the bottom, and output appears above them.
- **A message waits 3 seconds before it is sent.** Anything you send in that time joins it. `Enter` on an empty line sends at once, and `Esc` brings the message back to edit.
- **Sending a message while the agent works** stops that work and continues from your new message. **`/queue <message>`** waits its turn instead.
- **The status line** shows what is running and for how long, background agents and shell commands, queued messages, and the tokens used, such as `⠹ Working 12s · Esc to stop · 2 agents · 1 shell · 3 queued · 45k tokens`.
- **Typing `/`** opens a menu of commands that narrows as you type. `↑` `↓` choose, `Enter` runs, `Tab` completes.
- **Permission prompts** list Yes, Yes and don't ask again, and No. `↑` `↓` and `Enter` choose, `y` `a` `n` answer at once, and `Tab` adds a note for the model to the highlighted answer.
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
| `/clear`, `/resume`, `/rename` | Start a new conversation, go back to an earlier one, or name this one |
| `/btw <question>` | Ask a side question without adding it to the conversation |
| `/cost`, `/context`, `/status` | Tokens and estimated cost, how full the context is, session details |
| `/usage daily`, `/usage projects`, `/usage sessions` | Saved tokens and estimated cost per day, project or session, like `cairn usage` |
| `/tasks`, `/todos` | Background commands, and the agent's checklist |
| `/mcp`, `/skills`, `/agents` | MCP servers, skills and agents in use |
| `/init` | Write a `CAIRN.md` with notes about this project |
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

Settings are read from `~/.cairn/settings.json`, then `.cairn/settings.json` in the project, then `.cairn/settings.local.json`, then `--settings`.

```json
{
  "provider": "anthropic",
  "model": "claude-opus-5-5",
  "effort": "medium",
  "permissions": { "allow": ["Bash(npm test *)"], "defaultMode": "default" },
  "hooks": {
    "PreToolUse": [{ "matcher": "Bash", "hooks": [{ "type": "command", "command": ".cairn/hooks/check.sh" }] }]
  },
  "env": { "NODE_ENV": "development" }
}
```

- **Project instructions:** `CAIRN.md` files, from `~/.cairn/` and from the filesystem root down to the working directory. A directory without one uses `AGENTS.md` or `CLAUDE.md`. More instructions go in `.cairn/rules/*.md`, optionally only for files matching some paths.
- **MCP servers:** `cairn mcp add <name> <url>` for HTTP, or `cairn mcp add <name> <command> -- <args>` for stdio, such as `cairn mcp add github -e GITHUB_TOKEN=... npx -- -y some-mcp-server`. Then `cairn mcp list`, and `cairn mcp login <name>` for servers that use OAuth.
- **Skills:** Markdown instructions in `.cairn/skills/<name>/SKILL.md` or `~/.cairn/skills/<name>/SKILL.md`, run as `/<name>` or by the model when relevant. `.cairn/commands/<name>.md` makes a simple command.
- **Agents:** subagents defined in `.cairn/agents/<name>.md`, with their own prompt, tools and model.
- **Plugins:** bundles of skills, commands, agents, hooks and MCP servers. `cairn plugin install ./toolkit`, or `--plugin-dir ./toolkit` for one run.
- **Hooks** run your commands at points such as `PreToolUse`, `PostToolUse`, `UserPromptSubmit`, `SessionStart` and `Stop`, and can block or adjust what happens.

## Scripting

```sh
cairn -p "summarize the changes" --output-format json
cairn -p "fix the failing test" --allowedTools "Edit,Bash(npm test *)" --max-turns 20
cairn -p "list the TODOs" --json-schema schema.json
git diff | cairn -p "review this" --output-format stream-json
```

With `-p`, nobody is there to answer a permission prompt, so anything that would ask is refused; pre-approve it with `--allowedTools` or a rule. `--max-budget-usd` stops when the estimated spend reaches a limit. `cairn --help` lists every option.

## Try it without an API key

```sh
mkdir -p /tmp/play && cd /tmp/play
cairn --provider scripted
```

Replies come from a built-in script instead of a model. Type `help` to see what it does, such as `run <command>`, `demo edit`, `demo ask` or `demo agent`. The tool calls are real, which is why this runs in a scratch directory. To write your own replies, set `CAIRN_SCRIPT` to a JSON file of rules that match what you type.

## Your data

Cairn keeps its files in `~/.cairn` (or `CAIRN_HOME`): settings, saved keys, session transcripts, file checkpoints and memory. Each transcript also records the tokens and estimated cost of every response, which `cairn usage` totals per day, `cairn usage projects` per project and `cairn usage sessions` per session; add `--since`, `--until`, `--project <path>` or `--json`. `cairn purge --dry-run` lists the transcripts, file history and logs stored for the current project, and `cairn purge --yes` deletes them. The project's own files are not touched.

## Versions

- **0.1.3:** each session now saves its tokens and estimated cost. `cairn usage` reports them per day, `cairn usage projects` per project and `cairn usage sessions` per session, also as `/usage` in a session, and after a resume `/cost` shows what the session spent over every run. This is also the first version on npm with the retries from 0.1.2.
- **0.1.2:** a failed model request is retried up to 10 times, waiting longer each time (from half a second up to 5 minutes), and a reply that breaks off partway is started over. Each retry is shown as it happens. Releases are now published from GitHub Actions, with npm provenance.
- **0.1.1:** this README, written for people installing Cairn. The program is the same as in 0.1.0.
- **0.1.0:** the first release.

Development and testing happen on macOS. On Linux the sandbox has not been tried yet, and it has no network proxy, so `allowedDomains` does not work there.

Cairn's behavior follows Claude Code's public documentation, and its system prompt and tool descriptions are adapted from Claude Code's published system prompts.
