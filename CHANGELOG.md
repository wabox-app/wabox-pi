# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

- A per-conversation `vision` block now works without an instance-level backend:
  the instance no longer derives `enabled: false`, which the deep merge used to
  apply over the conversation's model and silently disable image descriptions.
- Transcription received no retrying `fetch`: `transcribeBatch` referenced a
  fetch wrapper local to `ensureSession`, so configuring transcription threw a
  `ReferenceError` at turn time. The wrapper now lives on the agent.
- The WhatsApp system prompt no longer repeats the "instead of curl or wget"
  sentence.

### Added

- Management dashboard (`wabox-pi run --dashboard`, `wabox-pi dashboard`): a
  loopback-bound web UI and JSON API to inspect conversations, transcripts,
  scheduled jobs and the log, and to edit per-conversation settings live.
- Per-conversation system prompt layers: inline `systemPrompt` in `config.json`
  and an optional workspace `SYSTEM.md`, both appended to pi's prompt.
- `dashboardHost` / `dashboardPort` settings, `WABOX_PI_DASHBOARD_*` env vars,
  and an opt-in bearer token for non-loopback binds.
- Transcription through any pi provider (`provider: "opencode-go"`, `model:
  "gemini-4-argon"`): pi credentials are reused and the audio is sent as Gemini
  `inlineData` or OpenAI-compatible `input_audio`. The configured model id is used
  verbatim, so a stale catalog cannot redirect it to a deprecated sibling.
- Transcription fallback chain (`transcription.fallback`): ordered backends tried
  after the primary fails, per-conversation `transcription` overrides merged over
  the instance, and an **Áudio** tab in the dashboard. The final error names every
  backend and its failure reason.
- Image fallback for text-only chat models: inbound images are described by a
  separate vision model (`vision.modelProvider`/`model`, any pi model that
  accepts images) or a local command, with the description injected into the
  turn prompt. Modes `auto`/`always`/`off`, per-conversation overrides, and a
  **Visão** tab in the dashboard.

- Initial harness: watches wabox-core's inbox, claims envelopes (read receipt on
  pickup), runs one persistent pi session per conversation, and replies through
  wabox-core's outbox.
- `wabox_send` tool for text, file attachments, quote replies, and reactions.
- Per-conversation workspaces (seeded `AGENTS.md`), session storage, staged
  media, and a processed-envelope audit trail.
- Message batching window, optional ack reaction, and final-text auto-reply
  fallback.
- Local `/help`, `/status`, `/new`, `/reset`, `/clear`, and `/ping` commands;
  unknown slash commands pass through to pi.
- `wabox-pi status [--json]`, config resolution (env > JSON > defaults), and a
  single-instance lock.
- Unit tests for routing, prompt building, envelope parsing, the outbox writer,
  the send tool, and local command parsing.
