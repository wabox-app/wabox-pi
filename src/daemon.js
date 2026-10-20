// The daemon: watch wabox's inbox, claim envelopes, and drive one pi session per
// conversation.
//
// Claiming is a rename out of inbox/. That unlink is wabox-core's read-receipt
// signal, so it happens as soon as the envelope has been read into memory — not
// after the agent finishes thinking.

import fs from 'node:fs/promises';
import path from 'node:path';
import chokidar from 'chokidar';
import { readEnvelope } from './envelope.js';
import { conversationKey, slugFor } from './routing.js';
import { ensureConversation, seedWorkspace } from './workspace.js';
import { writeJob, reactionJob } from './outbox.js';
import { moveFile } from './fsutil.js';
import { ConversationAgent } from './agent.js';

class ConversationRunner {
  constructor({ config, log, slug, paths }) {
    this.config = config;
    this.log = log;
    this.slug = slug;
    this.paths = paths;
    this.agent = new ConversationAgent({ config, log, slug, paths });
    this.queue = [];
    this.busy = false;
    this.timer = null;
    this.stopped = false;
    this.idleWaiters = [];
  }

  enqueue(envelope) {
    if (this.stopped) return;
    this.queue.push(envelope);
    this.schedule();
  }

  schedule() {
    if (this.stopped || this.busy || this.timer) return;
    const delay = Math.max(0, this.config.batchWindowMs);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.drain();
    }, delay);
  }

  async drain() {
    if (this.stopped || this.busy) return;
    this.busy = true;
    try {
      while (!this.stopped && this.queue.length) {
        // A batch is whatever accumulated during the debounce window. Messages
        // that arrive mid-turn are handled as the next batch.
        const batch = this.queue.splice(0);
        try {
          await this.agent.handleBatch(batch);
        } catch {
          // handleBatch already logged it. Keep draining: one bad message must
          // not block the conversation forever.
        }
      }
    } finally {
      this.busy = false;
      if (!this.stopped && this.queue.length) this.schedule();
      else this.notifyIdle();
    }
  }

  whenIdle() {
    if (!this.busy && !this.timer && (!this.queue.length || this.stopped)) {
      return Promise.resolve();
    }
    return new Promise((resolve) => this.idleWaiters.push(resolve));
  }

  notifyIdle() {
    const waiters = this.idleWaiters.splice(0);
    for (const resolve of waiters) resolve();
  }

  stop() {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  async dispose() {
    this.stop();
    await this.agent.dispose();
  }
}

async function moveToFailed(config, file, log, reason) {
  try {
    await fs.mkdir(config.failedDir, { recursive: true });
    const base = `${Date.now()}_${path.basename(file)}`;
    await moveFile(file, path.join(config.failedDir, base));
    await fs.writeFile(path.join(config.failedDir, `${base}.error.txt`), `${reason}\n`);
  } catch (err) {
    log.error(`could not archive invalid envelope ${file}: ${err.message}`);
  }
}

async function claimEnvelope(file, config, log) {
  let envelope;
  try {
    envelope = await readEnvelope(file);
  } catch (err) {
    log.error(`bad envelope ${file}: ${err.message}`);
    await moveToFailed(config, file, log, `invalid envelope: ${err.message}`);
    return null;
  }

  const key = conversationKey(envelope, { groupPerParticipant: config.groupPerParticipant });
  const slug = slugFor(key);
  const paths = await ensureConversation(config, slug);

  const stem = path.basename(file, '.json');
  const processed = path.join(paths.processed, `${stem}.json`);

  // The move out of inbox/ is the read receipt. Do it before any slow work.
  try {
    await moveFile(file, processed);
  } catch (err) {
    if (err.code === 'ENOENT') return null; // another process won the race
    throw err;
  }

  if (envelope.media?.file && !envelope.media.error) {
    const name = path.basename(envelope.media.file);
    const from = path.join(config.inboxDir, name);
    const to = path.join(paths.media, name);
    try {
      await moveFile(from, to);
      envelope.media = { ...envelope.media, localPath: to };
    } catch (err) {
      if (err.code !== 'ENOENT') log.warn(`could not stage media ${from}: ${err.message}`);
    }
  }

  await seedWorkspace(config, paths, log);
  return { envelope, slug, paths };
}

export async function startDaemon(config, log) {
  await Promise.all([
    fs.mkdir(config.inboxDir, { recursive: true }),
    fs.mkdir(config.outboxDir, { recursive: true }),
    fs.mkdir(config.stateDir, { recursive: true }),
    fs.mkdir(config.conversationsDir, { recursive: true }),
    fs.mkdir(config.failedDir, { recursive: true }),
  ]);

  const runners = new Map();

  const runnerFor = (slug, paths) => {
    let runner = runners.get(slug);
    if (!runner) {
      runner = new ConversationRunner({ config, log, slug, paths });
      runners.set(slug, runner);
    }
    return runner;
  };

  let stopping = false;

  // Claim files one at a time, in watcher order, so two messages from the same
  // chat cannot be reordered by concurrent async claims. Agent turns still run
  // in parallel across conversations.
  let claimChain = Promise.resolve();

  const handleFile = async (file) => {
    if (stopping) return;
    try {
      const claimed = await claimEnvelope(file, config, log);
      if (!claimed || stopping) return;
      const { envelope, slug, paths } = claimed;

      log.info(
        `[${slug}] claimed ${envelope.id} from ${envelope.pushName || envelope.number || envelope.from}` +
          `${envelope.media ? ` (${envelope.media.type})` : ''}`,
      );

      if (config.ackReact) {
        try {
          await writeJob(config.outboxDir, reactionJob(envelope, config.ackReact));
        } catch (err) {
          log.warn(`[${slug}] ack reaction failed: ${err.message}`);
        }
      }

      runnerFor(slug, paths).enqueue(envelope);
    } catch (err) {
      log.error(`failed to handle ${file}: ${err?.stack || err}`);
    }
  };

  const watcher = chokidar.watch(config.inboxDir, {
    depth: 0, // top level only; media and processed/ live elsewhere
    ignoreInitial: false,
    // wabox publishes envelopes with an atomic rename, so they are complete on
    // `add`. Waiting only widens the window where a fast claim is missed.
  });

  watcher.on('add', (file) => {
    if (!file.endsWith('.json')) return;
    if (path.basename(file).startsWith('.')) return;
    claimChain = claimChain.then(() => handleFile(file));
  });
  watcher.on('error', (err) => log.error(`inbox watcher error: ${err.message}`));

  log.info(`watching ${config.inboxDir}`);
  log.info(`outbox   ${config.outboxDir}`);
  log.info(`state    ${config.stateDir}`);

  let resolveDone;
  const done = new Promise((resolve) => {
    resolveDone = resolve;
  });

  const shutdown = async (signal) => {
    if (stopping) return;
    stopping = true;
    log.info(`received ${signal}, shutting down`);
    await watcher.close().catch(() => {});

    // Let claims that already started finish (so no envelope is half-moved),
    // then stop the runners from accepting more work.
    const claims = claimChain.catch(() => {});
    const claimTimeout = new Promise((resolve) => setTimeout(resolve, 5_000).unref());
    await Promise.race([claims, claimTimeout]);

    for (const runner of runners.values()) runner.stop();

    const drain = Promise.all([...runners.values()].map((r) => r.whenIdle()));
    const timeout = new Promise((resolve) => setTimeout(resolve, 15_000).unref());
    await Promise.race([drain, timeout]);

    await Promise.all([...runners.values()].map((r) => r.dispose()));
    log.info('stopped');
    resolveDone();
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  return { watcher, runners, shutdown, done };
}
