import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { writeJob, replyJob, reactionJob } from '../src/outbox.js';

async function tempOutbox() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wabox-pi-outbox-'));
  return path.join(dir, 'outbox');
}

test('writes a job and leaves no temp files', async () => {
  const outbox = await tempOutbox();
  const target = await writeJob(outbox, { to: '5511', text: 'hi' });
  const files = await fs.readdir(outbox);
  assert.deepEqual(files, [path.basename(target)]);
  const job = JSON.parse(await fs.readFile(target, 'utf8'));
  assert.deepEqual(job, { to: '5511', text: 'hi' });
});

test('rejects empty and targetless jobs', async () => {
  const outbox = await tempOutbox();
  await assert.rejects(() => writeJob(outbox, { to: '5511' }), /at least one/);
  await assert.rejects(() => writeJob(outbox, { text: 'hi' }), /missing "to"/);
});

test('builds quote-reply jobs with group participant', () => {
  const envelope = {
    id: 'ABC',
    from: '120363@g.us',
    participant: '5511@s.whatsapp.net',
  };
  assert.deepEqual(replyJob(envelope, { text: 'ok' }), {
    to: '120363@g.us',
    replyTo: { id: 'ABC', participant: '5511@s.whatsapp.net' },
    text: 'ok',
  });
  assert.equal('files' in replyJob(envelope, { text: 'ok' }), false);
});

test('builds reaction jobs', () => {
  const envelope = { id: 'ABC', from: '5511@s.whatsapp.net' };
  assert.deepEqual(reactionJob(envelope, '👀'), {
    to: '5511@s.whatsapp.net',
    react: { emoji: '👀', messageId: 'ABC' },
  });
});
