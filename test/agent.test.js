import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ConversationAgent } from '../src/agent.js';

const silent = { debug() {}, info() {}, warn() {}, error() {} };

async function agentFixture(overrides = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wabox-agent-'));
  const outbox = path.join(dir, 'outbox');
  await fs.mkdir(outbox, { recursive: true });
  const config = {
    outboxDir: outbox,
    autoReply: true,
    errorReply: true,
    turnFeedbackMs: 0,
    turnFeedbackReact: '⏳',
    turnTimeoutMs: 0,
    contextCompactRatio: 0,
    contextCompactWarnTokens: 0,
    ...overrides,
  };
  const agent = new ConversationAgent({
    config,
    log: silent,
    slug: 'slug',
    paths: { workspace: path.join(dir, 'ws'), sessions: path.join(dir, 's'), media: path.join(dir, 'm') },
  });
  return { dir, outbox, config, agent };
}

async function outboxJobs(outbox) {
  const names = (await fs.readdir(outbox).catch(() => [])).filter((n) => n.endsWith('.json'));
  return Promise.all(
    names.map(async (name) => JSON.parse(await fs.readFile(path.join(outbox, name), 'utf8'))),
  );
}

test('a slow turn reacts to the inbound message', async () => {
  const { dir, outbox, agent } = await agentFixture({ turnFeedbackMs: 20 });
  const envelope = { id: 'E1', from: '1@lid' };
  const feedback = agent.startTurnFeedback(envelope);
  await new Promise((r) => setTimeout(r, 120));
  feedback.clear();

  const jobs = await outboxJobs(outbox);
  assert.equal(jobs.length, 1);
  assert.deepEqual(jobs[0].react, { emoji: '⏳', messageId: 'E1' });
  assert.equal(jobs[0].to, '1@lid');
  await fs.rm(dir, { recursive: true, force: true });
});

test('no reaction when the turn is quick or the feedback is off', async () => {
  const { dir, outbox, agent } = await agentFixture({ turnFeedbackMs: 60_000 });
  const feedback = agent.startTurnFeedback({ id: 'E1', from: '1@lid' });
  feedback.clear();
  await new Promise((r) => setTimeout(r, 60));
  assert.equal((await outboxJobs(outbox)).length, 0);
  await fs.rm(dir, { recursive: true, force: true });
});

test('a turn that runs too long is aborted', async () => {
  const { dir, agent } = await agentFixture({ turnTimeoutMs: 20 });
  let aborted = false;
  const session = { abort: async () => { aborted = true; } };
  const timeout = agent.startTurnTimeout(session, { id: 'E1', from: '1@lid' });
  await new Promise((r) => setTimeout(r, 120));
  timeout.clear();
  assert.equal(aborted, true);
  assert.equal(agent.turnTimedOut, true);
  await fs.rm(dir, { recursive: true, force: true });
});

test('the context is compacted when it passes the configured share', async () => {
  const { dir, agent } = await agentFixture({ contextCompactRatio: 0.5 });
  let compacted = false;
  const session = {
    model: { contextWindow: 1000 },
    messages: [{ role: 'user', content: 'x'.repeat(4000) }],
    compact: async () => {
      compacted = true;
    },
  };
  await agent.maybeCompact(session);
  assert.equal(compacted, true);
  await fs.rm(dir, { recursive: true, force: true });
});

test('a small context is left alone', async () => {
  const { dir, agent } = await agentFixture({ contextCompactRatio: 0.5 });
  let compacted = false;
  const session = {
    model: { contextWindow: 1_000_000 },
    messages: [{ role: 'user', content: 'oi' }],
    compact: async () => {
      compacted = true;
    },
  };
  await agent.maybeCompact(session);
  assert.equal(compacted, false);
  await fs.rm(dir, { recursive: true, force: true });
});

async function imageAgentFixture(vision) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wabox-agent-vision-'));
  const media = path.join(dir, 'media');
  await fs.mkdir(media, { recursive: true });
  const file = path.join(media, 'photo.jpg');
  await fs.writeFile(file, 'fake-image');
  const script = path.join(dir, 'describe.sh');
  await fs.writeFile(script, `#!/bin/sh\necho "descrição de $1"\n`, { mode: 0o755 });

  const config = {
    vision: { command: `'${script}'`, mode: 'auto', ...vision },
  };
  const agent = new ConversationAgent({
    config,
    log: silent,
    slug: 'slug',
    paths: { workspace: path.join(dir, 'ws'), sessions: path.join(dir, 's'), media },
  });
  return { dir, file, agent, cleanup: () => fs.rm(dir, { recursive: true, force: true }) };
}

test('describeImages fills a description for a text-only model and writes a sidecar', async () => {
  const { file, agent, cleanup } = await imageAgentFixture();
  try {
    const envelope = { media: { type: 'image', localPath: file, mimetype: 'image/jpeg' } };
    await agent.describeImages({ model: { input: ['text'] } }, [envelope]);

    assert.match(envelope.media.description, /descrição de/);
    assert.equal(envelope.media.descriptionModel, 'command');
    const sidecar = await fs.readFile(`${file}.description.txt`, 'utf8');
    assert.match(sidecar, /descrição de/);
  } finally {
    await cleanup();
  }
});

test('describeImages leaves an image-capable model alone in auto mode', async () => {
  const { file, agent, cleanup } = await imageAgentFixture();
  try {
    const envelope = { media: { type: 'image', localPath: file } };
    await agent.describeImages({ model: { input: ['text', 'image'] } }, [envelope]);
    assert.equal(envelope.media.description, undefined);
    await assert.rejects(() => fs.stat(`${file}.description.txt`), /ENOENT/);
  } finally {
    await cleanup();
  }
});

test('describeImages records a failure without throwing', async () => {
  const { file, agent, cleanup } = await imageAgentFixture({ command: 'false' });
  try {
    const envelope = { media: { type: 'image', localPath: file } };
    await agent.describeImages({ model: { input: ['text'] } }, [envelope]);
    assert.match(envelope.media.descriptionError, /vision command exited/);
  } finally {
    await cleanup();
  }
});

test('transcribeBatch falls back to the next backend', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wabox-agent-stt-'));
  const media = path.join(dir, 'media');
  await fs.mkdir(media, { recursive: true });
  const file = path.join(media, 'note.ogg');
  await fs.writeFile(file, 'AUDIO-BYTES');

  const agent = new ConversationAgent({
    config: {
      transcription: {
        command: 'false',
        fallback: [{ command: 'cat' }],
      },
    },
    log: silent,
    slug: 'slug',
    paths: { workspace: path.join(dir, 'ws'), sessions: path.join(dir, 's'), media },
  });

  try {
    const envelope = { media: { type: 'audio', localPath: file, mimetype: 'audio/ogg' } };
    await agent.transcribeBatch([envelope]);
    assert.equal(envelope.media.transcript, 'AUDIO-BYTES');
    assert.equal(envelope.media.transcriptModel, 'command');
    assert.equal(await fs.readFile(`${file}.txt`, 'utf8'), 'AUDIO-BYTES\n');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
