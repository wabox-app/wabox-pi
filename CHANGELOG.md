# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

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
