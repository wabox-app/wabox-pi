import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createSendTool } from '../src/tools.js';

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wabox-pi-tool-'));
  const workspace = path.join(root, 'workspace');
  const outboxDir = path.join(root, 'outbox');
  await fs.mkdir(workspace, { recursive: true });
  await fs.mkdir(outboxDir, { recursive: true });
  return { root, workspace, outboxDir };
}

function turnFor(workspace, envelope = { id: 'ABC', from: '5511@s.whatsapp.net' }) {
  return { envelope, workspace, sentContent: false, sentAny: false, sent: [] };
}

test('sends text with a quote by default', async () => {
  const { workspace, outboxDir } = await fixture();
  const turn = turnFor(workspace);
  const tool = createSendTool({ config: { outboxDir }, turn });

  const result = await tool.execute('call-1', { text: 'hello' });
  assert.match(result.content[0].text, /text/);
  assert.equal(turn.sentContent, true);

  const [file] = await fs.readdir(outboxDir);
  const job = JSON.parse(await fs.readFile(path.join(outboxDir, file), 'utf8'));
  assert.deepEqual(job, {
    to: '5511@s.whatsapp.net',
    replyTo: { id: 'ABC' },
    text: 'hello',
  });
});

test('resolves relative files against the workspace and checks they exist', async () => {
  const { workspace, outboxDir } = await fixture();
  await fs.writeFile(path.join(workspace, 'report.pdf'), 'pdf');
  const turn = turnFor(workspace);
  const tool = createSendTool({ config: { outboxDir }, turn });

  await tool.execute('call-1', { text: 'attached', files: ['report.pdf'] });
  const [file] = await fs.readdir(outboxDir);
  const job = JSON.parse(await fs.readFile(path.join(outboxDir, file), 'utf8'));
  assert.deepEqual(job.files, [path.join(workspace, 'report.pdf')]);

  await assert.rejects(
    () => tool.execute('call-2', { files: ['missing.pdf'] }),
    /file not found/,
  );
});

test('a reaction-only send does not suppress the auto reply', async () => {
  const { workspace, outboxDir } = await fixture();
  const turn = turnFor(workspace);
  const tool = createSendTool({ config: { outboxDir }, turn });

  await tool.execute('call-1', { react: { emoji: '👀' } });
  assert.equal(turn.sentContent, false);
  assert.equal(turn.sentAny, true);
});

test('rejects a send with nothing in it', async () => {
  const { workspace, outboxDir } = await fixture();
  const tool = createSendTool({ config: { outboxDir }, turn: turnFor(workspace) });
  await assert.rejects(() => tool.execute('call', {}), /nothing to send/);
});
