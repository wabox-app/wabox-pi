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
  "logLevel": "info",
  "timezone": "America/Sao_Paulo",
  "jail": true,
  "sandboxBash": "auto",
  "sandboxNetwork": true,
  "sandboxDenyRead": ["~/.ssh", "~/.aws", "~/.gnupg", "~/.pi"],
  "sandboxAllowRead": [],
  "workspaceOverrides": {
    "277880256909343-2a21b939c8": "/home/rod/Valter"
  },
  "conversations": {
    "5511999998888-ab12cd34ef": {
      "workspace": "./projetos/assistente",
      "tools": ["read", "edit", "write"],
      "sandboxBash": "bwrap"
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
| `tasks` | — | `[]` | scheduled tasks (see below) |
| `timezone` | `WABOX_PI_TIMEZONE` | system | default IANA time zone for `tasks` cron |
| `schedulerTickMs` | `WABOX_PI_SCHEDULER_TICK_MS` | `20000` | how often the scheduler checks for due tasks |
| `logLevel` | `WABOX_PI_LOG_LEVEL` | `info` | `debug`, `info`, `warn`, `error` |

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

Overridable keys: `workspace`, `jail`, `sandboxBash`, `sandboxNetwork`,
`sandboxDenyRead`, `sandboxAllowRead`, `sandboxBashBin`, `tools`, `excludeTools`,
`autoReply`, `errorReply`, `ackReact`, `batchWindowMs`, `workspaceTemplate`. Values replace
the instance value (lists are not merged); relative paths resolve against the
config file. A per-slug value wins over the environment variable for that
conversation. `groupPerParticipant` is instance-wide because it changes the slug
itself.

`workspaceOverrides` lets you point specific conversations at existing project
folders. Sessions, media, and processed envelopes still live under `stateDir`;
only the harness working directory (`cwd`) is redirected.

Without `inboxDir`/`outboxDir`, `wabox-pi` asks `wabox status` (and
`wabox status --json` on newer cores) before falling back to XDG defaults.

### Scheduled tasks

`tasks` runs an agent turn on a cron schedule, with no incoming message, so the
agent can send a proactive WhatsApp message (or do work and report back):

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

### Chat commands

Send these as normal WhatsApp messages:

| Command | Effect |
| --- | --- |
| `/help` | command list |
| `/status` | session id, model, workspace, turn count |
| `/tasks` | scheduled tasks, next run, and which target each uses |
| `/new` (or `/reset`, `/clear`) | drop the session history for this chat |
| `/ping` | liveness check |

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
   `read` family may also read the conversation's `media/` folder.
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

- Per-conversation model/thinking overrides (`/model`).
- Approval over WhatsApp for sensitive tool calls (currently tools run
  unattended; restrict `tools` for untrusted chats).
- Catch-up for scheduled tasks that were due while the daemon was down.
- Idle-session eviction for installations with many conversations.
- Audio transcription hook (inbound voice notes).
- Optional service unit / installer.
