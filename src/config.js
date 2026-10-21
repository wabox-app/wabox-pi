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
import { normalizeTasks } from './schedule.js';

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

function normalizeImageGen(value, base) {
  if (!value || typeof value !== 'object') return null;
  const out = {};
  if (value.provider !== undefined) out.provider = String(value.provider);
  if (value.enabled !== undefined) out.enabled = bool(value.enabled, true);
  if (value.model !== undefined) out.model = String(value.model);
  if (value.dimensions !== undefined) out.dimensions = String(value.dimensions);
  if (value.size !== undefined) out.size = String(value.size);
  if (value.width !== undefined) out.width = int(value.width, null, { min: 64 });
  if (value.height !== undefined) out.height = int(value.height, null, { min: 64 });
  if (value.n !== undefined) out.n = int(value.n, 1, { min: 1 });
  if (value.seed !== undefined) out.seed = Number(value.seed) || undefined;
  if (value.timeoutMs !== undefined) out.timeoutMs = int(value.timeoutMs, 180_000, { min: 1_000 });
  if (value.apiKey !== undefined) out.apiKey = String(value.apiKey) || null;
  if (value.apiKeyEnv !== undefined) out.apiKeyEnv = String(value.apiKeyEnv) || null;
  if (value.apiKeyFile !== undefined) {
    out.apiKeyFile = value.apiKeyFile ? resolveFrom(base, value.apiKeyFile) : null;
  }
  if (value.piProvider !== undefined) out.piProvider = String(value.piProvider) || null;
  if (value.usePiAuth !== undefined) out.usePiAuth = bool(value.usePiAuth, true);
  return out;
}

// Keys a per-conversation override may set. Values replace the instance value
// (lists are not merged). Path-valued keys are resolved against the config file.
const CONVERSATION_KEYS = [
  'workspace',
  'modelProvider',
  'model',
  'thinkingLevel',
  'turnFeedbackMs',
  'turnFeedbackReact',
  'turnTimeoutMs',
  'ignoreEmojiOnly',
  'ignoreEmpty',
  'logTokens',
  'contextCompactRatio',
  'contextCompactWarnTokens',
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
  'imageGen',
];

