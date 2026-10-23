# AGENTS.md

Guidance for AI coding agents working in this repo. Humans: see
[README.md](README.md).

## What this is

`wabox-pi` is a consumer of [wabox-core](../wabox-core): it watches the core's
`inbox/`, runs a pi coding-agent session per WhatsApp conversation, and writes
replies to `outbox/`. It is a sibling of `wabox-bot` (bash, subprocess backends)
and is intentionally **not** a replacement for `wabox run`.

ESM JavaScript, Node >= 22.19, no build step. Runtime deps are deliberately few:
the pi SDK, `chokidar`, and `typebox`.

## Module map

| Path | Responsibility |
| --- | --- |
| `bin/wabox-pi.js` | Entrypoint; delegates to `src/cli.js`. |
| `src/cli.js` | `run` / `status` / `version` / `help`. |
| `src/config.js` | env > `config.json` > defaults; per-slug overrides; state paths; chat model. |
| `src/wabox-paths.js` | Asks `wabox status` for the inbox/outbox (fallback: XDG). |
| `src/daemon.js` | Inbox watcher, envelope claiming, per-chat queue runners, task firing. |
| `src/agent.js` | One `ConversationAgent` per chat: session lifecycle, turns. |
| `src/commands.js` | Local `/help`, `/status`, `/jobs`, `/schedule`, `/new`, `/ping` dispatch. |
| `src/tools.js` | The `wabox_send` tool (text/files/reaction → outbox job). |
| `src/outbox.js` | Atomic job writer + reply/reaction job builders. |
| `src/prompt.js` | Inbox envelope → per-turn prompt (pure). |
| `src/instructions.js` | WhatsApp-etiquette section appended to pi's system prompt. |
| `src/workspace.js` | Per-conversation dirs; seeds `AGENTS.md` once. |
| `src/jail.js` | Path-jail file tools; bubblewrap-sandbox `bash`. |
| `src/transcribe.js` | Inbound-audio transcription (command, OpenAI API, or OpenRouter chat). |
| `src/web.js` | `wabox_fetch` / `wabox_search` tools (SSRF-guarded, run in-process). |
| `src/generate_image.js` | `wabox_generate_image` tool (OpenRouter/Pollinations, run in-process). |
| `src/cron.js` | Time-zone-aware 5-field cron parsing + next-run search (pure). |
| `src/schedule.js` | Scheduled-task normalization, due check, last-run persistence. |
| `src/tasks.js` | Chat-created jobs (`stateDir/tasks.json`) + task-name derivation. |
| `src/routing.js` | Conversation key + filesystem-safe slug. |
| `src/envelope.js` | Envelope parsing/validation and reply targeting. |
| `src/emoji.js` | Detects emoji-only and contentless envelopes (no reply). |
| `src/usage.js` | Token/cost accounting and context formatting for the log. |
| `src/fsutil.js` | Cross-filesystem move (inbox and state may be different mounts). |
| `src/lock.js` | Single-instance PID lock. |
| `src/logger.js` | stderr + state-dir log, no dependencies. |
| `templates/workspace-AGENTS.md` | Seeded into each new conversation workspace. |

## Invariants

- **Claim = rename out of `inbox/`.** That unlink is wabox-core's read-receipt
  signal. Read the JSON into memory first, rename immediately, then do slow work.
- **No intent, no reply.** A WhatsApp reaction arrives as an envelope with no
  text and no media; an emoji-only message is the same. The daemon drops both
  after claiming them (`src/emoji.js`), with no reaction and no agent turn.
- **Reply to `from` verbatim.** DMs can arrive as `@lid` or `@s.whatsapp.net`;
  switching identities desyncs the recipient's Signal session. Never "normalize"
  the JID in the harness.
- **Outbox writes are atomic.** Temp name without `.json`, then rename. wabox
  sends any `*.json` at depth 0 immediately.
- **Turns are serialized per conversation.** pi sessions cannot run two turns at
  once, and out-of-order replies are confusing. Different conversations run
  concurrently.
- **A long turn must not look like a dead chat.** `startTurnFeedback` reacts
  after `turnFeedbackMs`; `startTurnTimeout` aborts after `turnTimeoutMs` and
  the agent replies instead of leaving the queue blocked. `maybeCompact`
  compacts before pi's own threshold, because a big context makes every
  request slow.
- **Turns report their cost.** `usageSuffix` appends the turn's token usage and
  the context size to the log line (`logTokens`). The context estimate comes
  from pi's `getContextUsage()`, so it reflects compaction.
- **Tools are the protocol.** `wabox_send` writes jobs during the turn. If the
  agent sends text/files through it, the final assistant text is *not* sent
  again. If it sends nothing, `autoReply` sends the final text (a safety net).
