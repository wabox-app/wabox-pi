import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { readEnvelope, replyTarget, replyTo } from '../src/envelope.js';

async function tempFile(contents) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wabox-pi-env-'));
  const file = path.join(dir, 'msg.json');
  await fs.writeFile(file, contents);
  return file;
}

test('reads a valid envelope', async () => {
  const file = await tempFile(JSON.stringify({ id: 'X', from: 'a@s.whatsapp.net' }));
  const envelope = await readEnvelope(file);
  assert.equal(envelope.id, 'X');
});

test('rejects invalid JSON and missing fields', async () => {
  const bad = await tempFile('{nope');
  await assert.rejects(() => readEnvelope(bad), /invalid JSON/);

  const noFrom = await tempFile('{"id":"X"}');
  await assert.rejects(() => readEnvelope(noFrom), /missing "from"/);

  const noId = await tempFile('{"from":"a@s.whatsapp.net"}');
  await assert.rejects(() => readEnvelope(noId), /missing "id"/);
});

test('reply targets the inbound JID verbatim', () => {
  assert.equal(replyTarget({ from: '123@lid' }), '123@lid');
  assert.deepEqual(replyTo({ id: 'X' }), { id: 'X' });
  assert.deepEqual(replyTo({ id: 'X', participant: 'p@s.whatsapp.net' }), {
    id: 'X',
    participant: 'p@s.whatsapp.net',
  });
});
