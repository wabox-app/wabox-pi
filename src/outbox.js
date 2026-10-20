// Atomic outbox writer.
//
// wabox-core watches outbox/ at depth 0 and sends any `*.json` immediately, so a
// half-written job would be picked up (and likely fail). Write to a dot-prefixed
// temp name *without* a .json suffix, then rename into place. Rename is atomic
// on the same filesystem and produces exactly one `add` event for the final name.

import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

let counter = 0;

function jobName(prefix = 'wabox-pi') {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const rand = crypto.randomBytes(4).toString('hex');
  return `${prefix}-${stamp}-${process.pid}-${counter++}-${rand}.json`;
}

export async function writeJob(outboxDir, job, { filename } = {}) {
  if (!job || typeof job !== 'object') throw new Error('job must be an object');
  if (!job.to) throw new Error('job missing "to"');
  if (!job.text && !job.files?.length && !job.react) {
    throw new Error('job needs at least one of text, files, react');
  }

  await fs.mkdir(outboxDir, { recursive: true });
  const name = filename || jobName();
  const tmp = path.join(outboxDir, `.wabox-pi-${process.pid}-${Date.now()}-${crypto.randomUUID()}`);
  const target = path.join(outboxDir, name);
  try {
    await fs.writeFile(tmp, `${JSON.stringify(job, null, 2)}\n`, { mode: 0o600 });
    await fs.rename(tmp, target);
  } catch (err) {
    await fs.rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
  return target;
}

export function reactionJob(envelope, emoji) {
  return {
    to: envelope.from,
    react: {
      emoji,
      messageId: envelope.id,
      ...(envelope.participant ? { participant: envelope.participant } : {}),
    },
  };
}

export function replyJob(envelope, { text, files } = {}) {
  const job = {
    to: envelope.from,
    replyTo: {
      id: envelope.id,
      ...(envelope.participant ? { participant: envelope.participant } : {}),
    },
  };
  if (text) job.text = text;
  if (files?.length) job.files = files;
  return job;
}
