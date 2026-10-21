// Messages with nothing to respond to.
//
// Two shapes reach the inbox that carry no intent:
//
//   - a WhatsApp *reaction* (👍 on the agent's message): wabox-core's
//     `extractText` only reads conversation/extendedTextMessage/captions, so a
//     reaction arrives as an envelope with no text and no media;
//   - a message whose text is only emoji(s) ("👍", "🇧🇷", "1️⃣").
//
// Both are acknowledged by the pickup reaction and then dropped: the agent is
// not called, and no reply is sent.

const segmenter = new Intl.Segmenter('und', { granularity: 'grapheme' });

const EXTENDED_PICTOGRAPHIC = /\p{Extended_Pictographic}/u;

function isEmojiCluster(cluster) {
  const codePoints = [...cluster].map((char) => char.codePointAt(0));

  // Flag: a pair of regional indicators.
  if (codePoints.length === 2 && codePoints.every((cp) => cp >= 0x1f1e6 && cp <= 0x1f1ff)) {
    return true;
  }
  // Keycap: "1️⃣" is a digit plus U+20E3.
  if (codePoints.includes(0x20e3)) return true;
  // Everything else: a pictograph, with any skin tone / variation selector.
  return EXTENDED_PICTOGRAPHIC.test(cluster);
}

// True when the text carries nothing but emoji. Mixed text ("ok 👍") is not
// emoji-only: it has intent and deserves an answer.
export function isEmojiOnly(text) {
  const trimmed = String(text ?? '').trim();
  if (!trimmed) return false;

  let sawEmoji = false;
  for (const { segment } of segmenter.segment(trimmed)) {
    if (!isEmojiCluster(segment)) return false;
    sawEmoji = true;
  }
  return sawEmoji;
}

// An envelope with no text, no media and no quote carries nothing to answer.
export function isEmptyEnvelope(envelope) {
  const text = String(envelope?.text ?? '').trim();
  if (text) return false;
  if (envelope?.media) return false;
  if (envelope?.quoted) return false;
  return true;
}

// Should this envelope be dropped without a reply?
export function isNoopEnvelope(envelope, { ignoreEmojiOnly = true, ignoreEmpty = true } = {}) {
  if (ignoreEmpty && isEmptyEnvelope(envelope)) return 'empty';
  if (ignoreEmojiOnly && isEmojiOnly(envelope?.text)) return 'emoji-only';
  return null;
}
