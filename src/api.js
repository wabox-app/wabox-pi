// Dashboard data layer.
//
// Everything here works against the harness state on disk (and the config
// file), so the dashboard can run standalone or inside the daemon. Nothing in
// this module starts a process or opens an inbox; mutations are limited to the
// config file, a conversation's session files, and its workspace.

import fs from 'node:fs/promises';
import path from 'node:path';
import {
  CONVERSATION_KEYS,
  configFilePath,
  conversationConfig,
  normalizeVision,
} from './config.js';
import { conversationPaths, readIdentity } from './workspace.js';
import { normalizeTasks } from './schedule.js';
import { nextCronDate } from './cron.js';

const MAX_READ_BYTES = 512 * 1024;
const MAX_TRANSCRIPT_BYTES = 8 * 1024 * 1024;
const MAX_WORKSPACE_FILES = 2000;
const SESSION_TAIL = 500;

// Conversation slugs are filenames under `conversations/`. Reject anything that
// is not one, so a URL cannot walk out of the state dir or poison
// `conversations.__proto__`.
const SLUG_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/;
const RESERVED_SLUGS = new Set(['__proto__', 'constructor', 'prototype']);

function assertSlug(slug) {
  const value = String(slug ?? '');
  if (!SLUG_RE.test(value) || RESERVED_SLUGS.has(value)) {
    const err = new Error(`invalid conversation slug: ${value}`);
    err.statusCode = 400;
    throw err;
  }
  return value;
}

// Read the end of a file without loading gigabytes of session history. A
// partial first line is dropped so the caller only sees complete JSONL rows.
async function readTail(file, maxBytes) {
  const stat = await fs.stat(file);
  if (stat.size <= maxBytes) return fs.readFile(file, 'utf8');
  const handle = await fs.open(file, 'r');
  try {
    const length = Math.min(maxBytes, stat.size);
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, stat.size - length);
    const text = buffer.toString('utf8');
    return text.slice(text.indexOf('\n') + 1);
  } finally {
    await handle.close();
  }
}

// Fields the dashboard may write, with the coercion applied before persisting.
// Anything not listed is rejected: config.json is the operator's file.
const EDITABLE = {
  workspace: 'string',
  modelProvider: 'string',
  model: 'string',
  thinkingLevel: 'string',
  systemPrompt: 'text',
  turnFeedbackMs: 'int',
  turnFeedbackReact: 'string',
  turnTimeoutMs: 'int',
  ignoreEmojiOnly: 'bool',
  ignoreEmpty: 'bool',
  logTokens: 'bool',
  contextCompactRatio: 'ratio',
  contextCompactWarnTokens: 'int',
  jail: 'bool',
  sandboxBash: 'string',
  sandboxNetwork: 'bool',
  sandboxBashBin: 'string',
  sandboxDenyRead: 'list',
  sandboxAllowRead: 'list',
  tools: 'list',
  excludeTools: 'list',
  autoReply: 'bool',
  errorReply: 'bool',
  ackReact: 'string',
  batchWindowMs: 'int',
  workspaceTemplate: 'string',
  imageGen: 'object',
  vision: 'object',
};

// Instance-level keys echoed to the UI so the operator can see what a
// conversation inherits. Read-only: instance config is edited by hand.
const INSTANCE_VIEW = [
  'inboxDir',
  'outboxDir',
  'stateDir',
  'logFile',
  'batchWindowMs',
  'ackReact',
  'autoReply',
  'errorReply',
  'groupPerParticipant',
  'tools',
  'excludeTools',
  'logTokens',
  'ignoreEmojiOnly',
  'ignoreEmpty',
  'modelProvider',
  'model',
  'thinkingLevel',
  'turnFeedbackMs',
  'turnFeedbackReact',
  'turnTimeoutMs',
  'contextCompactRatio',
  'contextCompactWarnTokens',
  'jail',
  'sandboxBash',
  'sandboxNetwork',
  'sandboxBashBin',
  'sandboxDenyRead',
  'sandboxAllowRead',
  'workspaceTemplate',
  'imageGen',
  'vision',
  'logLevel',
  'timezone',
  'threads',
];

function bool(value) {
  if (typeof value === 'boolean') return value;
  return !['0', 'false', 'no', 'off', ''].includes(String(value).toLowerCase());
}

function int(value) {
  const n = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(n) ? n : null;
}

function ratio(value) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 && n <= 1 ? n : null;
}

