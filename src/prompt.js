// Turn prompt construction (pure, so it is easy to test).
//
// One agent turn may cover several envelopes when a WhatsApp burst is batched.
// The last envelope is the "current" one for reply/reaction targeting.

const MEDIA_NOUN = {
  image: 'image',
  video: 'video',
  audio: 'audio',
  document: 'document',
  sticker: 'sticker',
};

function mediaLine(media) {
  if (!media) return null;
  if (media.error) return `Attachment: ${media.type || 'media'} (download failed: ${media.error})`;
  const where = media.localPath || media.file;
  const bits = [
    `Attachment: ${MEDIA_NOUN[media.type] || media.type || 'file'}`,
    where ? `saved at ${where}` : null,
    media.mimetype ? media.mimetype : null,
    media.originalName ? `original name: ${media.originalName}` : null,
  ].filter(Boolean);
  return bits.join(' — ');
}

function one(envelope, index) {
  const isGroup = envelope.from?.endsWith('@g.us');
  const sender = envelope.pushName || envelope.number || envelope.from;
  const lines = [];

  lines.push(`--- Message ${index + 1} ---`);
  lines.push(`From: ${sender}${envelope.number ? ` (${envelope.number})` : ''}`);
  lines.push(`Chat: ${isGroup ? `group ${envelope.from}` : 'direct message'}`);
  if (envelope.timestamp) lines.push(`Sent: ${envelope.timestamp}`);
  lines.push(`Message id: ${envelope.id}`);
  if (envelope.mentionedMe) lines.push('You were @-mentioned in this message.');
  if (envelope.quoted) {
    const who = envelope.quoted.fromMe ? 'one of your messages' : 'an earlier message';
    lines.push(`This is a reply to ${who}: "${envelope.quoted.text || ''}"`);
  }

  const media = mediaLine(envelope.media);
  if (media) lines.push(media);

  const text = String(envelope.text || '').trim();
  lines.push(text ? `Text:\n${text}` : 'Text: (none — attachment only)');
  return lines.join('\n');
}

export function buildTurnPrompt(envelopes) {
  const body = envelopes.map(one).join('\n\n');
  return [
    'A WhatsApp message arrived. Respond to the user as yourself, in their language.',
    '',
    body,
    '',
    'Reply with the wabox_send tool. If you do not call it, your final text is sent automatically.',
  ].join('\n');
}
