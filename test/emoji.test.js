import test from 'node:test';
import assert from 'node:assert/strict';
import { isEmojiOnly, isEmptyEnvelope, isNoopEnvelope } from '../src/emoji.js';

test('isEmojiOnly accepts single emoji, skin tones, flags and keycaps', () => {
  assert.equal(isEmojiOnly('👍'), true);
  assert.equal(isEmojiOnly('👍🏽'), true);
  assert.equal(isEmojiOnly('❤️'), true);
  assert.equal(isEmojiOnly('😂🎉'), true);
  assert.equal(isEmojiOnly('🇧🇷'), true);
  assert.equal(isEmojiOnly('1️⃣'), true);
  assert.equal(isEmojiOnly('  👍  '), true);
});

test('isEmojiOnly rejects mixed text and plain words', () => {
  assert.equal(isEmojiOnly('ok 👍'), false);
  assert.equal(isEmojiOnly('👍 ok'), false);
  assert.equal(isEmojiOnly('ok'), false);
  assert.equal(isEmojiOnly(''), false);
  assert.equal(isEmojiOnly('   '), false);
  assert.equal(isEmojiOnly(null), false);
});

test('isEmptyEnvelope detects envelopes with nothing to answer', () => {
  assert.equal(isEmptyEnvelope({ text: '' }), true);
  assert.equal(isEmptyEnvelope({ text: '   ' }), true);
  assert.equal(isEmptyEnvelope({ text: '', media: null }), true);
  assert.equal(isEmptyEnvelope({ text: 'oi' }), false);
  assert.equal(isEmptyEnvelope({ text: '', media: { type: 'image' } }), false);
  assert.equal(isEmptyEnvelope({ text: '', quoted: { id: 'x' } }), false);
});

test('isNoopEnvelope classifies the two kinds of no-op message', () => {
  assert.equal(isNoopEnvelope({ text: '', media: null }), 'empty');
  assert.equal(isNoopEnvelope({ text: '👍' }), 'emoji-only');
  assert.equal(isNoopEnvelope({ text: 'olá' }), null);
});

test('isNoopEnvelope honours the flags', () => {
  assert.equal(isNoopEnvelope({ text: '👍' }, { ignoreEmojiOnly: false }), null);
  assert.equal(isNoopEnvelope({ text: '' }, { ignoreEmpty: false }), null);
  // A message with media is never a no-op.
  assert.equal(isNoopEnvelope({ text: '', media: { type: 'image' } }), null);
});
