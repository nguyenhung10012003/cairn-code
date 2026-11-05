# Cairn

[![CI](https://github.com/nguyenhung10012003/cairn-code/actions/workflows/ci.yml/badge.svg)](https://github.com/nguyenhung10012003/cairn-code/actions/workflows/ci.yml)

A coding agent for the terminal. It reads and edits code, runs commands and works through tasks with you, and asks before doing anything you have not allowed.

- **Models:** Anthropic (the default), OpenAI, Ollama, and any server that speaks Chat Completions, such as DeepSeek, Groq, OpenRouter, LM Studio or vLLM. `/provider` and `/model` switch during a session. Keys are saved per provider, and each key is only sent to the address it was saved for.
- **Tools:** reading, writing and editing files, search, shell commands that can run in the background, web fetch and search, notebooks, images and PDFs, a task checklist, plan mode, git worktrees, scheduled prompts, and subagents that work in the background.
- **Safety:** permission rules and modes, approval prompts answered with the arrow keys (with an optional note for the model), an operating-system sandbox (Seatbelt on macOS, bubblewrap on Linux) with a network proxy, and workspace trust for project settings.
- **Extending:** MCP servers (stdio, HTTP, SSE, with OAuth sign-in), skills, custom commands and agents, hooks, and plugins.
- **Sessions:** saved transcripts to resume, fork and rename, file checkpoints undone with `/rewind`, automatic compaction, and memory across sessions.
- **Interactive terminal:** you can type while the agent works. A message waits 3 seconds so you can add to it, `/queue` runs messages in turn, a status line shows what is running, and typing `/` opens a command menu that filters as you type.
- **Scripting:** `-p` print mode with text, JSON or stream-JSON output, answers that follow a JSON Schema, and a mock provider for trying everything without an API key.

Its behavior follows Claude Code's public documentation. Its system prompt and tool descriptions are adapted from Claude Code's published system prompts, with product names, paths and features changed to Cairn's.

## Install

Requires [Node.js](https://nodejs.org) 22 or later.

```sh
npm install -g cairn-code      # installs the `cairn` command
export ANTHROPIC_API_KEY=...   # from platform.claude.com
cairn
```

To try it without installing, run `npx cairn-code`.

**In repositories you do not trust, run the installed `cairn` rather than `npx cairn-code`.** npx prefers a copy of the package from the current project's `node_modules`, so the repository could supply its own.

Create a key in the Anthropic Console. Cairn uses an API key or `ANTHROPIC_AUTH_TOKEN`, from the environment or saved with `cairn provider key anthropic`. It does not reuse a Claude Code login or subscription. For OpenAI, DeepSeek, Groq, OpenRouter or a local model, see Providers.

### From source

Requires [Bun](https://bun.sh) 1.3 or later.

```sh
bun install
bun test --timeout 60000
bun run start                  # run straight from TypeScript
bun run build:npm && npm link  # build dist/npm/, the package npm ships, and link the `cairn` command
bun run build                  # or build dist/cairn, a single executable with Bun inside
```

**From source, use `bun run start` or a build in repositories you do not trust.** Plain `bun` reads `.env` and `bunfig.toml` from the current directory, so a repository could change `ANTHROPIC_BASE_URL` to capture your key, or run code through `preload` before any trust check. `dist/cairn`, `bun run start` and the shebang in `src/cli.ts` all turn both of these off; typing `bun src/cli.ts` by hand does not. Node reads neither file, so `dist/npm/cli.js` is not affected.

### Publishing to npm

What npm receives is the directory `dist/npm/`, which `bun run build:npm` writes from scratch each time:

- `cli.js`, the Node bundle;
- `package.json`, with only the fields an install needs: no scripts and no development dependencies;
- `README.md`, a copy of `README.npm.md`.

`README.npm.md` is the page people see on npm, so it is written for installing and using Cairn. This file is for working on Cairn. The `package.json` in the repository is marked private, so a plain `npm publish` here fails instead of uploading the wrong thing.

npm never accepts the same version twice, so raise the version for each release. `build:npm` stops if the version in `package.json` differs from `VERSION` in `src/config/paths.ts`, so change both together.

**Releasing from GitHub Actions.** Pushing a tag `vX.Y.Z` runs `.github/workflows/release.yml`:

1. the whole CI workflow on the tagged commit;
2. a check that the tag matches `package.json`, then `build:npm` and `npm pack`, once;
3. `npm publish` of that tarball through npm trusted publishing, so npm also records provenance;
4. a GitHub release with the same tarball. Its notes are the `- **X.Y.Z:**` line from the Versions section of `README.npm.md`, followed by GitHub's list of changes.

```sh
# after setting the version in package.json and src/config/paths.ts, and adding its line to README.npm.md
git commit -am "Release 0.1.2"
git tag v0.1.2
git push origin main v0.1.2
```

A job that failed can be re-run: a version already on npm, or a release already on GitHub, is left as it is.

The workflow holds no npm token. It needs a one-time setup on npmjs.com: in the package's **Settings > Trusted publishing**, add GitHub Actions with user `nguyenhung10012003`, repository `cairn-code`, workflow `release.yml` and no environment, and allow `npm publish`. A new trusted publisher must be used within 2 days of being added, or it expires.

**Releasing by hand** still works:

```sh
bun run build:npm && npm pack ./dist/npm --dry-run   # what would be uploaded
npm login
bun run release                # typecheck, tests, build:npm, then npm publish ./dist/npm
bun run release:stage          # the same, but staged: approve it with 2FA via `npm stage approve <id>` or on npmjs.com
```

## Usage

```sh
cairn                               # interactive session
cairn -p "explain this repo"        # run once and exit
cat log.txt | cairn -p "find bugs"  # also read from stdin
cairn -c                            # continue the most recent session
cairn --model claude-sonnet-5-5     # pick a model
cairn --effort high                 # low, medium (default), high, xhigh, max
cairn -p "..." --output-format json
cairn -w feature-x                  # work in a separate git worktree
cairn -n refactor                   # name the session; later, cairn -r refactor
cairn --agent reviewer              # run the whole session as one agent
cairn --plugin-dir ./toolkit        # load a plugin for this run
cairn doctor                        # check the installation
cairn usage                         # tokens and estimated cost per day; also: projects, sessions
cairn update                        # install the latest version
cairn purge --dry-run               # show the data stored for this project
```

**Updates:** each interactive session asks npm for the latest version as it starts, in the background, and prints a line such as `Cairn 0.1.5 is available (you have 0.1.4). Run cairn update to install it.` It says nothing when there is no newer version or npm cannot be reached, and it is skipped with `-p` and when `CI` is set. `cairn update` installs the new version with the package manager Cairn was installed with: `npm install -g`, `bun add -g`, `pnpm add -g` or `yarn global add`. A copy run from source, a standalone binary, an `npx` run or a project's dependency is not updated in place; the message says what to do instead. In the user settings (`~/.cairn/settings.json`), `"updateCheck": false` turns the check off, and `"autoUpdates": true` installs a newer version in the background as a session starts, logged to `~/.cairn/update.log`. The new version runs from the next start. Neither setting is read from a project's settings.

**Flags for scripts (`-p`):** `--input-format stream-json` (one message per line), `--include-partial-messages`, `--replay-user-messages`, `--include-hook-events`, `--json-schema`, `--max-budget-usd`, `--fallback-model`, `--permission-prompt-tool`, `--verbose`. `stream-json` emits `system`, `assistant`, `user` and `result` events, plus `stream_event` when asked.

**Minimal modes:** `--bare` skips hooks, installed plugins, and the discovery of instructions and skills. `--safe-mode` turns off every customization, to troubleshoot a broken configuration. `--restricted` removes the tools that run code and reads no settings files. Others: `--setting-sources`, `--disable-slash-commands`, `--autocompact`, `--betas`, `--debug`, `--debug-file`, `--allow-dangerously-skip-permissions`.

In an interactive session: `Esc` or `Ctrl+C` interrupts the running turn, `Shift+Tab` cycles the permission mode, ending a line with `\` continues it on the next line, `/help` lists commands, `/cost` shows tokens and estimated cost, and `/usage` shows them in tabs.

**Usage reports:** the tokens and estimated cost of each model response, and of each subagent run, are saved in the session's transcript. `cairn usage` totals them per day, `cairn usage projects` per project, and `cairn usage sessions` per session. `--project <path>`, `--since` and `--until` (`YYYY-MM-DD`, local time, both days included) narrow a report, and `--json` prints JSON with every token count. In a session, `/usage` opens a screen of its own with four tabs: This session (the default, the same figures as `/cost`), Daily, Projects and Sessions. `←` `→` (or `Tab`, or `1` to `4`) switch tabs, `↑` `↓`, `PgUp` `PgDn`, `Home` and `End` scroll, and `Esc` or `q` goes back to the conversation. The agent keeps working meanwhile: what it prints appears when you go back, and a permission prompt waits for you, with a note in the view that it is waiting. `/usage daily`, `/usage projects` and `/usage sessions` open on that tab, `--project`, `--since` and `--until` narrow the report tabs, and `--json` prints the report instead. After a resume `/cost` also shows what the session has spent over every run. Costs are estimates at list prices, and a `+` marks a total that includes a model with no known price. Sessions saved before this feature, and sessions run with `--no-session-persistence`, have nothing recorded and are not counted. `cairn purge` deletes a project's figures along with its transcripts.

**Typing while the agent works:** the line you type, between two rules, and a status line stay at the bottom, and output appears above them, so you can keep typing at any time. The terminal's window or tab is titled `Cairn · <project folder>` while the session runs.

- **A message waits 3 seconds before it is sent,** shown above the prompt. Anything else you send in that time joins it, so the two go out as one message. `Enter` on an empty line sends it at once, and `Esc` puts it back on the line to edit.
- **Sending a message while the agent works stops that work** and continues the conversation from your new message. What the agent had already written and done stays in the conversation.
- **`/queue <message>` waits its turn instead:** queued messages run in order once the current work is done. `/queue` lists them and `/queue clear` empties the queue. A slash command can be queued too, such as `/queue /compact`.
- **Commands while the agent works:** commands that leave the work alone, such as `/cost`, `/status`, `/tasks`, `/todos`, `/queue`, `/btw` and `/mode`, run at once. The others, such as `/compact`, `/model` or `/clear`, say to wait, stop the work with `Esc`, or queue them.
- **The status line** shows what is running and for how long, then the background agents, shell commands and monitors still running, how many messages are queued, and the tokens used in the session. A typical one reads `⠹ Working 12s · Esc to stop · 2 agents · 1 shell · 3 queued · 45k tokens`. Its right end shows the model and effort level, such as `claude-opus-5-5 · effort high`, and is left out on a narrow terminal.
- **After each turn,** a line sums up what it spent and how long it took, such as `▸ Cost: turn $0.42 • session $3.17 | Tokens: turn 48k • session 1.2M | Time: 1m 20s`. The turn's figures include its subagents, compaction, and anything else that ran in the background meanwhile; the session's are everything since Cairn started. A `+` marks a cost that includes a model with no known price, and the cost is left out when no model used so far has one.
- **When the context is nearly full,** at 75% of the point where it is compacted automatically (60% of the window by default, or of the `/autocompact` setting), each turn ends with a note to run `/compact` before you continue, such as `! Context is 64% full (128k of 200k tokens). Consider /compact before you continue. Otherwise it is compacted on its own past 160k.`
- **Editing:** `←` `→`, `Home` `End`, `Ctrl+A` `Ctrl+E`, word moves with `Alt+←` `Alt+→`, `Ctrl+U` `Ctrl+K` `Ctrl+W`, and `↑` `↓` for earlier messages. Pasted text keeps its line breaks, and `Alt+Enter` or a line ending in `\` starts a new line. `Ctrl+C` clears the line, or stops the work when the line is empty. `Ctrl+D` on an empty line quits.
- **Images:** `Ctrl+V` pastes the image on the clipboard (`Cmd+V` and `Ctrl+Shift+V` paste text only, because terminals do). It appears on the line as a placeholder such as `[Image #1]`, and the message takes the images whose placeholders it still has when it is sent, ahead of its text. `Backspace` deletes a placeholder whole. Dropping image files on the terminal attaches them the same way: a paste made only of absolute paths, `~/` paths or `file://` URLs to PNG, JPEG, GIF or WebP files becomes placeholders, and any other paste stays text. A file copied in Finder or a Linux file manager can be pasted with `Ctrl+V` too. An image over the API's 5 MB limit is shrunk to a JPEG, as `Read` does. The clipboard is read with `osascript` on macOS, and with `wl-paste` (wl-clipboard) on Wayland or `xclip` on X11 on Linux; on Linux, shrinking needs ImageMagick. Images are saved in the transcript, so a resumed session still has them; compaction keeps only a note that there was one.

**Permission prompts** list the answers: Yes; Yes, and don't ask again (when a rule can cover the call); and No. `Up` and `Down` choose and `Enter` confirms; `1` to `3`, `y`, `a` and `n` answer at once; `Esc` answers No. `Tab` adds a note to the highlighted answer, and `Enter` sends both. A note with No tells the model what to do instead. A note with Yes reaches the model together with the call's result. Without a terminal, such as when input is piped, the answer is typed instead.

**Command menu:** typing `/` lists the commands, skills and MCP prompts under the prompt, and the list narrows as you type. It matches names first: the start of a name, then any part of it, then its letters in order (`/cmp` finds `/compact`). From three letters on, it also matches words in descriptions, so `/undo` finds `/rewind`. `Up` and `Down` choose, `Enter` runs the highlighted command, `Tab` puts it on the line so you can add arguments, and `Esc` closes the list. While the list is closed, `Up` and `Down` go through history as before.

## Providers

The built-in providers are `anthropic` (the default, with `claude-opus-5-5`), `openai`, `ollama` and `scripted` (mock replies). You can add more under names of your own, and switch between them during a session.

**In a session:** `/provider` opens a list of providers. Type to narrow it, use ↑↓ and Enter to choose, or pick "Add a provider…". If the chosen provider has no key, Cairn asks for one and saves it. `/model` lists the current provider's models; the list comes from the server for `ollama` and `openai-chat`. You can also type a model name that is not in the list. `/provider <name> [model]` and `/model <name>` switch directly. The conversation continues on the new provider, and new sessions start with your last choice. `/provider key <name>` saves or replaces a key, and `/provider remove <name>` removes a provider.

**From a shell:**

```sh
cairn provider add deepseek --type openai-chat --base-url https://api.deepseek.com/v1 --model deepseek-chat
                                    # asks for the key without showing it, and saves it
cairn provider list                 # every provider, its model, and where its key comes from
cairn provider key openai           # save or replace a key; --stdin to pipe it in, --delete to remove it
cairn provider use deepseek         # the default for new sessions
cairn --provider deepseek           # or just for this run
cairn provider remove deepseek      # removes its settings and its saved key
```

Without `--type`, `add` asks for the type, then for the base URL, the key and the model.

**Keys** are saved in `~/.cairn/credentials.json`, which only you can read (mode 0600). They never go in a settings file. A variable takes precedence over a saved key: `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `OLLAMA_API_KEY`, or the one named by `apiKeyEnv`. Each key is saved together with the address it was entered for, and is only sent there. If the provider's `baseUrl` changes, through your settings, a project's settings or a variable such as `OPENAI_BASE_URL`, Cairn warns and sends no key until you save one for the new address. This stops a repository from redirecting a provider name to its own server to collect your key. Before saving a key for a plain `http://` address on another machine, Cairn warns that the key would cross the network unencrypted.

**Settings:** a provider added with `cairn provider add` or `/provider add` is written to `~/.cairn/settings.json`, or with `-s project` or `-s local` to this project's files:

```json
{
  "provider": "deepseek",
  "model": "deepseek-chat",
  "providers": {
    "deepseek": { "type": "openai-chat", "baseUrl": "https://api.deepseek.com/v1", "model": "deepseek-chat" },
    "anthropic": { "baseUrl": "https://gateway.example.com", "apiKeyEnv": "MY_GATEWAY_KEY" }
  }
}
```

`model` at the top level goes with `provider` at the top level. With `--provider` set to another provider, that provider's own `model`, or its built-in default, is used instead.

| Option | Meaning |
| --- | --- |
| `type` | The API a provider added under its own name speaks: `anthropic`, `openai`, `openai-chat` or `ollama`. The built-in names always speak their own |
| `model` | The model to use with this provider |
| `baseUrl` | Where its API is. For `anthropic`, `ANTHROPIC_BASE_URL` does the same |
| `apiKeyEnv` | Read the key from this variable |
| `fullApiFeatures` | `anthropic`: use the API extras even through a `baseUrl`. Set this only if the upstream really is the API |
| `maxRetries` | Retries on 429, 5xx, connection errors and a stream that fails partway, which starts the response over. Each wait doubles from 0.5s, or is what the server asks for, and is never more than 5 minutes. Default 10 |
| `contextWindow` | Tokens of context. Ollama loads the model with exactly this many; for other providers it sets when to compact for a model they do not know |
| `maxOutputTokens` | `openai-chat`: the most tokens to ask for in a response. Unset, the server decides |

### Chat Completions (`openai-chat`)

For any server that speaks OpenAI's Chat Completions API, such as DeepSeek, Groq, OpenRouter, Together, Mistral, LM Studio, vLLM or llama.cpp:

```sh
cairn provider add groq --type openai-chat --base-url https://api.groq.com/openai/v1
cairn provider add lmstudio --type openai-chat --base-url http://localhost:1234/v1 --no-key
```

- **Parameters a server rejects** (`parallel_tool_calls`, `reasoning_effort`, `stream_options`, `response_format`, or `max_tokens` where it wants `max_completion_tokens`) are dropped for that model, and the request is sent again.
- **Reasoning** that a server streams (`reasoning_content` or `reasoning`) is shown as thinking. It is not sent back in the history, because few servers accept it there.
- **Images** from a tool go in a following user message. PDFs cannot be sent.
- **Not yet supported:** prices, so `/cost` shows tokens only, and web search.

### OpenAI

```sh
export OPENAI_API_KEY=...                          # from platform.openai.com
cairn --provider openai                            # default gpt-6-astra
cairn --provider openai --model gpt-6.1-sol        # cheaper; gpt-6-luna is cheapest
```

Cairn uses the Responses API without server-side storage (`store: false`). Each request sends the whole history, and reasoning is carried across turns as the encrypted reasoning items the API returns, sent back unchanged. `--effort` becomes `reasoning.effort`. A model that rejects that parameter is asked again without it. `OPENAI_BASE_URL` or `providers.openai.baseUrl` points at another endpoint that serves the Responses API. `OPENAI_ORG_ID` and `OPENAI_PROJECT_ID` are sent when set.

- **Compaction happens before the real window fills.** GPT-6 models accept 1,050,000 tokens, but a request over 272K tokens is billed at twice the input rate for the whole request, so Cairn compacts before that point. Use `/autocompact` to change it.
- **Not yet supported:** OpenAI's web search, tool search, and prices for models other than gpt-6-astra, gpt-6.1-sol and gpt-6-luna. For those, `/cost` is only a lower bound.

### Ollama

```sh
ollama pull qwen3-coder:30b                        # or any model with tool support
cairn --provider ollama                            # default qwen3-coder:30b
cairn --provider ollama --model gpt-oss:20b
```

Cairn uses Ollama's native `/api/chat` API, not its OpenAI-compatible endpoint, because only the native API takes `num_ctx`. Through the compatible endpoint, the model runs with Ollama's default context (often 4,096 tokens) and silently drops the start of the prompt, while Cairn's system prompt and tool definitions alone take about 14,000 tokens.

- **Context:** 65,536 tokens by default, set with `providers.ollama.contextWindow`. A larger context uses more RAM and VRAM; too small, and the model has no room for the tools and the conversation.
- **Address:** `OLLAMA_HOST` or `providers.ollama.baseUrl`, default `http://localhost:11434`. For a remote Ollama that needs a key, set `OLLAMA_API_KEY`.
- **The model must support tool calling** ([list](https://ollama.com/search?c=tools)). A model without it gives a clear error, and a model that is not pulled yet gives the `ollama pull` command.
- **Thinking** is sent only with `--effort`, as a level (`low`, `medium`, `high`, `max`). A model that only takes true or false is asked again with `true`, then without thinking.
- **Images** from a tool go in a following user message, because Ollama takes images on messages, not on tool results. PDFs cannot be sent. Cost counts as zero when Ollama runs on this machine.

### Models for subagents

The Agent tool's `model` parameter takes `opus`, `sonnet`, `haiku` or `fable`. Each provider maps these its own way: on Anthropic, the newest Claude model of each line; on OpenAI, `gpt-6-astra` (`opus`, `fable`), `gpt-6.1-sol` (`sonnet`) and `gpt-6-luna` (`haiku`). A provider with no mapping, such as Ollama, uses the main session's model. Automatic session titles use the provider's `haiku` model when it has one.

**Supporting another API:** a server that speaks one of the four APIs above needs only `cairn provider add`. For a different API, write a class implementing `ModelProvider` in `src/providers/`, translating between that API's format and the neutral types in `src/core/messages.ts`. Then add an entry to `PROVIDER_TYPES` in `src/providers/index.ts` that says how to create it, where its requests go, and which variables hold its key. `src/providers/http.ts` has a JSON POST and readers for SSE and NDJSON, and `src/providers/retry.ts` has `withRetries`, which retries a whole response on a `ProviderError` marked `retryable`. The agent loop, tools, UI and `cairn provider` need no changes.

### API features in use (Anthropic)

| Feature | Notes |
| --- | --- |
| Prompt caching | Lowers the cost of rereading the start of the conversation |
| Web search | Runs on the server, at most 5 searches per request, billed at $10 per 1,000 searches |
| Refusal fallback | When the model declines because of a safety filter, the API switches to another model and Cairn tells you. Available on Opus 5.5, Opus 5, Sonnet 5.5 and Fable 5.1 |
| Thinking summaries | Shown dimmed in the terminal |
| USD cost | `/cost` and `total_cost_usd` are estimates from list prices; the Console shows what you are actually billed |

Through a custom `baseUrl`, Cairn sends only what any gateway should accept: web search, fallback, eager streaming and automatic caching are off unless `fullApiFeatures` is set.

**About web search:** it runs on the server, so Cairn cannot ask you before each search. Malicious content in a file could lead the model to put data into a search query. When working with sensitive data, turn it off with the rule `"deny": ["WebSearch"]`.

**About keys:** Cairn removes every provider's key variable (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `OLLAMA_API_KEY`, each `apiKeyEnv` and related credential variables) from the environment of the commands the model runs, so `env` cannot leak a key into the transcript. It removes them all, not just the active provider's, because the session can switch providers. A program in the repository that needs one of those keys will not see it when run through Cairn. Hooks you configure still see them. Saved keys are never put in any environment.

## MCP

Connect tools from MCP servers over stdio, Streamable HTTP or SSE.

```sh
cairn mcp add github -e GITHUB_TOKEN=... npx -- -y some-mcp-server    # stdio; the server's flags go after --
cairn mcp add notion https://mcp.notion.com/mcp                       # HTTP, detected from the URL
cairn mcp add -s project -H "Authorization: Bearer \${MY_TOKEN}" api https://api.example.com/mcp
cairn mcp login notion      # OAuth sign-in through the browser
cairn mcp list              # show status and test connections
cairn mcp get github        # env and header values are hidden
cairn mcp remove github
```

| Scope | Stored in | For |
| --- | --- | --- |
| `local` (default) | `~/.cairn/projects/<project>/mcp.json` | Only you, only this project. Outside the repository, so a token cannot be committed by mistake |
| `project` | `.mcp.json` at the repository root | Shared with the team through git. Use `${VAR}` instead of writing tokens |
| `user` | `~/.cairn/mcp.json` | Only you, every project |

Precedence: `--mcp-config`, then local, project, user. A single run can use `--mcp-config <file-or-json>`, and `--strict-mcp-config` to ignore every other configuration.

```json
{
  "mcpServers": {
    "fs": { "command": "npx", "args": ["-y", "my-server"], "env": { "KEY": "${MY_KEY}" }, "timeout": 60000 },
    "api": {
      "url": "${API_URL:-https://api.example.com}/mcp",
      "headers": { "Authorization": "Bearer ${API_TOKEN}" },
      "oauth": { "clientId": "...", "scopes": "read write", "callbackPort": 8080 }
    },
    "off": { "command": "x", "disabled": true }
  }
}
```

**In a session:** `/mcp` shows status; also `/mcp reconnect <name|all>`, `/mcp login <name>`, `/mcp logout <name>`. A server's prompts run as `/mcp__<server>__<prompt> arguments`. Resources can be read with `ListMcpResourcesTool` and `ReadMcpResourceTool`.

**Permissions:** MCP tools always ask first unless a rule says otherwise. Valid rules: `mcp__github__create_issue` (one tool), `mcp__github` or `mcp__github__*` (the whole server), `mcp__*` (deny and ask only). A server's own `readOnlyHint` can never skip a prompt; in plan mode, tools not declared read-only are refused.

**Worth knowing:**

- A repository's `.mcp.json` can run any command, so it takes effect only after you trust the directory, including with `-p`. Trust covers the whole directory, not each server.
- Stdio servers get only a minimal environment (`PATH`, `HOME`, ...) plus what their configuration names, so they do not see your API keys. `${ANTHROPIC_API_KEY}` and other credential variables read as empty in a remote server's `url` and `headers`.
- The tool list is fixed for a conversation. When a server reports changed tools, Cairn only says so; `/mcp reconnect` loads them, because changing them mid-conversation would lose the cache and earlier thinking.
- With 10 or more MCP tools, their definitions load on demand through the API's tool search. Through a custom `baseUrl`, all of them are sent in full.
- OAuth tokens are kept in `~/.cairn/mcp-auth/` with mode 0600, not in the Keychain.
- A server's stderr is logged to `~/.cairn/mcp-logs/<name>.log`. Set the connection timeout with `MCP_TIMEOUT` and the tool timeout with `MCP_TOOL_TIMEOUT` or the server's `timeout`, in milliseconds.
- Images and audio from tools are not yet passed to the model; Cairn says they were there but cannot be shown.

## Skills

A skill is Markdown instructions loaded when needed. The model sees only its name and description until it uses one.

```
.cairn/skills/review/SKILL.md     # project skill; needs the directory to be trusted
~/.cairn/skills/review/SKILL.md   # personal skill; takes precedence over the project's
.cairn/commands/deploy.md         # simple form, creates /deploy; subdirectories become /a:b
```

```markdown
---
description: Review uncommitted changes and point out risks
argument-hint: [file]
allowed-tools: Bash(git diff *) Read
---
## Current changes
!`git diff HEAD`

Review $ARGUMENTS. Reference file: ${CAIRN_SKILL_DIR}/checklist.md
```

| Field | Meaning |
| --- | --- |
| `name`, `description`, `when_to_use`, `argument-hint` | Command name and description |
| `disable-model-invocation: true` | Only you can run it. Use this for anything with side effects, such as deploying |
| `user-invocable: false` | Only the model can run it |
| `allowed-tools`, `disallowed-tools` | Pre-approve or block tools, **only for the turn the skill runs in** |
| `model`, `effort` | Change these for the rest of that turn |
| `context: fork`, `agent` | Run in a subagent; only the report comes back |
| `arguments` | Names for positional arguments, usable as `$name` |
| `paths` | Glob patterns: the model learns of the skill only when working with matching files |
| `hooks` | Hooks registered when the skill runs, kept for the rest of the session; `once: true` runs one only once |

**Sources:** the current directory and its parents up to the repository root, `~/.cairn/skills`, directories from `--add-dir` or `/add-dir` (a clashing name becomes `/dir:name`), subdirectories once the model reaches them (`/apps/web:deploy`), and plugins (`/plugin:name`). Skills added or removed during a session are reported to the model on its next turn; `/reload-skills` checks right away.

**Substitutions:** `$ARGUMENTS`, `$0`, `$1`, `$ARGUMENTS[0]`, `$name`, `${CAIRN_SKILL_DIR}`, `${CAIRN_PROJECT_DIR}`, `${CAIRN_SESSION_ID}`, `${CAIRN_EFFORT}`. Write `\$1` for a literal dollar sign. If a skill has no place for arguments, Cairn appends `ARGUMENTS: ...`.

**Injected commands** `` !`command` `` and ```` ```! ```` blocks run before the model sees the skill, without asking anyone. Each command must already be allowed, by a rule or by `allowed-tools`; otherwise the whole skill stops. Arguments are never scanned for injected commands.

**Permissions:** a skill that only adds text loads freely. A skill with injected commands, `allowed-tools`, `hooks` or `context: fork` asks first. Rules: `Skill(deploy)`, `Skill(deploy *)`, or deny `Skill` to turn skills off entirely.

**In a session:** `/skills` lists them, `/name arguments` runs one. This works with `-p` too: `cairn -p "/review src/a.ts"`. Skills written for Claude Code work when copied into `.cairn/skills`; `${CLAUDE_SKILL_DIR}` and similar variables are still understood.

## Plugins

A plugin bundles skills, commands, agents, hooks, MCP servers and executables to install in one step.

```
toolkit/
├── .cairn-plugin/plugin.json   # optional; .claude-plugin/plugin.json is read too
├── skills/deploy/SKILL.md      # becomes /toolkit:deploy
├── commands/status.md          # becomes /toolkit:status
├── agents/reviewer.md          # becomes the agent toolkit:reviewer
├── hooks/hooks.json            # {"hooks": {"PostToolUse": [...]}}
├── .mcp.json                   # tools become mcp__plugin_toolkit_<server>__<tool>
└── bin/tool                    # on the PATH of commands the model runs
```

```sh
cairn --plugin-dir ./toolkit        # for this run only
cairn plugin validate ./toolkit     # add --strict to treat warnings as errors
cairn plugin install ./toolkit      # copy into ~/.cairn/plugins
cairn plugin list | enable | disable | uninstall
```

Inside a plugin, use `${CAIRN_PLUGIN_ROOT}`, `${CAIRN_PLUGIN_DATA}` and `${CAIRN_PROJECT_DIR}`; the `${CLAUDE_...}` forms work too. **Plugins can run commands through hooks and MCP servers**, so install only what you trust. Not yet supported: marketplaces, installing from git or a URL, `userConfig`, LSP.

## Sandbox

Bash rules are only guardrails. The sandbox is the boundary, enforced by the operating system around the commands the model runs: Seatbelt on macOS, bubblewrap on Linux. File tools, hooks and MCP servers run outside it, under the permission rules.

```json
{
  "sandbox": {
    "enabled": true,
    "excludedCommands": ["docker *"],
    "filesystem": { "allowWrite": ["~/.kube"], "denyRead": ["~/.ssh", "~/.aws"], "allowRead": [] },
    "network": { "allowedDomains": ["github.com", "*.npmjs.org"], "deniedDomains": [], "allowLocalBinding": false }
  }
}
```

- **Writes:** only the working directories, temporary directories and `allowWrite`. `.cairn/settings*.json`, `.cairn/hooks`, `.mcp.json`, `CAIRN.md`, `.git/hooks`, `.git/config` and shell startup files cannot be written, in subdirectories too.
- **Reads:** almost everything, **including `~/.ssh`**, unless you add it to `denyRead`.
- **Network:** none by default. With `allowedDomains`, commands go through a proxy that checks the domain name. The proxy does not decrypt TLS, so it sees names, not content.
- **No more prompts:** sandboxed commands run without approval (turn this off with `autoAllowBashIfSandboxed: false`). Deny rules, ask rules that name the exact command, and commands that delete important paths still apply. A command such as `FOO=bar npm test` still asks.
- **Leaving the sandbox:** the model can request `dangerouslyDisableSandbox`, which always needs approval. Turn it off entirely with `allowUnsandboxedCommands: false`.
- **When it cannot run:** Cairn warns and runs commands unsandboxed, unless `failIfUnavailable: true` is set.

`/sandbox` shows its state. Linux has no proxy yet, so `allowedDomains` does not work there and commands get no network. The Linux path **has not been tried** because development happens on macOS.

## Background commands

`run_in_background` starts a command and writes its output to a log file. The model is told when the command ends, can read the log without a prompt, and stops it with `TaskStop`; you use `/tasks` and `/tasks stop <id>`. A command that outlasts its `timeout` is moved to the background rather than killed, unless it starts with `sleep` or the session runs with `--bare`.

With `-p`, Cairn waits for background commands to finish before exiting, up to 10 minutes or the command's `timeout` (at most 2 hours). Commands a subagent starts stop with that subagent. A bare `sleep` in the foreground is blocked; to wait for a condition, run a command that exits when it is true with `run_in_background`, or use `Monitor`.

## System prompt

The system prompt is assembled at run time from sections, not stored as one fixed string. The sections fall into two groups: `shared`, a stable prefix that prompt caching can reuse, and `session`, which changes from run to run. A boundary between the two marks the cache point. Which sections appear, and how they read, depends on the run: `--bare` and lean mode shorten the prefix; an interactive session gets the tip about running commands with `!`, while an autonomous run (`-p`) gets guidance on writing for a reader and working without asking; the model, skills, web search, MCP servers, instruction files and memory each add or change sections. `--system-prompt` replaces the whole `shared` group, and `--append-system-prompt` adds to the end. The text is adapted from Claude Code's published system prompts.

## Tools and agents

Besides the file, search, Bash and WebFetch tools, the model has:

- **Agent, SendMessage, ListAgents**: subagents that run in the background with their own context. `general-purpose` has every tool, `Explore` and `Plan` are read-only, and `fork` inherits the conversation. Reports come back as notifications; SendMessage continues an agent, and TaskStop stops one.
- **EnterPlanMode, ExitPlanMode**: plan mode, where the model only reads and writes to one plan file, then asks you to approve the plan before changing code. `/plan` turns it on too.
- **Monitor**: runs a long-lived script or WebSocket, and each line of stdout becomes a notification in the conversation (interactive sessions only).
- **CronCreate, CronDelete, CronList**: schedule a prompt on a cron schedule in local time. Jobs last only for the session (interactive sessions only).
- **EnterWorktree, ExitWorktree**: work in a separate git worktree, only when you or the instructions ask for it explicitly.
- **PushNotification**: a desktop notification when something is worth coming back for (interactive sessions only).
- **WebSearch**: web search through Anthropic's server tool. Turn it off with the rule `"deny": ["WebSearch"]`.

**Automatic memory.** The model keeps notes across sessions in `~/.cairn/memory/<project>/`, one file per note, with `MEMORY.md` as an index loaded into every session. Turn it off with `"autoMemoryEnabled": false`.

**Output style.** `"outputStyle"` takes `Concise`, `Explanatory`, `Learning` or `Proactive`, and changes how the model answers for the whole session.

## Testing

CI (`.github/workflows/ci.yml`) runs the typecheck and tests on Ubuntu and macOS, then packs the npm package, installs it and runs it on Node 22, 24 and 26.

### Against the real API

The regular tests run the real SDK against a fake server, so they cost nothing, but they cannot prove the real API agrees. The live check costs a few cents:

```sh
ANTHROPIC_API_KEY=... bun run test:live
```

### Mock provider

`--provider scripted` replies from a script instead of a model, so you can use Cairn as an end user without an API key: approve or deny tool calls, answer questions, watch subagents, interrupt, `/rewind`, `/compact`. Run it in a scratch directory, because the tool calls are real.

```sh
mkdir -p /tmp/play && cd /tmp/play
cairn --provider scripted       # from source: bun run start --provider scripted
```

With no `CAIRN_SCRIPT`, it uses the built-in rules in `src/providers/mock-demo.json`. Type `help` to list them: `run <command>`, `read <file>`, `find <pattern>`, `grep <regex>`, and `demo edit`, `demo todo`, `demo ask`, `demo agent`, `demo think`, `demo slow` and `demo error`.

**Your own rules.** Set `CAIRN_SCRIPT` to a JSON file:

```json
{
  "rules": [
    {
      "regex": "^deploy (\\w+)$",
      "steps": [
        { "text": "Deploying {{1}}.", "toolCalls": [{ "name": "Bash", "input": { "command": "echo deployed {{1}}" } }] },
        { "text": "Done: {{result}}" }
      ]
    },
    { "match": "hello", "steps": [{ "text": "Hi! You said: {{prompt}}" }] }
  ],
  "fallback": { "text": "Unknown command: {{prompt}}" }
}
```

```sh
CAIRN_SCRIPT=./rules.json cairn --provider scripted
```

- **Matching:** the first rule that matches what you typed answers it. `match` looks for the text anywhere, ignoring case; `regex` is a JavaScript regular expression, also ignoring case. A subagent's prompt is matched the same way, and so is a `<task-notification>` that arrives when background work finishes.
- **Steps:** the first step answers the prompt. Each later step answers the tool results of the step before it. A step with `toolCalls` continues the turn; one without ends it. When a rule runs out of steps, the turn ends.
- **Placeholders**, in any string of a step: `{{prompt}}` is what you typed, `{{1}}`, `{{2}}`… are the regex groups, and `{{result}}` is the output of the previous step's tools, up to 2,000 characters.
- **A step** can also have `thinking`, `delayMs` (wait first, so you can press Esc), `error` with `errorStatus` (fail like the API would), `stopReason` and `usage`. Tool inputs use the same fields as the real tools, such as `file_path`, `command` or `pattern`.
- **Cairn's own requests** get fixed replies and do not use your rules: session titles and `/rename`, `/btw`, and the summary for `/compact`.

A JSON array instead of `{ "rules": … }` is played in order, one item per request, whatever you type. The tests use that form.

## Configuration

Settings are read in this order: `~/.cairn/settings.json`, `.cairn/settings.json`, `.cairn/settings.local.json`, then `--settings`.

```json
{
  "permissions": {
    "allow": ["Bash(npm test *)", "Edit(/src/**)"],
    "ask": ["Bash(git push *)"],
    "deny": ["Read(.env)", "Bash(curl *)"],
    "defaultMode": "default"
  },
  "hooks": {
    "PreToolUse": [
      { "matcher": "Bash", "hooks": [{ "type": "command", "command": ".cairn/hooks/check.sh" }] }
    ]
  }
}
```

**Permission modes:**

| Mode | Behavior |
| --- | --- |
| `default` | Asks before changing files or running commands that are not read-only |
| `acceptEdits` | Approves file changes and `mkdir`, `touch`, `mv`, `cp` inside the working directories |
| `plan` | Read-only; leave it by approving a plan |
| `dontAsk` | Refuses everything that would have asked |
| `bypassPermissions` | Never asks, except for ask rules and commands that delete important paths. Use it only in an isolated environment |

Bash rules guard against mistakes; they are not a security boundary. For a real boundary, see Sandbox.

**Hooks:** `SessionStart`, `SessionEnd`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `PostToolUseFailure`, `PostToolBatch`, `PermissionRequest`, `Notification`, `SubagentStart`, `SubagentStop`, `PreCompact`, `PostCompact`, `InstructionsLoaded`, `CwdChanged`, `StopFailure`, `Stop`. A `command` hook receives JSON on stdin; an `http` hook receives it by POST. Exit 0 may print a JSON decision, exit 2 blocks, and any other code is a non-blocking error unless `"onFailure": "block"` is set. Set `args` to run without a shell, and `"async": true` to not wait. A matcher containing special characters is an unanchored regex, so `^Notebook` matches `NotebookEdit`. Hook types `prompt`, `agent` and `mcp_tool` are not supported yet and produce a warning.

**Instructions:** `CAIRN.md` is loaded from `~/.cairn/`, then from the filesystem root down to the working directory, along with `CAIRN.local.md`. A directory without `CAIRN.md` uses `AGENTS.md` or `CLAUDE.md`. `@path/to/file` imports another file. The system prompt is frozen for each conversation, so edits to these files take effect from the next session.

**Rules:** `.cairn/rules/**/*.md` and `~/.cairn/rules/**/*.md`. A rule without `paths` loads at startup; one with `paths` joins the conversation only when the model reads or changes a matching file:

```markdown
---
paths:
  - "src/api/**/*.{ts,tsx}"
---
Every endpoint must validate its input.
```

`CAIRN.md` files and rules in subdirectories also join the conversation when the model touches a file there. After compaction, they are added again when needed.

**Reading files:** `Read` understands PNG, JPEG, GIF and WebP images (shrunk with `sips` or ImageMagick when too large), PDFs (up to 10 pages are shown whole; longer ones need `pages`, such as `"1-5"`, up to 20 pages per call, and need poppler's `pdftoppm`), and `.ipynb` notebooks. `NotebookEdit` changes one cell at a time.

**Other settings:** `env` sets environment variables, `enabledPlugins` (read from user settings only), `sandbox`, `autoCompact`, `updateCheck` and `autoUpdates` (both read from user settings only; see Updates above).

**Extending:** custom subagents in `.cairn/agents/*.md`, or through `--agents`; see also MCP, Skills and Plugins above.

**Workspace trust:** a project's hooks, allow rules, provider, MCP servers, skills, custom commands and agents take effect only after you trust the directory, through the prompt at startup, `/trust`, or `--trust` for one run.

## Code layout

```
src/cli.ts            Entry point and argument parsing
src/core/             Agent loop, session wiring, system prompt, compaction
src/providers/        Model API connections, and `cairn provider`
src/mcp/              Configuration, connections, OAuth and `cairn mcp`
src/skills/           Reading and filling in skills
src/plugins/          Reading, installing and managing plugins
src/sandbox/          Seatbelt, bubblewrap and the network proxy
src/tools/            The tools, including images, PDFs, notebooks and background commands
src/permissions/      Shell parsing, rules, and the decision engine
src/hooks/            Running hooks
src/session/          Transcripts, usage records, checkpoints and worktrees
src/commands/         Slash commands, `doctor`, `purge` and `usage`
src/ui/               REPL and print mode
scripts/build-npm.ts  Builds dist/npm/, the directory published to npm
README.npm.md         The README shown on npm
```

Rename the product in `src/config/paths.ts`.