function normalizeConversation(override, base) {
  const out = {};
  if (!override || typeof override !== 'object') return out;
  if (override.workspace !== undefined) out.workspace = resolveFrom(base, override.workspace);
  if (override.workspaceTemplate !== undefined) {
    out.workspaceTemplate = resolveFrom(base, override.workspaceTemplate);
  }
  if (override.modelProvider !== undefined) out.modelProvider = String(override.modelProvider);
  if (override.model !== undefined) out.model = String(override.model);
  if (override.thinkingLevel !== undefined) out.thinkingLevel = String(override.thinkingLevel);
  if (override.turnFeedbackMs !== undefined) out.turnFeedbackMs = int(override.turnFeedbackMs, 60_000, { min: 0 });
  if (override.turnFeedbackReact !== undefined) out.turnFeedbackReact = String(override.turnFeedbackReact);
  if (override.turnTimeoutMs !== undefined) out.turnTimeoutMs = int(override.turnTimeoutMs, 600_000, { min: 0 });
  if (override.ignoreEmojiOnly !== undefined) out.ignoreEmojiOnly = bool(override.ignoreEmojiOnly, true);
  if (override.ignoreEmpty !== undefined) out.ignoreEmpty = bool(override.ignoreEmpty, true);
  if (override.logTokens !== undefined) out.logTokens = bool(override.logTokens, true);
  if (override.contextCompactRatio !== undefined) out.contextCompactRatio = Number(override.contextCompactRatio);
  if (override.contextCompactWarnTokens !== undefined) {
    out.contextCompactWarnTokens = int(override.contextCompactWarnTokens, 120_000, { min: 0 });
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
  if (override.imageGen !== undefined) {
    out.imageGen = override.imageGen === null ? null : normalizeImageGen(override.imageGen, base);
  }
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

  // Inbound-audio transcription (see src/transcribe.js). Enabled by default
  // whenever a backend (command or endpoint) is configured.
  const tr = file?.transcription ?? {};
  const trProvider = env('WABOX_PI_TRANSCRIBE_PROVIDER') || tr.provider || null;
  const transcription = {
    provider: trProvider,
    command: env('WABOX_PI_TRANSCRIBE_CMD') || tr.command || null,
    baseUrl: env('WABOX_PI_TRANSCRIBE_URL') || tr.baseUrl || null,
    model:
      env('WABOX_PI_TRANSCRIBE_MODEL') ||
      tr.model ||
      (trProvider === 'openrouter' ? 'google/gemini-3.1-flash-lite' : 'whisper-1'),
    apiKey: env('WABOX_PI_TRANSCRIBE_KEY') || tr.apiKey || null,
    apiKeyEnv: tr.apiKeyEnv || null,
    apiKeyFile: tr.apiKeyFile ? resolveFrom(base, tr.apiKeyFile) : null,
    piProvider: tr.piProvider || null,
    usePiAuth: tr.usePiAuth !== false,
    language: env('WABOX_PI_TRANSCRIBE_LANG') || tr.language || null,
    prompt: tr.prompt || null,
    timeoutMs: int(tr.timeoutMs, 120_000, { min: 1_000 }),
  };
  transcription.enabled =
    tr.enabled !== undefined
      ? bool(tr.enabled, true)
      : Boolean(transcription.command || transcription.baseUrl || transcription.provider);

  // Agent web access (see src/web.js), served by the daemon process so the
  // sandboxed shell can stay offline.
  const webFile = file?.web ?? {};
  const fetchCfg = webFile.fetch ?? {};
  const searchCfg = webFile.search ?? {};
  const web = {
    fetch: {
      enabled: bool(env('WABOX_PI_WEB_FETCH') ?? fetchCfg.enabled, true),
      allow: list(fetchCfg.allow, []),
      deny: list(fetchCfg.deny, []),
      maxBytes: int(fetchCfg.maxBytes, 2_000_000, { min: 1_000 }),
      timeoutMs: int(fetchCfg.timeoutMs, 20_000, { min: 1_000 }),
      userAgent: fetchCfg.userAgent ? String(fetchCfg.userAgent) : null,
    },
    search: {
      enabled: bool(env('WABOX_PI_WEB_SEARCH') ?? searchCfg.enabled, true),
      provider: env('WABOX_PI_SEARCH_PROVIDER') || searchCfg.provider || 'duckduckgo',
      baseUrl: searchCfg.baseUrl ? String(searchCfg.baseUrl) : null,
      apiKey: env('WABOX_PI_SEARCH_KEY') || searchCfg.apiKey || null,
      apiKeyEnv: searchCfg.apiKeyEnv || null,
      apiKeyFile: searchCfg.apiKeyFile ? resolveFrom(base, searchCfg.apiKeyFile) : null,
      maxResults: int(searchCfg.maxResults, 5, { min: 1 }),
      timeoutMs: int(searchCfg.timeoutMs, 20_000, { min: 1_000 }),
    },
  };

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

    // Log token consumption and context size per turn.
    logTokens: bool(env('WABOX_PI_LOG_TOKENS') ?? file?.logTokens, true),

    // Messages with nothing to respond to (a WhatsApp reaction arrives as an
    // empty envelope; an emoji-only message) are dropped without a reply.
    ignoreEmojiOnly: bool(env('WABOX_PI_IGNORE_EMOJI_ONLY') ?? file?.ignoreEmojiOnly, true),
    ignoreEmpty: bool(env('WABOX_PI_IGNORE_EMPTY') ?? file?.ignoreEmpty, true),

    // Chat model for the agent. A bare model id (or `provider/id`) plus an
    // optional thinking level; per-slug overrides win. See resolveCliModel.
    modelProvider: env('WABOX_PI_MODEL_PROVIDER') || file?.modelProvider || null,
    model: env('WABOX_PI_MODEL') || file?.model || null,
    thinkingLevel: env('WABOX_PI_THINKING_LEVEL') || file?.thinkingLevel || null,

    // Long turns: react after this long so the chat is not left in the dark.
    // 0 disables. `turnFeedbackReact` is the emoji used.
    turnFeedbackMs: int(env('WABOX_PI_TURN_FEEDBACK_MS') ?? file?.turnFeedbackMs, 60_000, {
      min: 0,
    }),
    turnFeedbackReact: env('WABOX_PI_TURN_FEEDBACK_REACT') || file?.turnFeedbackReact || '⏳',

    // Abort a turn that runs longer than this and tell the chat. 0 disables.
    turnTimeoutMs: int(env('WABOX_PI_TURN_TIMEOUT_MS') ?? file?.turnTimeoutMs, 600_000, {
      min: 0,
    }),

    // Compact the session when its context passes this share of the model's
    // window. pi only compacts near the window limit, which is too late for
    // long-lived chats: every request then re-sends a huge context.
    contextCompactRatio: Number(
      env('WABOX_PI_CONTEXT_COMPACT_RATIO') ?? file?.contextCompactRatio ?? 0.5,
    ),
    contextCompactWarnTokens: int(
      env('WABOX_PI_CONTEXT_WARN_TOKENS') ?? file?.contextCompactWarnTokens ?? 120_000,
      { min: 0 },
    ),

    transcription,
    web,

    // Image generation via OpenRouter (see src/generate_image.js).
    imageGen: normalizeImageGen(file?.imageGen, base),

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

    // Scheduled tasks and the default time zone their cron is evaluated in.
    timezone: env('WABOX_PI_TIMEZONE') || file?.timezone || null,
    tasks: [],
    schedulerTickMs: int(env('WABOX_PI_SCHEDULER_TICK_MS') ?? file?.schedulerTickMs, 20_000, {
      min: 1_000,
    }),
    runnerIdleTimeoutMs: int(
      env('WABOX_PI_RUNNER_IDLE_TIMEOUT_MS') ?? file?.runnerIdleTimeoutMs,
      21_600_000, // 6 hours
      { min: 0 },
    ),
    runnerCleanupIntervalMs: int(
      env('WABOX_PI_RUNNER_CLEANUP_INTERVAL_MS') ?? file?.runnerCleanupIntervalMs,
      60_000, // 1 minute
      { min: 1_000 },
    ),

    // Retry policy for external API calls (transcription, image generation, web fetch/search).
    // Retries network errors (TypeError) and HTTP 5xx / 429 responses with exponential backoff.
    apiRetryMaxAttempts: int(
      env('WABOX_PI_API_RETRY_ATTEMPTS') ?? file?.apiRetryMaxAttempts, 3, { min: 1 },
    ),
    apiRetryInitialDelayMs: int(
      env('WABOX_PI_API_RETRY_DELAY_MS') ?? file?.apiRetryInitialDelayMs, 1_000, { min: 0 },
    ),
    apiRetryMaxDelayMs: int(
      env('WABOX_PI_API_RETRY_MAX_DELAY_MS') ?? file?.apiRetryMaxDelayMs, 30_000, { min: 0 },
    ),
    apiRetryMultiplier: Number(
      env('WABOX_PI_API_RETRY_MULTIPLIER') ?? file?.apiRetryMultiplier ?? 2,
    ) || 2,
  };

  config.tasks = normalizeTasks(file?.tasks, { timezone: config.timezone });

  config.logFile = path.join(stateDir, 'wabox-pi.log');
  config.lockFile = path.join(stateDir, 'wabox-pi.lock');
  config.failedDir = path.join(stateDir, 'failed');
  config.conversationsDir = path.join(stateDir, 'conversations');
  config.schedulerFile = path.join(stateDir, 'scheduler.json');
  // Chat-created jobs (see src/tasks.js), separate from the config file.
  config.tasksFile = path.join(stateDir, 'tasks.json');

  return config;
}
