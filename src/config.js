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

// Hidden from sandboxed bash. `stateDir` is added at session time, and entries
// that do not exist on the host are skipped.
const DEFAULT_SANDBOX_DENY_READ = [
  '~/.ssh',
  '~/.aws',
  '~/.gnupg',
  '~/.config/gh',
  '~/.docker',
  '~/.netrc',
  '~/.npmrc',
  '~/.pi',
];

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

// Keys a per-conversation override may set. Values replace the instance value
// (lists are not merged). Path-valued keys are resolved against the config file.
const CONVERSATION_KEYS = [
  'workspace',
  'jail',
  'sandboxBash',
  'sandboxNetwork',
  'sandboxDenyRead',
  'sandboxAllowRead',
  'sandboxBashBin',
  'tools',
  'excludeTools',
  'autoReply',
  'errorReply',
  'ackReact',
  'batchWindowMs',
  'workspaceTemplate',
];

function normalizeConversation(override, base) {
  const out = {};
  if (!override || typeof override !== 'object') return out;
  if (override.workspace !== undefined) out.workspace = resolveFrom(base, override.workspace);
  if (override.workspaceTemplate !== undefined) {
    out.workspaceTemplate = resolveFrom(base, override.workspaceTemplate);
  }
  if (override.jail !== undefined) out.jail = bool(override.jail, true);
  if (override.sandboxBash !== undefined) out.sandboxBash = String(override.sandboxBash);
  if (override.sandboxNetwork !== undefined) out.sandboxNetwork = bool(override.sandboxNetwork, true);
  if (override.sandboxBashBin !== undefined) out.sandboxBashBin = String(override.sandboxBashBin);
  if (override.sandboxDenyRead !== undefined) {
    out.sandboxDenyRead = list(override.sandboxDenyRead, DEFAULT_SANDBOX_DENY_READ);
  }
  if (override.sandboxAllowRead !== undefined) {
    out.sandboxAllowRead = list(override.sandboxAllowRead, []);
  }
  if (override.tools !== undefined) out.tools = list(override.tools, DEFAULT_TOOLS);
  if (override.excludeTools !== undefined) out.excludeTools = list(override.excludeTools, []);
  if (override.autoReply !== undefined) out.autoReply = bool(override.autoReply, true);
  if (override.errorReply !== undefined) out.errorReply = bool(override.errorReply, true);
  if (override.ackReact !== undefined) out.ackReact = String(override.ackReact ?? '');
  if (override.batchWindowMs !== undefined) out.batchWindowMs = int(override.batchWindowMs, 0);
  return out;
}

// Merge a conversation's overrides over the instance config. Returns the same
// object when nothing is overridden, so the common path stays allocation-free.
// `workspaceOverrides` is the older, workspace-only form and still wins when a
// `conversations` entry does not set `workspace`.
export function conversationConfig(config, slug) {
  const override = config.conversations?.[slug];
  const workspace = override?.workspace ?? config.workspaceOverrides?.[slug];
  if (!override && !workspace) return config;

  const merged = { ...config };
  if (override) {
    for (const key of CONVERSATION_KEYS) {
      if (override[key] !== undefined) merged[key] = override[key];
    }
  }
  if (workspace) merged.workspace = workspace;
  return merged;
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

    // Keep the agent inside its conversation workspace. `jail` path-jails the
    // file tools; `sandboxBash` decides how bash is contained:
    //   off   - no sandbox
    //   auto  - bubblewrap when available, otherwise warn and run unsandboxed
    //   bwrap - bubblewrap required; refuse to start a session without it
    jail: bool(env('WABOX_PI_JAIL') ?? file?.jail, true),
    sandboxBash: env('WABOX_PI_SANDBOX_BASH') || file?.sandboxBash || 'auto',
    sandboxNetwork: bool(env('WABOX_PI_SANDBOX_NET') ?? file?.sandboxNetwork, true),
    sandboxBashBin: env('WABOX_PI_SANDBOX_BASH_BIN') || file?.sandboxBashBin || 'bwrap',
    sandboxDenyRead: list(
      env('WABOX_PI_SANDBOX_DENY_READ') ?? file?.sandboxDenyRead,
      DEFAULT_SANDBOX_DENY_READ,
    ),
    // Read-only paths re-exposed inside a denied parent (useful when
    // `sandboxDenyRead` hides `~` but a toolchain under it must still run).
    sandboxAllowRead: list(env('WABOX_PI_SANDBOX_ALLOW_READ') ?? file?.sandboxAllowRead, []),

    // Per-conversation overrides (workspace, tools, jail/sandbox, …). Relative
    // paths resolve against the config file; see `conversationConfig`.
    conversations: Object.fromEntries(
      Object.entries(file?.conversations ?? {}).map(([slug, override]) => [
        slug,
        normalizeConversation(override, base),
      ]),
    ),

    // Older, workspace-only form of the same idea. Prefer `conversations`.
    workspaceOverrides: Object.fromEntries(
      Object.entries(file?.workspaceOverrides ?? {})
        .map(([slug, dir]) => [slug, resolveFrom(base, dir)])
        .filter(([, dir]) => dir),
    ),

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
