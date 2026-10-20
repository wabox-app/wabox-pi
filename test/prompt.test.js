import test from 'node:test';
import assert from 'node:assert/strict';
import { buildTurnPrompt } from '../src/prompt.js';

const base = {
  id: 'ABC123',
  from: '5511999998888@s.whatsapp.net',
  number: '5511999998888',
  participant: null,
  pushName: 'Alice',
  timestamp: '2026-06-03T09:25:34.000Z',
  text: '',
  media: null,
  quoted: null,
  mentionedMe: false,
};

test('renders sender, timestamp, and text', () => {
  const prompt = buildTurnPrompt([{ ...base, text: 'hello there' }]);
  assert.match(prompt, /Alice \(5511999998888\)/);
  assert.match(prompt, /direct message/);
  assert.match(prompt, /2026-06-03T09:25:34.000Z/);
  assert.match(prompt, /Message id: ABC123/);
  assert.match(prompt, /hello there/);
});

test('renders group context, mentions, and quotes', () => {
  const prompt = buildTurnPrompt([
    {
      ...base,
      from: '1203630@g.us',
      participant: '5511999998888@s.whatsapp.net',
      text: 'look',
      mentionedMe: true,
      quoted: { fromMe: true, text: 'earlier' },
    },
  ]);
  assert.match(prompt, /group 1203630@g\.us/);
  assert.match(prompt, /@-mentioned/);
  assert.match(prompt, /one of your messages: "earlier"/);
});

test('renders a local attachment path and media-only message', () => {
  const prompt = buildTurnPrompt([
    {
      ...base,
      media: {
        type: 'image',
        file: 'photo.jpg',
        localPath: '/state/conversations/x/media/photo.jpg',
        mimetype: 'image/jpeg',
        originalName: 'IMG_1.jpg',
      },
    },
  ]);
  assert.match(prompt, /Attachment: image/);
  assert.match(prompt, /saved at \/state\/conversations\/x\/media\/photo\.jpg/);
  assert.match(prompt, /original name: IMG_1\.jpg/);
  assert.match(prompt, /attachment only/);
});

test('batches several envelopes into one prompt', () => {
  const prompt = buildTurnPrompt([
    { ...base, id: 'A', text: 'first' },
    { ...base, id: 'B', text: 'second' },
  ]);
  assert.match(prompt, /--- Message 1 ---/);
  assert.match(prompt, /--- Message 2 ---/);
  assert.match(prompt, /first/);
  assert.match(prompt, /second/);
});