function list(value) {
  if (Array.isArray(value)) return value.map(String).map((s) => s.trim()).filter(Boolean);
  if (typeof value === 'string') {
    return value.split(',').map((s) => s.trim()).filter(Boolean);
  }
  return null;
}

// Coerce a single override value. Returns `{ ok, value }`; a null value means
// "remove the override and inherit the instance setting".
export function coerceOverride(key, raw) {
  const type = EDITABLE[key];
  if (!type) return { ok: false, error: `unknown setting: ${key}` };
  if (raw === null || raw === undefined || raw === '') return { ok: true, value: null };

  switch (type) {
    case 'bool':
      return { ok: true, value: bool(raw) };
    case 'int': {
      const value = int(raw);
      return value === null ? { ok: false, error: `${key} must be an integer` } : { ok: true, value };
    }
    case 'ratio': {
      const value = ratio(raw);
      return value === null ? { ok: false, error: `${key} must be between 0 and 1` } : { ok: true, value };
    }
    case 'list': {
      const value = list(raw);
      return value === null ? { ok: false, error: `${key} must be a list` } : { ok: true, value };
    }
    case 'object':
      return { ok: true, value: typeof raw === 'object' ? raw : null };
    default:
      return { ok: true, value: String(raw) };
  }
}

// Build a partial override object from a flat patch. Unknown keys and invalid
// values are reported instead of silently dropped.
export function coerceOverrides(patch) {
  const out = {};
  const errors = [];
  for (const [key, raw] of Object.entries(patch ?? {})) {
    const { ok, value, error } = coerceOverride(key, raw);
    if (!ok) {
      errors.push(error);
      continue;
    }
    out[key] = value;
  }
  return { overrides: out, errors };
}

function redact(value) {
  if (!value || typeof value !== 'object') return value;
  const clone = JSON.parse(JSON.stringify(value));
  for (const obj of [
    clone,
    clone.transcription,
    clone.web?.fetch,
    clone.web?.search,
    clone.imageGen,
    clone.vision,
    clone.router,
  ]) {
    if (!obj || typeof obj !== 'object') continue;
    for (const key of ['apiKey', 'apiKeyFile', 'apiKeyEnv', 'token', 'password', 'secret']) {
      if (obj[key] !== undefined && obj[key] !== null && obj[key] !== '') obj[key] = '[set]';
    }
  }
  return clone;
}

function pick(source, keys) {
  const out = {};
  for (const key of keys) {
    if (source?.[key] !== undefined) out[key] = source[key];
  }
  return out;
}

async function readJson(file) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw new Error(`${file}: ${err.message}`);
  }
}

// Resolve a path inside the workspace, refusing anything that escapes it.
export function resolveInWorkspace(workspace, relative) {
  const root = path.resolve(workspace);
  const rel = String(relative ?? '').replace(/\\/g, '/').replace(/^\/+/, '');
  const full = path.resolve(root, rel);
  if (full !== root && !full.startsWith(`${root}${path.sep}`)) {
    throw new Error('path escapes the workspace');
  }
  return full;
}

export function stripTurnPrompt(text) {
  const value = String(text ?? '');
  const start = 'A WhatsApp message arrived.';
  if (!value.startsWith(start)) return value;
  return value
    .replace(/^A WhatsApp message arrived\.[^\n]*\n+/, '')
    .replace(/\n+Reply with the wabox_send tool\.[\s\S]*$/, '')
    .trim();
}

export function parseSession(text) {
  const lines = String(text ?? '').split('\n').filter(Boolean).slice(-SESSION_TAIL);
  const events = [];
  let meta = null;
  let model = null;
  let thinkingLevel = null;

  for (const line of lines) {
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    switch (entry.type) {
      case 'session':
        meta = { id: entry.id, version: entry.version, timestamp: entry.timestamp, cwd: entry.cwd };
        break;
      case 'model_change':
        model = { provider: entry.provider, modelId: entry.modelId };
        events.push({ type: 'model', ...model, timestamp: entry.timestamp });
        break;
      case 'thinking_level_change':
        thinkingLevel = entry.thinkingLevel;
        events.push({ type: 'thinkingLevel', level: entry.thinkingLevel, timestamp: entry.timestamp });
        break;
      case 'context_edit':
        events.push({ type: 'contextEdit', timestamp: entry.timestamp });
        break;
      case 'message':
        events.push(...messageEvents(entry));
        break;
      default:
        break;
    }
  }
  return { meta, model, thinkingLevel, events };
}

