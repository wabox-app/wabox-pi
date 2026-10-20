// Settings resolution: environment > config.json > defaults.
//
// `wabox-pi` owns no WhatsApp state — the inbox/outbox belong to wabox-core.
// What lives here is harness state: per-conversation pi sessions, workspaces,
// staged media, and logs.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveFrom, xdg } from './paths.js';
import { resolveWaboxPaths } from './wabox-paths.js';

const SRC_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_WORKSPACE_TEMPLATE = path.resolve(SRC_DIR, '../templates/workspace-AGENTS.md');

const DEFAULT_TOOLS = ['read', 'bash', 'edit', 'write', 'grep', 'find', 'ls'];

function bool(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'boolean') return value;
  return !['0', 'false', 'no', 'off'].includes(String(value).toLowerCase());
}

function int(value, fallback, { min = 0 } = {}) {
  const n = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(n) && n >= min ? n : fallback;
}

function list(value, fallback) {
  if (Array.isArray(value)) return value.map(String).map((s) => s.trim()).filter(Boolean);
  if (typeof value === 'string' && value.trim()) {
    return value.split(',').map((s) => s.trim()).filter(Boolean);
  }
  return fallback;
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw new Error(`invalid config file ${file}: ${err.message}`);
  }
}

function env(name) {
  return process.env[name];
}

export function loadConfig({ cwd = process.cwd() } = {}) {
  const configFile =
    resolveFrom(cwd, env('WABOX_PI_CONFIG')) ||
    path.join(xdg.config(), 'wabox-pi', 'config.json');
  const file = readJson(configFile);
  const base = file ? path.dirname(configFile) : cwd;

  const wabox = resolveWaboxPaths();
  const stateDir = resolveFrom(
    base,
    env('WABOX_PI_STATE_DIR') || file?.stateDir || path.join(xdg.state(), 'wabox-pi'),
  );
  const templateSetting = env('WABOX_PI_WORKSPACE_TEMPLATE') ?? file?.workspaceTemplate;

  const config = {
    configFile: file ? configFile : null,
    inboxDir: resolveFrom(base, env('WABOX_INBOX') || file?.inboxDir || wabox.inboxDir),
    outboxDir: resolveFrom(base, env('WABOX_OUTBOX') || file?.outboxDir || wabox.outboxDir),
    stateDir,

    // How long to wait for a burst of messages before running one agent turn.
    // WhatsApp splits a photo + caption into separate envelopes.
    batchWindowMs: int(env('WABOX_PI_BATCH_MS') ?? file?.batchWindowMs, 0),

    // React to an inbound message as soon as it is picked up ("working").
    ackReact: env('WABOX_PI_ACK_REACT') ?? file?.ackReact ?? '',

    // If the agent produces text but never calls the reply tool, send it.
    autoReply: bool(env('WABOX_PI_AUTO_REPLY') ?? file?.autoReply, true),

    // Tell the chat when a turn fails (model/auth/tool error) instead of silence.
    errorReply: bool(env('WABOX_PI_ERROR_REPLY') ?? file?.errorReply, true),

    // Key group conversations per sender instead of per group.
    groupPerParticipant: bool(
      env('WABOX_PI_GROUP_PER_PARTICIPANT') ?? file?.groupPerParticipant,
      false,
    ),

    tools: list(env('WABOX_PI_TOOLS') ?? file?.tools, DEFAULT_TOOLS),
    excludeTools: list(env('WABOX_PI_EXCLUDE_TOOLS') ?? file?.excludeTools, []),

    // Seeded into a fresh conversation workspace as AGENTS.md. A relative
    // value resolves against the config file; the built-in default is absolute.
    workspaceTemplate: templateSetting
      ? resolveFrom(base, templateSetting)
      : DEFAULT_WORKSPACE_TEMPLATE,

    logLevel: env('WABOX_PI_LOG_LEVEL') || env('LOG_LEVEL') || file?.logLevel || 'info',
  };

  config.logFile = path.join(stateDir, 'wabox-pi.log');
  config.lockFile = path.join(stateDir, 'wabox-pi.lock');
  config.failedDir = path.join(stateDir, 'failed');
  config.conversationsDir = path.join(stateDir, 'conversations');

  return config;
}
