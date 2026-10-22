// Multi-thread conversation tracking per slug.
//
// Each slug (chat) can have multiple topic threads. The active thread is
// resolved by a light router at claim time. Sessions are stored per thread,
// so context is isolated while the workspace stays shared.

import fs from 'node:fs/promises';
import path from 'node:path';

// A lightweight thread record kept in <slug>/threads.json.
//
//   id           stable identifier (also the session folder name)
//   name         short human-readable label (agent can write this)
//   summary      one-line topic description for routing decisions
//   createdAt    ISO timestamp
//   lastActiveAt ISO timestamp — updated on every turn
//   messageCount how many turns this thread has handled

/**
 * @param {string} root — the slug directory (e.g. conversations/<slug>)
 */
export function threadsFile(root) {
  return path.join(root, 'threads.json');
}

/**
 * Read the threads database. Returns always a valid object even when the file
 * does not exist yet.
 */
export async function readThreads(root) {
  try {
    const raw = await fs.readFile(threadsFile(root), 'utf8');
    const parsed = JSON.parse(raw);
    return {
      activeThreadId: String(parsed.activeThreadId || 'default'),
      threads: Array.isArray(parsed.threads) ? parsed.threads : [],
    };
  } catch {
    return { activeThreadId: 'default', threads: [] };
  }
}

async function writeThreads(root, data) {
  const tmp = `${threadsFile(root)}.tmp`;
  await fs.writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`);
  await fs.rename(tmp, threadsFile(root));
}

/**
 * Touch the lastActiveAt of a thread and optionally bump its messageCount.
 */
export async function touchThread(root, threadId, { messageCountDelta = 0 } = {}) {
  const db = await readThreads(root);
  const thread = db.threads.find((t) => t.id === threadId);
  if (!thread) return db;
  thread.lastActiveAt = new Date().toISOString();
  if (messageCountDelta) thread.messageCount = (thread.messageCount || 0) + messageCountDelta;
  await writeThreads(root, db);
  return db;
}

/**
 * Create a new thread. Does not change the active thread — the caller decides.
 */
export async function createThread(root, { id, name = '', summary = '' } = {}) {
  const now = new Date().toISOString();
  const threadId = id || `thread-${now.replace(/[:.]/g, '-').toLowerCase()}`;
  const db = await readThreads(root);
  db.threads.push({
    id: threadId,
    name: name || threadId,
    summary: summary || '',
    createdAt: now,
    lastActiveAt: now,
    messageCount: 0,
  });
  await writeThreads(root, db);
  return { threadId, db };
}

/**
 * Ensure the active thread exists in the database. If there is no record at
 * all (first run on a legacy slug) seed a "default" thread.
 */
export async function ensureThread(root, threadId) {
  const db = await readThreads(root);
  const found = db.threads.find((t) => t.id === threadId);
  if (found) return { thread: found, db };

  // No matching thread — either the caller asked for an id that vanished or
  // this is a brand-new slug. Seed a default thread and make it active.
  const now = new Date().toISOString();
  const thread = {
    id: threadId,
    name: threadId === 'default' ? 'General' : threadId,
    summary: '',
    createdAt: now,
    lastActiveAt: now,
    messageCount: 0,
  };
  db.threads.push(thread);
  db.activeThreadId = threadId;
  await writeThreads(root, db);
  return { thread, db };
}

/**
 * Change the active thread id persisted on disk.
 */
export async function setActiveThread(root, threadId) {
  const db = await readThreads(root);
  db.activeThreadId = threadId;
  await writeThreads(root, db);
  return db;
}

/**
 * Update the name / summary of a thread (agent can call this through file
 * tools, but a convenience helper keeps the format consistent).
 */
export async function updateThreadMeta(root, threadId, patch) {
  const db = await readThreads(root);
  const thread = db.threads.find((t) => t.id === threadId);
  if (!thread) return null;
  if (patch.name !== undefined) thread.name = String(patch.name).slice(0, 80);
  if (patch.summary !== undefined) thread.summary = String(patch.summary).slice(0, 300);
  thread.lastActiveAt = new Date().toISOString();
  await writeThreads(root, db);
  return thread;
}

/**
 * Build paths that point to the per-thread session directory while keeping
 * the shared workspace.
 */
export function threadAwarePaths(paths, threadId) {
  return {
    ...paths,
    sessions: path.join(paths.root, 'sessions', threadId),
  };
}
