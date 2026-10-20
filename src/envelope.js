// Inbox envelope parsing. The shape is wabox-core's public consumer contract;
// see ../wabox-core/INTEGRATION.md. Fields added by newer cores are optional.

import fs from 'node:fs/promises';

export async function readEnvelope(file) {
  const raw = await fs.readFile(file, 'utf8');
  let value;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error('invalid JSON');
  }
  if (!value || typeof value !== 'object') throw new Error('envelope is not an object');
  if (typeof value.id !== 'string' || !value.id) throw new Error('envelope missing "id"');
  if (typeof value.from !== 'string' || !value.from) throw new Error('envelope missing "from"');
  return value;
}

export function replyTarget(envelope) {
  // The chat JID, verbatim. wabox-core routes this to the right Signal session.
  return envelope.from;
}

export function replyTo(envelope) {
  const value = { id: envelope.id };
  if (envelope.participant) value.participant = envelope.participant;
  return value;
}