function contentParts(content) {
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  return Array.isArray(content) ? content : [];
}

function messageEvents(entry) {
  const message = entry?.message;
  if (!message) return [];
  const timestamp = message.timestamp
    ? new Date(message.timestamp).toISOString()
    : entry.timestamp;
  const parts = contentParts(message.content);

  if (message.role === 'system') {
    return [{ type: 'system', text: String(entry.message.content ?? ''), timestamp }];
  }
  if (message.role === 'user') {
    const text = parts.filter((p) => p.type === 'text').map((p) => p.text).join('\n');
    return [{ type: 'user', text: stripTurnPrompt(text), timestamp }];
  }
  if (message.role === 'assistant') {
    const text = parts.filter((p) => p.type === 'text').map((p) => p.text).join('\n');
    const thinking = parts.filter((p) => p.type === 'thinking').map((p) => p.thinking).join('\n\n');
    const tools = parts
      .filter((p) => p.type === 'toolCall')
      .map((p) => ({ id: p.id, name: p.name, arguments: p.arguments }));
    return [
      {
        type: 'assistant',
        text,
        thinking,
        tools,
        model: message.model ? `${message.provider}/${message.model}` : null,
        usage: message.usage ?? null,
        stopReason: message.stopReason ?? null,
        error: message.errorMessage ?? null,
        durationMs: message.durationMs ?? null,
        timestamp,
      },
    ];
  }
  if (message.role === 'toolResult') {
    const text = parts.filter((p) => p.type === 'text').map((p) => p.text).join('\n');
    return [
      {
        type: 'tool',
        name: message.toolName ?? 'tool',
        callId: message.toolCallId ?? null,
        text,
        isError: message.isError === true,
        timestamp,
      },
    ];
  }
  return [];
}

