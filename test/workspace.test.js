import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { conversationPaths, rememberIdentity, readIdentity } from '../src/workspace.js';

test('rememberIdentity stores the JID verbatim and readIdentity returns it', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wabox-ws-'));
  const config = { conversationsDir: dir };
  const paths = conversationPaths(config, 'chat-1');
  await fs.mkdir(paths.root, { recursive: true });

  await rememberIdentity(paths, {
    from: '123@lid',
    participant: '999@s.whatsapp.net',
    pushName: 'Alice',
    number: '999',
  });
  const identity = await readIdentity(paths);
  assert.equal(identity.from, '123@lid');
  assert.equal(identity.participant, '999@s.whatsapp.net');
  assert.equal(identity.pushName, 'Alice');

  await fs.rm(dir, { recursive: true, force: true });
});

test('readIdentity returns null when nothing was recorded', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wabox-ws-'));
  const paths = conversationPaths({ conversationsDir: dir }, 'chat-2');
  await fs.mkdir(paths.root, { recursive: true });
  assert.equal(await readIdentity(paths), null);
  await fs.rm(dir, { recursive: true, force: true });
});
