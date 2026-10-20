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
  return {
    root,
    workspace: path.join(root, 'workspace'),
    sessions: path.join(root, 'sessions'),
    media: path.join(root, 'media'),
    processed: path.join(root, 'processed'),
  };
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
