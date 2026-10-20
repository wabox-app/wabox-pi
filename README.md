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
  "logLevel": "info"
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
| `logLevel` | `WABOX_PI_LOG_LEVEL` | `info` | `debug`, `info`, `warn`, `error` |

Without `inboxDir`/`outboxDir`, `wabox-pi` asks `wabox status` (and
`wabox status --json` on newer cores) before falling back to XDG defaults.

### Chat commands

Send these as normal WhatsApp messages:

| Command | Effect |
| --- | --- |
| `/help` | command list |
| `/status` | session id, model, workspace, turn count |
| `/new` (or `/reset`, `/clear`) | drop the session history for this chat |
| `/ping` | liveness check |

Unrecognised `/…` messages are passed to pi, so pi slash commands (for example
`/compact`) still work.

## Security

The agent runs with the pi tools you enable. The default set includes `bash`,
so it can run commands as the daemon user — the per-conversation workspace is
its working directory, **not a sandbox**. Two consequences:

- Use wabox's allow list (`wabox allow`) so only trusted numbers can reach the
  agent. wabox-pi assumes every envelope that arrives is permitted.
- Restrict capabilities if you do not want that: `WABOX_PI_TOOLS=read,ls` (or an
  `excludeTools` list) trims the tool set. There is no interactive per-tool
  approval over WhatsApp yet; tool calls execute during the turn.

The harness itself never sends outbox files from arbitrary paths except the ones
the agent names; keep attachments inside the workspace to make review easy.

## How it works

```
~/.local/state/wabox-pi/
  conversations/<slug>/
    workspace/     pi cwd, seeded with AGENTS.md (memory + etiquette)
    sessions/      pi session JSONL files
    media/         inbound attachments moved out of wabox's inbox
    processed/     claimed inbox envelopes (audit trail)
  failed/          invalid envelopes
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
  the same inbox/sessions.

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
- Scheduled jobs and proactive messages.
- Idle-session eviction for installations with many conversations.
- Audio transcription hook (inbound voice notes).
- Optional service unit / installer.
