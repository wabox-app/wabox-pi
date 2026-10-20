// Per-conversation layout under the harness state dir:
//
//   conversations/<slug>/
//     workspace/    pi's cwd, seeded with AGENTS.md
//     sessions/     pi session JSONL files (one active branch per conversation)
//     media/        inbound attachments, moved out of wabox's inbox
//     processed/    inbox envelopes, kept as an audit trail
//
// Keeping media and sessions per conversation means /new only resets the
// conversation; other chats and the audit trail are untouched.

import fs from 'node:fs/promises';
import path from 'node:path';

export function conversationPaths(config, slug) {
  const root = path.join(config.conversationsDir, slug);
  // Accepts either a merged per-conversation config (see conversationConfig)
  // or the raw instance config, where the override is nested under the slug.
  const override =
    config.workspace ??
    config.conversations?.[slug]?.workspace ??
    config.workspaceOverrides?.[slug];
  return {
    root,
    workspace: override ? path.resolve(override) : path.join(root, 'workspace'),
    sessions: path.join(root, 'sessions'),
    media: path.join(root, 'media'),
    processed: path.join(root, 'processed'),
    identity: path.join(root, 'identity.json'),
  };
}

// Remember how to reach this conversation for proactive/scheduled messages.
// The JID is stored verbatim: replying on a different identity desyncs Signal.
export async function rememberIdentity(paths, envelope) {
  const identity = {
    from: envelope.from,
    participant: envelope.participant ?? null,
    pushName: envelope.pushName ?? null,
    number: envelope.number ?? null,
    updatedAt: new Date().toISOString(),
  };
  try {
    await fs.writeFile(paths.identity, `${JSON.stringify(identity, null, 2)}\n`, { mode: 0o600 });
  } catch {
    // A missing identity only disables scheduled sends for this chat.
  }
  return identity;
}

export async function readIdentity(paths) {
  try {
    const identity = JSON.parse(await fs.readFile(paths.identity, 'utf8'));
    return identity && typeof identity.from === 'string' ? identity : null;
  } catch {
    return null;
  }
}

export async function ensureConversation(config, slug) {
  const paths = conversationPaths(config, slug);
  await Promise.all(
    [paths.workspace, paths.sessions, paths.media, paths.processed].map((dir) =>
      fs.mkdir(dir, { recursive: true }),
    ),
  );
  return paths;
}

// Seed instructions once. The user (or the agent) owns the file after that;
// never overwrite it.
export async function seedWorkspace(config, paths, log) {
  const target = path.join(paths.workspace, 'AGENTS.md');
  try {
    await fs.access(target);
    return false;
  } catch {
    // not there yet
  }
  try {
    await fs.copyFile(config.workspaceTemplate, target);
    log?.debug(`seeded ${target}`);
    return true;
  } catch (err) {
    log?.warn(`could not seed workspace instructions from ${config.workspaceTemplate}: ${err.message}`);
    return false;
  }
}
