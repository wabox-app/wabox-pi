import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createGenerateImageTool } from '../src/generate_image.js';

function turnFor(mediaDir, envelope = { id: 'ABC', from: '5511@s.whatsapp.net' }) {
  return { envelope, mediaDir, sentContent: false, sentAny: false, sent: [] };
}

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wabox-pi-img-'));
  const mediaDir = path.join(root, 'media');
  await fs.mkdir(mediaDir, { recursive: true });
  return { root, mediaDir };
}

test('disabled imageGen throws', async () => {
  const { mediaDir } = await fixture();
  const turn = turnFor(mediaDir);
  const tool = createGenerateImageTool({ config: { imageGen: { enabled: false } }, turn });
  await assert.rejects(tool.execute('c1', { prompt: 'a cat' }), /disabled/);
});

test('missing imageGen throws', async () => {
  const { mediaDir } = await fixture();
  const turn = turnFor(mediaDir);
  const tool = createGenerateImageTool({ config: {}, turn });
  await assert.rejects(tool.execute('c1', { prompt: 'a cat' }), /not configured/);
});

test('pollinations saves file', async () => {
  const { mediaDir } = await fixture();
  const turn = turnFor(mediaDir);
  const buf = Buffer.from([1, 2, 3, 4]);
  const fetchImpl = async () => ({ ok: true, arrayBuffer: async () => buf.buffer });
  const tool = createGenerateImageTool({ config: { imageGen: { provider: 'pollinations', enabled: true } }, turn, fetchImpl });
  const result = await tool.execute('c1', { prompt: 'a cat' });
  assert.match(result.content[0].text, /Image generated/);
  const files = await fs.readdir(mediaDir);
  assert.equal(files.length, 1);
});
