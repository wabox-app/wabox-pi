// Map an inbox envelope to a logical conversation and a filesystem-safe slug.
//
// A DM is keyed by the chat JID verbatim (`@s.whatsapp.net` or `@lid`). Replying
// on a different identity than the one the message arrived on desyncs the
// recipient's Signal session, so we never normalize it here.

import crypto from 'node:crypto';

export function conversationKey(envelope, { groupPerParticipant = false } = {}) {
  const from = envelope.from;
  if (from?.endsWith('@g.us') && groupPerParticipant && envelope.participant) {
    return `${from}|${envelope.participant}`;
  }
  return from;
}

export function slugFor(key) {
  const safe = String(key)
    .replace(/@(s\.whatsapp\.net|lid|g\.us|broadcast|newsletter)/g, '')
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  const hash = crypto.createHash('sha1').update(String(key)).digest('hex').slice(0, 10);
  return `${safe || 'chat'}-${hash}`;
}

export function conversationLabel(envelope) {
  const who = envelope.pushName || envelope.number || envelope.from;
  if (envelope.from?.endsWith('@g.us')) {
    return envelope.participant ? `${who} (group)` : `group ${envelope.from}`;
  }
  return who;
}
