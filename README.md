# wabox-pi

A [wabox](https://github.com/wabox-app/wabox) harness that connects WhatsApp
conversations to [pi](https://github.com/earendil-works/pi) coding-agent
sessions.

```
inbox/<message>.json  →  wabox-pi  →  one persistent pi session per chat  →  outbox/<reply>.json
```

`wabox-core` owns WhatsApp and the filesystem contract; `wabox-pi` owns the
agent loop. It does **not** connect to WhatsApp itself, and it does not replace
`wabox run` — both run side by side.

## Why a separate harness

[wabox-bot](../wabox-bot) drives agent CLIs as subprocesses. `wabox-pi` embeds
the pi SDK in-process, which buys:

- **Persistent sessions per conversation** — context survives restarts; `/new`
  resets just that chat.
- **Tools instead of stdout parsing** — the agent calls `wabox_send` to reply
  with text, files, or reactions. The final assistant text is a fallback, not
  the protocol.
- **A real working directory per chat** — pi's read/bash/edit/write tools operate
  in an isolated workspace, so it can do actual work before replying.

## Install

Requires Node 22.19+ and a working wabox installation (`wabox status` should show
its inbox and outbox).

```bash
git clone https://github.com/wabox-app/wabox-pi
cd wabox-pi
npm install
npm link            # optional: puts `wabox-pi` on PATH
pi config           # if you have not configured a model/credentials yet
```

If you run wabox from a checkout instead of a global install, either
`npm link` in `../wabox-core` (so `wabox status` resolves the folders) or set
`WABOX_INBOX` / `WABOX_OUTBOX` explicitly. wabox-pi only needs the two folders;
it never opens a WhatsApp connection of its own.

## Run

```bash
wabox-pi run        # foreground
wabox-pi status     # resolved folders + conversation/session counts
```

Start `wabox run` (or its background service) separately. Messages appear in
wabox's inbox; wabox-pi claims each one, runs the agent, and writes the reply to
the outbox. Claiming removes the envelope from `inbox/`, which is also what
triggers the WhatsApp read receipt.

### Dashboard

A small web UI for inspecting and tuning conversations. It reads the same state
the daemon writes and edits only `config.json`, a chat's session files, and its
workspace.

```bash
wabox-pi run --dashboard          # daemon + UI on http://127.0.0.1:7345
wabox-pi dashboard                # UI only (inspect state, edit config)

# or pin it in config.json / env
# { "dashboardPort": 7345, "dashboardHost": "127.0.0.1" }
WABOX_PI_DASHBOARD_PORT=7345 wabox-pi run
```

What it exposes per conversation:

- **Overview** — identity (JID, number), session/message/file counts, effective
  model, quick actions (reload or clear the session).
- **Mensagens** — the processed inbox envelopes, verbatim.
- **Sessão** — the pi session transcript: user turns, assistant text, thinking,
  tool calls and results, token usage, and per-message errors.
- **Configuração** — the per-conversation overrides (model, thinking, timeouts,
  tools, jail/sandbox, auto-reply, …). Empty fields inherit the instance value
  (shown as a placeholder); saving rewrites `conversations.<slug>` in
  `config.json` and asks the daemon to reload that chat.
- **Visão** — the image fallback: mode, vision model (or local command), prompt,
  and limits. See [Image fallback](#image-fallback-vision-model).
- **System prompt** — two layers: an inline `systemPrompt` override in
  `config.json` and the workspace's `SYSTEM.md`, appended to pi's prompt after
  the WhatsApp etiquette rules. Both are read when a session is created.
- **Workspace** — browse and edit the files the agent works with (`AGENTS.md`,
  `MEMORY.md`, generated documents). Writes stay inside the workspace.

Global views show daemon status, the scheduled jobs (config + chat-created),
and a live tail of `wabox-pi.log`.

Notes:

- Settings changes restart the chat's in-memory session; the next message uses
  the new model/prompt and resumes the same history. "Clear session" deletes
  the `.jsonl` files instead.
- The server binds to `127.0.0.1` by default. Binding to any other address
  requires `WABOX_PI_DASHBOARD_TOKEN`; requests must then send
  `Authorization: Bearer <token>`.
- A standalone `wabox-pi dashboard` cannot reload the daemon's live sessions:
  settings apply on the daemon's next session/restart.

### Configuration

Settings resolve as **environment > `config.json` > defaults**. The config file
lives at `${XDG_CONFIG_HOME:-~/.config}/wabox-pi/config.json`:

```json
{
  "inboxDir": "~/.local/share/wabox/inbox",
  "outboxDir": "~/.local/share/wabox/outbox",
  "stateDir": "~/.local/state/wabox-pi",
  "batchWindowMs": 1500,
  "ackReact": "👀",
  "autoReply": true,
  "errorReply": true,
  "groupPerParticipant": false,
  "tools": ["read", "bash", "edit", "write", "grep", "find", "ls"],
  "excludeTools": [],
  "modelProvider": "openrouter",
  "model": "moonshotai/kimi-k2.6",
  "logLevel": "info",
  "timezone": "America/Sao_Paulo",
  "jail": true,
  "sandboxBash": "auto",
  "sandboxNetwork": true,
  "sandboxDenyRead": ["~/.ssh", "~/.aws", "~/.gnupg", "~/.pi"],
  "sandboxAllowRead": [],
  "transcription": {
    "baseUrl": "https://api.groq.com/openai/v1/audio/transcriptions",
    "model": "whisper-large-v3",
    "apiKeyFile": "stt.key"
  },
  "workspaceOverrides": {
    "277880256909343-2a21b939c8": "/home/rod/Valter"
  },
  "conversations": {
    "5511999998888-ab12cd34ef": {
      "workspace": "./projetos/assistente",
      "tools": ["read", "edit", "write"],
      "sandboxBash": "bwrap",
      "modelProvider": "anthropic",
      "model": "claude-sonnet-4-5",
      "thinkingLevel": "high"
    }
  },
  "tasks": [
    {
      "name": "morning-brief",
      "slug": "277880256909343-2a21b939c8",
      "cron": "0 8 * * 1-5",
      "prompt": "Summarise today's notes and calendar, then send it here."
    }
  ]
}
```

| Key | Env | Default | Meaning |
| --- | --- | --- | --- |
| `inboxDir` | `WABOX_INBOX` | from `wabox status` | wabox-core inbox |
| `outboxDir` | `WABOX_OUTBOX` | from `wabox status` | wabox-core outbox |
| `stateDir` | `WABOX_PI_STATE_DIR` | `~/.local/state/wabox-pi` | sessions, workspaces, media, log |
| `batchWindowMs` | `WABOX_PI_BATCH_MS` | `0` | wait this long to coalesce a burst (photo + caption) into one turn |
| `ackReact` | `WABOX_PI_ACK_REACT` | `""` | emoji reacted on pickup; empty disables |
| `autoReply` | `WABOX_PI_AUTO_REPLY` | `true` | send final text when the agent did not call `wabox_send` |
| `errorReply` | `WABOX_PI_ERROR_REPLY` | `true` | send a short notice when a turn fails |
| `groupPerParticipant` | `WABOX_PI_GROUP_PER_PARTICIPANT` | `false` | one session per group sender instead of per group |
| `tools` | `WABOX_PI_TOOLS` | read,bash,edit,write,grep,find,ls | pi tool allowlist |
| `excludeTools` | `WABOX_PI_EXCLUDE_TOOLS` | `[]` | pi tool denylist |
| `jail` | `WABOX_PI_JAIL` | `true` | path-jail file tools to the conversation workspace |
| `sandboxBash` | `WABOX_PI_SANDBOX_BASH` | `auto` | `off`, `auto` (bubblewrap if present, else warn), `bwrap` (required) |
| `sandboxNetwork` | `WABOX_PI_SANDBOX_NET` | `true` | keep network access inside the bash sandbox |
| `sandboxDenyRead` | `WABOX_PI_SANDBOX_DENY_READ` | sensible secrets list | dirs hidden from sandboxed bash |
| `sandboxAllowRead` | `WABOX_PI_SANDBOX_ALLOW_READ` | `[]` | read-only paths re-exposed inside a denied parent |
| `sandboxBashBin` | `WABOX_PI_SANDBOX_BASH_BIN` | `bwrap` | bubblewrap binary |
| `conversations` | — | `{}` | per-slug overrides (see below) |
| `workspaceOverrides` | — | `{}` | older shortcut for `conversations.<slug>.workspace` |
| `transcription` | — | disabled | inbound audio transcription (see below) |
| `tasks` | — | `[]` | scheduled tasks (see below) |
| `timezone` | `WABOX_PI_TIMEZONE` | system | default IANA time zone for `tasks` cron |
| `schedulerTickMs` | `WABOX_PI_SCHEDULER_TICK_MS` | `20000` | how often the scheduler checks for due tasks |
| `turnFeedbackMs` | `WABOX_PI_TURN_FEEDBACK_MS` | `60000` | react to the message when a turn takes this long (`0` = off) |
| `ignoreEmojiOnly` | `WABOX_PI_IGNORE_EMOJI_ONLY` | `true` | drop messages whose text is only emoji(s) |
| `ignoreEmpty` | `WABOX_PI_IGNORE_EMPTY` | `true` | drop envelopes with no text and no media |
| `logTokens` | `WABOX_PI_LOG_TOKENS` | `true` | log token usage and context size per turn |
| `turnFeedbackReact` | `WABOX_PI_TURN_FEEDBACK_REACT` | `⏳` | emoji for the "still working" reaction |
| `turnTimeoutMs` | `WABOX_PI_TURN_TIMEOUT_MS` | `600000` | abort a turn that runs longer than this (`0` = off) |
| `contextCompactRatio` | `WABOX_PI_CONTEXT_COMPACT_RATIO` | `0.5` | compact the session past this share of the model's window |
| `contextCompactWarnTokens` | `WABOX_PI_CONTEXT_WARN_TOKENS` | `120000` | warn in the log past this many context tokens |
| `logLevel` | `WABOX_PI_LOG_LEVEL` | `info` | `debug`, `info`, `warn`, `error` |
| `dashboardPort` | `WABOX_PI_DASHBOARD_PORT` | `0` (off) | dashboard HTTP port |
| `dashboardHost` | `WABOX_PI_DASHBOARD_HOST` | `127.0.0.1` | dashboard bind address |
| `vision` | — | disabled | inbound-image fallback (see below) |

#### Per-conversation overrides

The instance-wide settings above are defaults. `conversations` overrides them for
a single chat, keyed by the conversation slug (the folder name under
`conversations/`, shown by `/status`):

```json
{
  "jail": true,
  "sandboxBash": "auto",
  "conversations": {
    "5511999998888-ab12cd34ef": {
      "workspace": "./projetos/assistente",
      "jail": false,
      "sandboxBash": "off",
      "sandboxNetwork": false,
      "sandboxDenyRead": ["~/secrets"],
      "tools": ["read", "edit", "write"],
      "excludeTools": ["bash"],
      "autoReply": false,
      "ackReact": "👍",
      "batchWindowMs": 500
    }
  }
}
```

Overridable keys: `workspace`, `modelProvider`, `model`, `thinkingLevel`,
`systemPrompt`, `jail`, `sandboxBash`, `sandboxNetwork`, `sandboxDenyRead`,
`sandboxAllowRead`, `sandboxBashBin`, `tools`, `excludeTools`, `autoReply`,
`errorReply`, `ackReact`, `batchWindowMs`, `workspaceTemplate`, `vision`. Values
replace the instance value (lists are not merged); relative paths resolve against
the config file. A per-slug value wins over the environment variable for that
conversation. `groupPerParticipant` is instance-wide because it changes the
slug itself. `vision` is the exception: its fields are merged over the instance
block.

`systemPrompt` is an inline text appended to the system prompt for that
conversation. The workspace's `SYSTEM.md`, when present, is appended after it.
Both are read once per session (use the dashboard or `/new` to rebuild).

The chat model is `modelProvider` + `model`. `model` is a model id (or
`provider/id`); the pair is resolved against pi's model catalog, so any model
you can use in pi works. Leave both unset to keep pi's default. `/model` shows
the configured pair and the model the session is actually using. Changing it
takes effect on the next session (`/new` or restart); an existing session keeps
its model until then.

`workspaceOverrides` lets you point specific conversations at existing project
folders. Sessions, media, and processed envelopes still live under `stateDir`;
only the harness working directory (`cwd`) is redirected.

Without `inboxDir`/`outboxDir`, `wabox-pi` asks `wabox status` (and
`wabox status --json` on newer cores) before falling back to XDG defaults.

#### Image fallback (vision model)

pi models accept text and image input — but many useful chat models are
text-only. When an image (or sticker) arrives and the active model does not
accept images, wabox-pi describes it with a separate vision model and puts the
description in the turn prompt, next to the attachment path. The agent is told
the picture is text-only, so it does not pretend to have looked at it.

Any pi model that accepts images works; pi's stored credentials are reused, so
there is no extra secret when you already use that provider in pi.

```json
{
  "vision": {
    "modelProvider": "openrouter",
    "model": "google/gemini-2.5-flash",
    "mode": "auto"
  }
}
```

| Key | Meaning |
| --- | --- |
| `enabled` | default `true` once a backend is set |
| `mode` | `auto` (default) describes only when the chat model cannot read images; `always` describes every image; `off` disables |
| `modelProvider` / `model` | the vision model, resolved against pi's catalog |
| `command` | local alternative: shell command receiving the image path (or `{file}`); stdout is the description |
| `prompt` | instruction override for the vision model |
| `maxTokens` | description budget (default `1024`) |
| `maxBytes` | refuse images larger than this (default `8000000`) |
| `timeoutMs` | default `120000` |
| `apiKey` | optional key for the pi model (otherwise pi's stored credential) |
| `writeSidecar` | default `true`; writes `<file>.description.txt` next to the media |

A conversation can override the `vision` block (`conversations.<slug>.vision`);
the pieces are merged, so setting only `mode: "always"` keeps the instance
model. The dashboard's **Visão** tab edits this. If the description fails, the
prompt says so and the agent is told not to guess the image contents. Vision
runs in the daemon process, like transcription.

#### Web access

The agent's shell is intentionally offline (`sandboxNetwork`), so the web is
reached through two tools served by the daemon process:

- `wabox_fetch <url>` — fetch a page/API and return readable text (HTML is
  stripped). Follows up to 5 redirects.
- `wabox_search <query>` — web search; the default provider needs no key.

```json
{
  "web": {
    "fetch": { "enabled": true, "allow": [], "deny": [], "timeoutMs": 20000, "maxBytes": 2000000 },
    "search": { "enabled": true, "provider": "duckduckgo", "maxResults": 5 }
  }
}
```

| Key | Env | Meaning |
| --- | --- | --- |
| `web.fetch.enabled` | `WABOX_PI_WEB_FETCH` | expose `wabox_fetch` (default `true`) |
| `web.fetch.allow` / `deny` | — | host suffix/glob lists; a non-empty `allow` is the only way in |
| `web.fetch.maxBytes` / `timeoutMs` | — | response caps (default 2 MB / 20 s) |
| `web.search.enabled` | `WABOX_PI_WEB_SEARCH` | expose `wabox_search` (default `true`) |
| `web.search.provider` | `WABOX_PI_SEARCH_PROVIDER` | `duckduckgo` (keyless), `searxng` (`baseUrl`), `brave` (`apiKey`) |
| `web.search.apiKey` / `apiKeyEnv` / `apiKeyFile` | `WABOX_PI_SEARCH_KEY` | key for keyed providers |

`wabox_fetch` guards against SSRF: only `http(s)`, the host must resolve to
public addresses (private/loopback/link-local are refused unless the host is in
`web.fetch.allow`), and every redirect hop is re-checked. Provider endpoints are
operator-configured and bypass that guard, so a self-hosted SearXNG can be local.

### Scheduled tasks

`tasks` runs an agent turn on a cron schedule, with no incoming message, so the
agent can send a proactive WhatsApp message (or do work and report back). Jobs
can also be added, listed, and removed from chat (see `/schedule`, `/jobs`):

```json
{
  "timezone": "America/Sao_Paulo",
  "tasks": [
    {
      "name": "morning-brief",
      "slug": "277880256909343-2a21b939c8",
      "cron": "0 8 * * 1-5",
      "prompt": "Summarise today's notes and calendar, then send it here.",
      "enabled": true
    },
    {
      "name": "weekly-review",
      "to": "5511999998888@s.whatsapp.net",
      "cron": "0 18 * * 5",
      "timezone": "America/Sao_Paulo",
      "prompt": "Ask how the week went and offer to file the notes."
    }
  ]
}
```

| Field | Meaning |
| --- | --- |
| `name` | unique label (also the key in `scheduler.json`) |
| `slug` or `to` | target conversation; `slug` uses the JID remembered from the last inbound message, `to` is an explicit JID |
| `participant` | group participant, when `to` names a group |
| `cron` | 5-field cron (`minute hour day-of-month month day-of-week`) or `@daily`/`@hourly`/`@weekly`/`@monthly`/`@yearly` |
| `timezone` | IANA zone for this task; falls back to the global `timezone`, then the system zone |
| `prompt` | instructions for the turn |
| `enabled` | default `true` |
| `silent` | default `false`; when true the task never auto-replies (it must use `wabox_send`), so an orchestrator can stay silent when there is nothing to do |

The task turn is serialized with that chat's other turns and the agent replies
through the normal `wabox_send` tool (no quoting, since there is no message to
quote). If it produces only text, `autoReply` sends it. The harness remembers
the JID the first time it sees a chat (`conversations/<slug>/identity.json`), so
`slug` targets keep working across restarts. `identity.json` is written from the
inbound envelope only; nothing is invented.

Behavior notes:

- The scheduler ticks every `schedulerTickMs` and fires each task **at most
  once per minute**; the last fire is persisted in `scheduler.json` so a restart
  inside the same minute does not double-send.
- A task missed while the daemon was down is **not** replayed.
- Invalid tasks (bad cron, unknown timezone, missing target) are reported at
  startup and by `/tasks`; they never crash the daemon.

#### Messages with nothing to answer

A WhatsApp **reaction** (👍 on the agent's message) reaches the inbox as an
envelope with no text and no media — wabox-core's `extractText` only reads
conversation text and captions, so a reaction carries nothing. A message whose
text is only emoji(s) is the same idea.

Both are dropped without a reply: the envelope is still claimed (the read
receipt fires), but the agent is not called and no reaction or message goes
out. Mixed text ("ok 👍") is a normal message and gets an answer. Set
`ignoreEmojiOnly` or `ignoreEmpty` to `false` to answer them.

#### Token and context logging

Every turn (and every scheduled task) logs what it cost and how big the
context got:

```
[slug] turn done in 2693ms (1 outbox job(s)) | tokens in 2.5k out 94
cacheRead 2.8k reasoning 74 total 5.4k $0.00141 | ctx 2.7k/262k (1.0%)
```

- `tokens` — input, output, cache read/write, reasoning, total, and the cost,
  summed over the model requests of that turn.
- `ctx` — the estimated context size against the model's window, in percent.
  The estimate comes from pi's session projection, so it accounts for
  compaction.

`/status` shows the same numbers accumulated over the session. Set
`logTokens` to `false` to keep the log quiet.

#### Long turns and big contexts

A turn can take minutes when the model has a lot of context to chew on. Two
guards keep the chat informed and the queue moving:

- `turnFeedbackMs` (default 60 s) reacts to the inbound message with
  `turnFeedbackReact` (⏳) when the turn is still running, so it is obvious the
  agent is alive.
- `turnTimeoutMs` (default 10 min) aborts the turn and replies
  "⏱️ Isso demorou demais e eu interrompi. Manda de novo que eu continuo daqui."
  instead of leaving the conversation queue blocked.

Context grows over a long-lived chat, and every request re-sends it, so turns
get slower and slower. pi only compacts near the model's window limit, which is
too late: wabox-pi compacts at `contextCompactRatio` (default 50 %) of the
model's window and warns in the log past `contextCompactWarnTokens`. `/new`
starts a fresh session if you want to drop the history on purpose.

### Chat commands

Send these as normal WhatsApp messages:

| Command | Effect |
| --- | --- |
| `/help` | command list |
| `/status` | session id, model, workspace, turn count |
| `/model` | configured model override and the active model |
| `/jobs` (or `/tasks`) | scheduled jobs, next run, and which target each uses |
| `/schedule <cron> <prompt>` | add a job for this chat |
| `/unschedule <name>` (or `/cancel`) | remove a job created from chat |
| `/new` (or `/reset`, `/clear`) | drop the session history for this chat |
| `/ping` | liveness check |

`/schedule` takes the five cron fields, then the prompt:

```
/schedule 0 9 * * * Lembrar de tomar o remédio
/schedule @daily Revisar a inbox
```

The job is stored in `stateDir/tasks.json` (separate from `config.json`) and is
picked up by the scheduler immediately, without a restart. Jobs created from
chat are marked `(chat)` in `/jobs` and can be removed with `/unschedule`; jobs
from `config.json` are managed there.

Unrecognised `/…` messages are passed to pi, so pi slash commands (for example
`/compact`) still work.

## Security

The agent runs with the pi tools you enable; pi itself has no built-in sandbox
(see pi's `docs/security.md`). wabox-pi adds two layers to keep a conversation
inside its workspace:

1. **File tools are path-jailed.** With `jail: true` (default), a `tool_call`
   extension blocks `read`, `edit`, `write`, `grep`, `find`, `ls`, and the
   attachments of `wabox_send` when their path resolves outside the workspace —
   including through symlinks. Inbound attachments are the one exception: the
   `read` family may also read the conversation's `media/` folder, and the
   sandboxed shell sees that folder read-only, so the agent can copy an
   attachment into the workspace (for example into the vault's attachments
   folder) and then attach it with `wabox_send`.
2. **`bash` runs under bubblewrap.** `sandboxBash: "auto"` (default) wraps every
   shell command with `bwrap` when it is installed: the host is read-only, only
   the workspace is writable, `$HOME`/XDG dirs are redirected into the
   workspace, and `sandboxDenyRead` dirs (plus the state dir) are hidden. Set
   `sandboxBash: "bwrap"` to refuse to start a session when bubblewrap is
   missing instead of falling back to an unsandboxed shell.

Even so:

- Use wabox's allow list (`wabox allow`) so only trusted numbers can reach the
  agent. wabox-pi assumes every envelope that arrives is permitted.
- `jail` and the bash sandbox are not a replacement for running the daemon as a
  dedicated user or in a container; they constrain the agent, not the daemon.
- Restrict capabilities further with `WABOX_PI_TOOLS=read,ls` (or an
  `excludeTools` list). There is no interactive per-tool approval over WhatsApp
  yet; tool calls execute during the turn.

The harness itself never sends outbox files from arbitrary paths except the ones
the agent names; the file jail keeps those inside the workspace.

## How it works

```
~/.local/state/wabox-pi/
  conversations/<slug>/
    workspace/     pi cwd, seeded with AGENTS.md (memory + etiquette)
    sessions/      pi session JSONL files
    media/         inbound attachments moved out of wabox's inbox
    processed/     claimed inbox envelopes (audit trail)
    identity.json  JID last seen, used to target scheduled messages
  failed/          invalid envelopes
  tasks.json       jobs created from chat (/schedule)
  scheduler.json   last fire per scheduled task
  wabox-pi.log
```

1. **Claim.** An inbox `.json` is read, renamed into `processed/`, and its media
   moved into `media/`. The rename fires the read receipt immediately.
2. **Queue.** Messages are keyed by conversation (chat JID). A per-conversation
   queue serializes turns; different chats run in parallel. `batchWindowMs`
   coalesces bursts.
3. **Turn.** The session is created with `SessionManager.continueRecent`, so it
   resumes from `sessions/`. The prompt includes the sender, timestamp, text,
   quote context, and absolute attachment paths.
4. **Reply.** The agent calls `wabox_send` (text / files / reaction), which writes
   an atomic outbox job. If it only produced text, that text is sent as the
   reply. Every reply quotes the incoming message by default.
5. **Schedule.** Independently of the inbox, the scheduler fires due `tasks`
   onto the same per-chat queue, so a proactive message is serialized with the
   chat's replies; it is marked proactive and never quotes.

### Invariants

- **Read before remove.** The envelope is parsed into memory *before* it leaves
  `inbox/`. Deleting without capturing loses it forever; wabox never deletes.
- **Reply on the inbound JID.** DM replies use `from` verbatim (`@lid` or
  `@s.whatsapp.net`). Replying on the other identity desyncs the recipient's
  Signal session ("Waiting for this message").
- **Atomic outbox writes.** Jobs are written to a dot-prefixed temp name without
  a `.json` suffix, then renamed. wabox sends any `*.json` it sees immediately.
- **Serialized turns per chat.** pi sessions are not safe for concurrent turns,
  and a late reply would land after a newer question.
- **One daemon.** A PID lock in the state dir prevents two harnesses racing over
  the same inbox/sessions, and therefore the same scheduled tasks.
- **Verbatim JID for proactive sends.** A task sends to the JID recorded from
  the chat's last inbound message (or an explicit `to`), never a normalized or
  guessed identity.

## Development

```bash
npm test            # node:test unit tests
npm run check       # syntax-check every source file
npm run dev         # restart on change
```

For an end-to-end run without touching real data:

```bash
tmp=$(mktemp -d)
mkdir -p "$tmp/inbox" "$tmp/outbox"
WABOX_INBOX="$tmp/inbox" WABOX_OUTBOX="$tmp/outbox" \
WABOX_PI_STATE_DIR="$tmp/state" npm start

# in another shell: drop a fake envelope
printf '%s' '{"id":"X1","from":"5511999998888@s.whatsapp.net","number":"5511999998888","pushName":"Test","text":"hello","media":null}' \
  > "$tmp/inbox/msg.json"
# watch "$tmp/outbox" for the reply job
```

## Roadmap

- Approval over WhatsApp for sensitive tool calls (currently tools run
  unattended; restrict `tools` for untrusted chats).
- Authenticated multi-user dashboard (the current UI assumes a trusted local
  operator).
- Catch-up for scheduled tasks that were due while the daemon was down.
- Idle-session eviction for installations with many conversations.
- Audio transcription hook (inbound voice notes).
- Optional service unit / installer.