export function createApi({ config, log, control = null }) {
  // Filled lazily so an unset config still shows the default location.
  let modelsCache = null;
  let modelsCacheAt = 0;

  const configTarget = () => config.configFilePath ?? configFilePath();

  async function readConfigFile() {
    const file = configTarget();
    const data = (await readJson(file)) ?? {};
    if (data && typeof data !== 'object') throw new Error(`${file}: expected an object`);
    return data;
  }

  // Merge the overrides *read from disk* onto the instance config. `config`
  // itself was loaded at process start, so a dashboard edit would otherwise
  // show a stale model until a restart.
  function effectiveFor(raw, slug) {
    return conversationConfig({ ...config, conversations: raw?.conversations ?? {} }, slug);
  }

  async function writeConfigFile(data) {
    const file = configTarget();
    await fs.mkdir(path.dirname(file), { recursive: true });
    // Write through a temp file so a crash cannot leave a half-written config.
    const tmp = `${file}.${process.pid}.tmp`;
    await fs.writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
    await fs.rename(tmp, file);
    return file;
  }

  async function listConversations() {
    let names = [];
    try {
      names = await fs.readdir(config.conversationsDir);
    } catch {
      return [];
    }

    const raw = await readConfigFile().catch(() => ({}));
    const out = [];
    for (const slug of names.sort()) {
      const root = path.join(config.conversationsDir, slug);
      const stat = await fs.stat(root).catch(() => null);
      if (!stat?.isDirectory()) continue;
      const paths = conversationPaths(config, slug);
      const identity = await readIdentity(paths);
      const effective = effectiveFor(raw, slug);
      const sessionFiles = await fs.readdir(paths.sessions).catch(() => []);
      const processed = await fs.readdir(paths.processed).catch(() => []);

      let latestSession = null;
      let latestAt = 0;
      if (sessionFiles.length) {
        const candidates = sessionFiles.filter((n) => n.endsWith('.jsonl'));
        const stats = await Promise.all(
          candidates.map(async (name) => ({
            name,
            mtime: (await fs.stat(path.join(paths.sessions, name)).catch(() => null))?.mtimeMs ?? 0,
          })),
        );
        stats.sort((a, b) => b.mtime - a.mtime);
        latestSession = stats[0]?.name ?? null;
        latestAt = stats[0]?.mtime ?? 0;
      }

      out.push({
        slug,
        identity,
        workspace: paths.workspace,
        sessions: sessionFiles.filter((n) => n.endsWith('.jsonl')).length,
        latestSession,
        processed: processed.filter((n) => n.endsWith('.json')).length,
        model: effective.model ?? null,
        modelProvider: effective.modelProvider ?? null,
        thinkingLevel: effective.thinkingLevel ?? null,
        overridden: Boolean(raw.conversations?.[slug]),
        running: control?.isRunning?.(slug) ?? false,
        lastUsed: (latestAt ? new Date(latestAt).toISOString() : stat.mtime.toISOString()),
      });
    }
    return out.sort((a, b) => b.lastUsed.localeCompare(a.lastUsed));
  }

  async function getConversation(slug) {
    assertSlug(slug);
    const paths = conversationPaths(config, slug);
    const stat = await fs.stat(paths.root).catch(() => null);
    if (!stat?.isDirectory()) return null;

    const identity = await readIdentity(paths);
    const sessionFiles = (await fs.readdir(paths.sessions).catch(() => []))
      .filter((n) => n.endsWith('.jsonl'));

    const sessions = [];
    for (const name of sessionFiles) {
      const info = await fs.stat(path.join(paths.sessions, name)).catch(() => null);
      sessions.push({
        name,
        size: info?.size ?? 0,
        modified: info ? info.mtime.toISOString() : null,
      });
    }
    sessions.sort((a, b) => (b.modified ?? '').localeCompare(a.modified ?? ''));

    const processed = (await fs.readdir(paths.processed).catch(() => []))
      .filter((n) => n.endsWith('.json'))
      .sort()
      .reverse();

    return {
      slug,
      identity,
      running: control?.isRunning?.(slug) ?? false,
      workspace: paths.workspace,
      sessions,
      processed: processed.length,
      latestProcessed: processed.slice(0, 20),
      files: await listFiles(paths.workspace),
    };
  }

  async function listFiles(dir, base = dir) {
    const entries = [];
    let names = [];
    try {
      names = await fs.readdir(dir);
    } catch {
      return entries;
    }
    for (const name of names) {
      // Browsing a redirected workspace (an existing project) must stay cheap.
      if (name.startsWith('.') || name === 'node_modules') continue;
      const full = path.join(dir, name);
      const stat = await fs.stat(full).catch(() => null);
      if (!stat) continue;
      const rel = path.relative(base, full);
      if (stat.isDirectory()) {
        entries.push({ path: rel, type: 'dir' });
        if (entries.length < MAX_WORKSPACE_FILES) {
          entries.push(...(await listFiles(full, base)));
        }
      } else {
        entries.push({ path: rel, type: 'file', size: stat.size });
      }
      if (entries.length >= MAX_WORKSPACE_FILES) break;
    }
    return entries.sort((a, b) => a.path.localeCompare(b.path));
  }

  async function getSettings(slug) {
    assertSlug(slug);
    const raw = await readConfigFile();
    const overrides = raw.conversations?.[slug] ?? {};
    const effective = effectiveFor(raw, slug);
    return {
      slug,
      configFile: configTarget(),
      writable: true,
      editable: Object.keys(EDITABLE),
      overrides: redact(overrides),
      effective: redact(pick(effective, [...CONVERSATION_KEYS, 'workspaceTemplate'])),
      instance: redact(pick(config, INSTANCE_VIEW)),
    };
  }

  async function saveSettings(slug, patch) {
    assertSlug(slug);
    const { overrides, errors } = coerceOverrides(patch);
    if (errors.length) {
      const err = new Error(errors.join('; '));
      err.statusCode = 400;
      throw err;
    }

    const raw = await readConfigFile();

    // `vision` is nested: normalize it here so a bad hand-written value cannot
    // reach the daemon, and store an empty object as "no override".
    if (overrides.vision !== undefined && overrides.vision !== null) {
      const vision = normalizeVision(overrides.vision);
      overrides.vision = vision && Object.keys(vision).length ? vision : null;
    }

    const conversations = raw.conversations && typeof raw.conversations === 'object'
      ? raw.conversations
      : {};
    const next = { ...(conversations[slug] ?? {}) };
    for (const [key, value] of Object.entries(overrides)) {
      if (value === null) delete next[key];
      else next[key] = value;
    }

    if (Object.keys(next).length) conversations[slug] = next;
    else delete conversations[slug];
    if (Object.keys(conversations).length) raw.conversations = conversations;
    else delete raw.conversations;

    const file = await writeConfigFile(raw);
    log?.info(`[dashboard] saved settings for ${slug} (${Object.keys(overrides).join(', ') || 'no changes'})`);

    // A running daemon holds the merged config and an open session. Ask it to
    // drop the runner so the next message re-reads config and rebuilds the
    // session with the new model/prompt/sandbox.
    if (control) await control.reload(slug);

    return { slug, configFile: file, overrides: next };
  }

  async function resetSession(slug) {
    assertSlug(slug);
    const paths = conversationPaths(config, slug);
    const files = await fs.readdir(paths.sessions).catch(() => []);
    const removed = files.filter((name) => name.endsWith('.jsonl'));
    await Promise.all(removed.map((name) => fs.rm(path.join(paths.sessions, name), { force: true })));
    if (control) await control.reload(slug);
    log?.info(`[dashboard] reset session for ${slug} (${removed.length} file(s))`);
    return { slug, removed: removed.length };
  }

  // Drop the in-memory session without touching the history. The next turn
  // resumes the same session file but rebuilds it with the current config, so
  // model/prompt/sandbox changes apply immediately.
  async function reloadSession(slug) {
    assertSlug(slug);
    if (control) await control.reload(slug);
    log?.info(`[dashboard] reloaded session for ${slug}`);
    return { slug, reloaded: Boolean(control) };
  }

  async function getTranscript(slug, session) {
    assertSlug(slug);
    const paths = conversationPaths(config, slug);
    const name = path.basename(String(session ?? ''));
    if (!name.endsWith('.jsonl')) throw badRequest('invalid session file');
    const file = path.join(paths.sessions, name);
    let text;
    try {
      text = await readTail(file, MAX_TRANSCRIPT_BYTES);
    } catch (err) {
      if (err.code === 'ENOENT') throw notFound('session not found');
      throw err;
    }
    return { slug, session: name, ...parseSession(text) };
  }

  async function getMessages(slug, limit = 50) {
    assertSlug(slug);
    const paths = conversationPaths(config, slug);
    const files = (await fs.readdir(paths.processed).catch(() => []))
      .filter((n) => n.endsWith('.json'))
      .sort()
      .reverse()
      .slice(0, Math.max(1, Math.min(500, Number(limit) || 50)));
    const messages = [];
    for (const file of files.reverse()) {
      const envelope = await readJson(path.join(paths.processed, file));
      if (!envelope) continue;
      messages.push({
        id: envelope.id ?? null,
        from: envelope.from ?? null,
        participant: envelope.participant ?? null,
        pushName: envelope.pushName ?? null,
        number: envelope.number ?? null,
        text: envelope.text ?? '',
        timestamp: envelope.timestamp ?? null,
        media: envelope.media
          ? { type: envelope.media.type ?? null, mimetype: envelope.media.mimetype ?? null }
          : null,
        file,
      });
    }
    return messages;
  }

  async function readFile(slug, relative) {
    assertSlug(slug);
    const paths = conversationPaths(config, slug);
    const full = resolveInWorkspace(paths.workspace, relative);
    const stat = await fs.stat(full).catch(() => null);
    if (!stat?.isFile()) throw notFound('file not found');
    if (stat.size > MAX_READ_BYTES) throw badRequest(`file is larger than ${MAX_READ_BYTES} bytes`);
    return {
      path: path.relative(paths.workspace, full),
      size: stat.size,
      content: await fs.readFile(full, 'utf8'),
    };
  }

  async function writeFile(slug, relative, content) {
    assertSlug(slug);
    const paths = conversationPaths(config, slug);
    const full = resolveInWorkspace(paths.workspace, relative);
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, String(content ?? ''));
    log?.info(`[dashboard] wrote ${full}`);
    return { path: path.relative(paths.workspace, full) };
  }

  async function getSystemPrompt(slug) {
    assertSlug(slug);
    const paths = conversationPaths(config, slug);
    const raw = await readConfigFile();
    const inline = raw.conversations?.[slug]?.systemPrompt ?? '';
    try {
      return { inline, file: await fs.readFile(path.join(paths.workspace, 'SYSTEM.md'), 'utf8') };
    } catch {
      return { inline, file: '' };
    }
  }

  async function saveSystemPrompt(slug, { inline, file }) {
    assertSlug(slug);
    const raw = await readConfigFile();
    if (inline !== undefined) {
      const conversations = raw.conversations ?? {};
      const next = { ...(conversations[slug] ?? {}) };
      const value = String(inline ?? '').trim();
      if (value) next.systemPrompt = value;
      else delete next.systemPrompt;
      if (Object.keys(next).length) conversations[slug] = next;
      else delete conversations[slug];
      if (Object.keys(conversations).length) raw.conversations = conversations;
      else delete raw.conversations;
      await writeConfigFile(raw);
    }
    if (file !== undefined) {
      const paths = conversationPaths(config, slug);
      await fs.mkdir(paths.workspace, { recursive: true });
      await fs.writeFile(path.join(paths.workspace, 'SYSTEM.md'), `${String(file).trimEnd()}\n`);
    }
    if (control) await control.reload(slug);
    log?.info(`[dashboard] updated system prompt for ${slug}`);
    return getSystemPrompt(slug);
  }

  async function getTasks() {
    const dynamic = (await readJson(config.tasksFile).catch(() => null)) ?? {};
    const list = Array.isArray(dynamic) ? dynamic : dynamic?.tasks ?? [];
    let tasks;
    try {
      tasks = normalizeTasks([...(config.tasks ?? []), ...list], { timezone: config.timezone });
    } catch (err) {
      // A malformed tasks file must not take down the whole dashboard.
      log?.warn(`[dashboard] task list is invalid: ${err.message}`);
      return { tasks: [], error: err.message };
    }
    return {
      error: null,
      tasks: tasks.map((task) => ({
      name: task.name,
      enabled: task.enabled,
      silent: task.silent === true,
      cron: task.cron,
      timezone: task.timezone ?? null,
      slug: task.slug ?? null,
      to: task.to ?? null,
      prompt: task.prompt ?? '',
      source: task.source ?? 'config',
      error: task.error ?? null,
      next:
        task.parsed && task.enabled
          ? nextCronDate(task.parsed, new Date(), task.timezone)?.toISOString() ?? null
          : null,
      })),
    };
  }

  async function getStatus() {
    const conversations = await listConversations();
    const { tasks, error: tasksError } = await getTasks();
    return {
      running: control ? control.alive?.() ?? true : false,
      activeRunners: control?.runnerCount?.() ?? 0,
      conversations: conversations.length,
      tasks: tasks.filter((task) => task.enabled).length,
      tasksError,
      paths: {
        inbox: config.inboxDir,
        outbox: config.outboxDir,
        state: config.stateDir,
        log: config.logFile,
        config: configTarget(),
      },
      settings: {
        batchWindowMs: config.batchWindowMs,
        autoReply: config.autoReply,
        groupPerParticipant: config.groupPerParticipant,
        tools: config.tools,
      },
    };
  }

  async function tailLog(lines = 200) {
    const count = Math.max(1, Math.min(5000, Number(lines) || 200));
    try {
      const text = await fs.readFile(config.logFile, 'utf8');
      return text.split('\n').filter(Boolean).slice(-count).join('\n');
    } catch {
      return '';
    }
  }

  // Model catalog for the picker. Served from pi's static catalog; no network
  // unless the catalog has never been refreshed.
  async function listModels() {
    if (modelsCache && Date.now() - modelsCacheAt < 60_000) return modelsCache;
    const { ModelRuntime } = await import('@earendil-works/pi-coding-agent');
    const runtime = await ModelRuntime.create({ allowModelNetwork: false });
    const available = runtime.getAvailableSnapshot?.() ?? [];
    const models = (available.length ? available : runtime.getAllModels()).map((model) => ({
      provider: model.provider,
      id: model.id,
      name: model.name ?? model.id,
      contextWindow: model.contextWindow ?? null,
      reasoning: model.reasoning === true,
    }));
    models.sort((a, b) =>
      a.provider === b.provider ? a.id.localeCompare(b.id) : a.provider.localeCompare(b.provider),
    );
    modelsCache = { models, providers: [...new Set(models.map((m) => m.provider))] };
    modelsCacheAt = Date.now();
    return modelsCache;
  }

  return {
    listConversations,
    getConversation,
    getSettings,
    saveSettings,
    resetSession,
    reloadSession,
    getTranscript,
    getMessages,
    readFile,
    writeFile,
    getSystemPrompt,
    saveSystemPrompt,
    getTasks,
    getStatus,
    tailLog,
    listModels,
    configFile: configTarget,
  };
}

function badRequest(message) {
  const err = new Error(message);
  err.statusCode = 400;
  return err;
}

function notFound(message) {
  const err = new Error(message);
  err.statusCode = 404;
  return err;
}