- **The web is a tool, not the shell.** With `sandboxNetwork` off the shell has
  no network; `wabox_fetch`/`wabox_search` run in the daemon process and are
  registered as custom tools. `wabox_fetch` validates the scheme, resolves the
  host and refuses private addresses, and re-checks every redirect.
- **Only `wabox-pi` deletes inbox files.** Media is moved into the conversation's
  `media/` folder so the agent has a stable path and the audit trail survives.
- **State is per conversation.** Sessions, workspace, media, and processed
  envelopes live under `conversations/<slug>/`; `/new` only clears that chat's
  session files.
- **The agent stays in its workspace.** `src/jail.js` blocks file-tool paths
  that resolve outside the workspace (plus the conversation's `media/`) via a
  pi `tool_call` handler, and wraps `bash` in bubblewrap. `workspaceOverrides`
  redirects `cwd`; it must not defeat the jail's read roots.
- **Inbound attachments are readable, not writable.** The conversation's
  `media/` folder is a read root for the file tools and is ro-bound in the bash
  sandbox, so the agent can read an attachment and copy it into the workspace.
  It can never write back into `media/` (the copy direction is the only one).
- **Instance config, per-slug overrides.** `conversationConfig(config, slug)`
  in `src/config.js` merges `config.json`'s `conversations.<slug>` over the
  instance config (workspace, tools, jail/sandbox, …). The daemon resolves it
  once per claim and hands the merged config to paths and the agent.
- **Scheduled turns go through the chat's queue.** `Scheduler` only decides
  *when*; `onFire` resolves the target and calls `runner.enqueueTask()`, so a
  proactive turn is serialized with that chat's replies and can use
  `wabox_send`. Tasks are marked `turn.proactive` so nothing quotes or reacts to
  a synthetic message id. `lastRun` is persisted in `scheduler.json`; missed
  runs are not replayed.
- **Jobs from chat are runtime state, not config.** `/schedule` writes
  `stateDir/tasks.json` via `TaskStore` and calls `scheduler.setTasks()` so the
  job runs without a restart. Config tasks stay in `config.json`; the merged
  list is `config.tasks` + `TaskStore.normalized()`. A task with `silent: true`
  never auto-replies (only `wabox_send` sends), which is what lets the Valter
  heartbeat end a no-op turn without a message.

## Gotchas

- `SessionManager.continueRecent(cwd, sessionDir)` creates a new session when
  none exists. `/new` deletes only `.jsonl` files in that conversation's session
  dir, then drops the in-memory session.
- `createAgentSession` may select a different model than the session was saved
  with; `modelFallbackMessage` is logged. A per-conversation
  `modelProvider`/`model` is resolved with `resolveCliModel` against a
  `ModelRuntime` and passed as `model`, which overrides the saved session model
  (`if (!model && hasExistingSession ...)`).
- Pass `expandPromptTemplates: false` for ordinary messages so a WhatsApp text
  like `/start` is not interpreted as a pi command. Local commands are handled
  before the agent; unknown `/…` commands intentionally fall through to pi.
- `DefaultResourceLoader` loads the user's normal pi setup (extensions, skills,
  settings). Do not build a custom loader unless there is a reason.
- pi's model input modalities are `text` and `image` only (`ModelInputModality`),
  so audio must be transcribed before the turn. Transcription runs in the agent
  (`transcribeBatch`) so a slow STT call does not block the inbox claim chain.
- `transcription.provider: "openrouter"` sends the audio as an `input_audio`
  content part over chat completions and, with no explicit key, reuses pi's
  stored credential via `readStoredCredential` (`~/.pi/agent/auth.json`). OpenAI
  `/audio/transcriptions` and local `command` transcribers are the other modes.
- `wabox status --json` is not present in every core version; `src/wabox-paths.js`
  falls back to the human-readable output and then to XDG defaults.
- The daemon must keep working when `wabox` is not on PATH (explicit env paths).

## Run & verify

```bash
npm install
npm test
npm run check

# end-to-end with a fake inbox/outbox
tmp=$(mktemp -d); mkdir -p "$tmp/inbox" "$tmp/outbox"
WABOX_INBOX="$tmp/inbox" WABOX_OUTBOX="$tmp/outbox" \
WABOX_PI_STATE_DIR="$tmp/state" node bin/wabox-pi.js run
```

Unit tests must not require model credentials or a live WhatsApp connection.
E2E agent turns do; use the fake envelope flow from the README and check the
outbox, or point `WABOX_PI_TOOLS` at a read-only set in a scratch config.

## Commits

Conventional prefixes (`feat:`, `fix:`, `docs:`, `test:`, `chore:`). Mark
AI-assisted commits with a `Co-Authored-By:` trailer.
