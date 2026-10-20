// Scheduled tasks: fire an agent turn in a conversation on a cron schedule,
// without an inbound message, so the agent can send a proactive WhatsApp
// message (or do work and report back).
//
// The Scheduler owns timing and last-run persistence. It does not know how to
// reach a conversation: the daemon supplies `onFire(task)`, which resolves the
// target and enqueues the turn on the conversation's runner.

import fs from 'node:fs/promises';
import path from 'node:path';
import { cronMatches, parseCron } from './cron.js';

const STATE_VERSION = 1;

function validTimezone(timezone) {
  if (!timezone) return true;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
}

// Turn the `tasks` array from config.json into normalized entries. Invalid
// tasks stay in the list with an `error` so `status` can show them; the
// scheduler skips anything with an error.
export function normalizeTasks(rawTasks, { timezone } = {}) {
  if (rawTasks === undefined || rawTasks === null) return [];
  if (!Array.isArray(rawTasks)) throw new Error('"tasks" must be an array');

  const seen = new Set();
  return rawTasks.map((raw, index) => {
    const name = String(raw?.name || '').trim() || `task-${index + 1}`;
    if (seen.has(name)) throw new Error(`duplicate task name: ${name}`);
    seen.add(name);

    const cron = String(raw?.cron || '').trim();
    const prompt = String(raw?.prompt || '').trim();
    const slug = raw?.slug ? String(raw.slug) : null;
    const to = raw?.to ? String(raw.to) : null;
    const tz = raw?.timezone ? String(raw.timezone) : timezone;

    let parsed = null;
    let error = null;
    if (!cron) error = 'missing "cron"';
    else if (!prompt) error = 'missing "prompt"';
    else if (!slug && !to) error = 'missing "slug" or "to"';
    else if (!validTimezone(tz)) error = `unknown timezone: ${tz}`;
    else {
      try {
        parsed = parseCron(cron);
      } catch (err) {
        error = err.message;
      }
    }

    return {
      name,
      enabled: raw?.enabled !== false,
      cron,
      prompt,
      slug,
      to,
      participant: raw?.participant ?? null,
      timezone: tz || null,
      parsed,
      error,
    };
  });
}

export class Scheduler {
  constructor({ tasks, log, stateFile, onFire, tickMs = 20_000, now = () => new Date() }) {
    this.tasks = tasks.filter((task) => !task.error);
    this.invalid = tasks.filter((task) => task.error);
    this.log = log;
    this.stateFile = stateFile;
    this.onFire = onFire;
    this.tickMs = tickMs;
    this.now = now;
    this.lastRun = {};
    this.timer = null;
    this.running = false;
    this.stopped = false;
  }

  async loadState() {
    try {
      const value = JSON.parse(await fs.readFile(this.stateFile, 'utf8'));
      if (value && value.version === STATE_VERSION && value.lastRun) {
        this.lastRun = value.lastRun;
      }
    } catch (err) {
      if (err.code !== 'ENOENT') this.log.warn(`[schedule] cannot read state: ${err.message}`);
    }
  }

  stateSnapshot() {
    return { version: STATE_VERSION, lastRun: this.lastRun };
  }

  async saveState() {
    const tmp = `${this.stateFile}.${process.pid}.tmp`;
    try {
      await fs.mkdir(path.dirname(this.stateFile), { recursive: true });
      await fs.writeFile(tmp, `${JSON.stringify(this.stateSnapshot(), null, 2)}\n`, { mode: 0o600 });
      await fs.rename(tmp, this.stateFile);
    } catch (err) {
      await fs.rm(tmp, { force: true }).catch(() => {});
      this.log.warn(`[schedule] cannot write state: ${err.message}`);
    }
  }

  async start() {
    for (const task of this.invalid) {
      this.log.warn(`[schedule] skipping task "${task.name}": ${task.error}`);
    }
    if (this.tasks.length) {
      const names = this.tasks.map((task) => `${task.name} [${task.cron}${task.timezone ? ` ${task.timezone}` : ''}]`);
      this.log.info(`[schedule] ${this.tasks.length} task(s): ${names.join(', ')}`);
    }
    await this.loadState();
    this.timer = setInterval(() => void this.tick(), this.tickMs);
    this.timer.unref?.();
    await this.tick();
  }

  stop() {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  // One pass: fire every enabled task whose cron matches this minute and that
  // has not already run in it. The minute guard makes a short tick (and a
  // restart inside the same minute) fire a task at most once.
  async tick(now = this.now()) {
    if (this.stopped || this.running) return;
    this.running = true;
    try {
      const minuteKey = now.toISOString().slice(0, 16);
      for (const task of this.tasks) {
        if (!task.enabled || !task.parsed) continue;
        if (this.lastRun[task.name] === minuteKey) continue;
        if (!cronMatches(task.parsed, now, task.timezone)) continue;

        this.lastRun[task.name] = minuteKey;
        await this.saveState();
        this.log.info(`[schedule] firing "${task.name}"`);
        try {
          await this.onFire(task);
        } catch (err) {
          this.log.error(`[schedule] "${task.name}" failed: ${err?.stack || err}`);
        }
      }
    } finally {
      this.running = false;
    }
  }
}
