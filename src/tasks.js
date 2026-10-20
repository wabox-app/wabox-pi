// Chat-created scheduled jobs.
//
// Config tasks live in config.json and are fixed for the process lifetime.
// Jobs created over WhatsApp (via /schedule) are stored here so they survive
// restarts and can be added or removed without touching the operator's config.

import fs from 'node:fs/promises';
import path from 'node:path';
import { normalizeTasks } from './schedule.js';

const STATE_VERSION = 1;
const MAX_DYNAMIC_TASKS = 100;

// A short, filesystem-safe, human-readable name derived from the prompt. The
// name is how a job is removed, so keep it stable and unique among existing.
export function jobName(prompt, taken = new Set()) {
  const base =
    String(prompt || '')
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .split('-')
      .filter(Boolean)
      .slice(0, 3)
      .join('-')
      .slice(0, 32) || 'job';
  let name = base;
  let suffix = 2;
  while (taken.has(name)) name = `${base}-${suffix++}`;
  return name;
}

// Pick only the fields a task store should persist (no parsed sets, no errors).
export function storedTask(task) {
  return {
    name: task.name,
    slug: task.slug ?? null,
    to: task.to ?? null,
    participant: task.participant ?? null,
    cron: task.cron,
    timezone: task.timezone ?? null,
    prompt: task.prompt,
    enabled: task.enabled !== false,
    silent: task.silent === true,
    source: 'chat',
  };
}

export class TaskStore {
  constructor({ file, log, timezone }) {
    this.file = file;
    this.log = log;
    this.timezone = timezone;
    this.tasks = [];
  }

  async load() {
    try {
      const value = JSON.parse(await fs.readFile(this.file, 'utf8'));
      const list = Array.isArray(value) ? value : value?.tasks;
      this.tasks = Array.isArray(list) ? list.filter((task) => task && task.name) : [];
      // Keep the last entry for a duplicated name so normalizeTasks never throws.
      const byName = new Map();
      for (const task of this.tasks) byName.set(task.name, task);
      this.tasks = [...byName.values()];
    } catch (err) {
      if (err.code !== 'ENOENT') this.log?.warn(`[jobs] cannot read ${this.file}: ${err.message}`);
      this.tasks = [];
    }
    return this.tasks;
  }

  // Validated tasks for the scheduler. A malformed store must not take the
  // scheduler down, so any error yields no dynamic tasks (and a warning).
  normalized() {
    try {
      return normalizeTasks(this.tasks, { timezone: this.timezone });
    } catch (err) {
      this.log?.warn(`[jobs] ignoring ${this.file}: ${err.message}`);
      return [];
    }
  }

  async persist() {
    const tmp = `${this.file}.${process.pid}.tmp`;
    try {
      await fs.mkdir(path.dirname(this.file), { recursive: true });
      await fs.writeFile(
        tmp,
        `${JSON.stringify({ version: STATE_VERSION, tasks: this.tasks }, null, 2)}\n`,
        { mode: 0o600 },
      );
      await fs.rename(tmp, this.file);
    } catch (err) {
      await fs.rm(tmp, { force: true }).catch(() => {});
      throw err;
    }
  }

  async add(task) {
    if (this.tasks.length >= MAX_DYNAMIC_TASKS) {
      throw new Error(`too many scheduled jobs (max ${MAX_DYNAMIC_TASKS})`);
    }
    this.tasks.push(task);
    try {
      await this.persist();
    } catch (err) {
      this.tasks.pop();
      throw err;
    }
    return task;
  }

  async remove(name) {
    const next = this.tasks.filter((task) => task.name !== name);
    if (next.length === this.tasks.length) return false;
    const previous = this.tasks;
    this.tasks = next;
    try {
      await this.persist();
    } catch (err) {
      this.tasks = previous;
      throw err;
    }
    return true;
  }

  has(name) {
    return this.tasks.some((task) => task.name === name);
  }
}
