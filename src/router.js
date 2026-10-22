// Lightweight router that decides, for each incoming message, which thread
// within a slug it belongs to. Uses a cheap chat-completion call so the
// decision is semantic rather than keyword-based.
//
// When threads are disabled the harness uses a single "default" thread, so
// existing behaviour is preserved.

import { Type } from 'typebox';
import { fetchWithRetry } from './retry.js';
import { readThreads, ensureThread, createThread, setActiveThread, touchThread } from './threads.js';

const DEFAULT_ROUTER_MODEL = 'google/gemini-3.1-flash-lite';
const DEFAULT_ROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';

/**
 * Build the router prompt. Kept compact to minimize token cost (~200-400
 * tokens per call with a handful of threads).
 */
function buildRouterPrompt({ message, activeThread, otherThreads }) {
  const others = otherThreads.length
    ? otherThreads
        .map((t, i) => `${i + 1}. "${t.name}" — ${t.summary || '(no summary)'}`)
        .join('\n')
    : '(none)';

  return `You are a conversation router. Your job is to decide which existing conversation thread a new message belongs to, or whether it starts a new topic.

ACTIVE THREAD: "${activeThread.name}" — ${activeThread.summary || '(no summary)'}
OTHER THREADS:
${others}

NEW MESSAGE: "${message.replace(/"/g, "'")}"

Reply with JSON only, no markdown:
- Same topic as active → {"action":"continue"}
- Matches another existing thread → {"action":"switch","threadId":"<id>"}
- New topic → {"action":"new","name":"<short name>","summary":"<one-line summary>"}`;
}

async function resolveRouterKey(config) {
  const rc = config.router ?? {};
  if (rc.apiKey) return rc.apiKey;
  if (rc.apiKeyEnv && process.env[rc.apiKeyEnv]) return process.env[rc.apiKeyEnv];
  if (rc.apiKeyFile) {
    try {
      const { readFileSync } = await import('node:fs');
      const text = readFileSync(rc.apiKeyFile, 'utf8');
      const key = text.split(/\r?\n/).map((l) => l.trim()).find(Boolean);
      if (key) return key;
    } catch {
      // fall through
    }
  }
  // Fallback to transcription or image-gen key patterns if configured.
  if (config.transcription?.apiKey) return config.transcription.apiKey;
  return null;
}

/**
 * Ask a cheap model which thread this message belongs to.
 * Returns `{action, threadId?, name?, summary?}`.
 */
export async function classifyMessage({ message, activeThread, otherThreads, config, log, fetchImpl = fetch }) {
  const rc = config.router ?? {};
  if (!rc.enabled === false) {
    // explicitly disabled
    return { action: 'continue' };
  }

  const key = await resolveRouterKey(config);
  const url = rc.baseUrl || DEFAULT_ROUTER_URL;
  const model = rc.model || DEFAULT_ROUTER_MODEL;

  if (!key) {
    log?.warn?.('[router] no API key configured; defaulting to continue active thread');
    return { action: 'continue' };
  }

  const prompt = buildRouterPrompt({ message, activeThread, otherThreads });
  const body = {
    model,
    messages: [{ role: 'user', content: prompt }],
    temperature: 0.1,
    max_tokens: 80,
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), rc.timeoutMs || 8_000);
  timer.unref?.();

  try {
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://github.com/wabox-app/wabox-pi',
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    const raw = await res.text();
    if (!res.ok) {
      throw new Error(`router API ${res.status}: ${raw.trim().slice(0, 200)}`);
    }

    const parsed = JSON.parse(raw);
    const content = parsed.choices?.[0]?.message?.content?.trim() || '';

    // Strip markdown code fences if the model wrapped JSON.
    const cleaned = content.replace(/^```json\s*|\s*```$/g, '').trim();
    const decision = JSON.parse(cleaned);

    if (!['continue', 'switch', 'new'].includes(decision.action)) {
      throw new Error(`unexpected router action: ${decision.action}`);
    }
    return decision;
  } catch (err) {
    if (err.name === 'AbortError') {
      log?.warn?.('[router] classification timed out; defaulting to continue');
      return { action: 'continue' };
    }
    log?.warn?.(`[router] classification failed: ${err.message}; defaulting to continue`);
    return { action: 'continue' };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Resolve the target thread for an incoming envelope.
 *
 * 1. If the feature is disabled → "default"
 * 2. If there are zero/one threads → active thread (no need to classify)
 * 3. Otherwise → call classifyMessage and handle switch/new
 */
export async function resolveThread({ envelope, slug, config, paths, log, fetchImpl }) {
  const threadsEnabled = config.threads !== false;
  if (!threadsEnabled) {
    return { threadId: 'default', paths, switched: false };
  }

  const db = await readThreads(paths.root);
  const { thread: active } = await ensureThread(paths.root, db.activeThreadId);

  // Always continue the active thread if there is only one thread or the
  // active thread was created very recently (no context to judge yet).
  if (db.threads.length <= 1) {
    return { threadId: active.id, paths, switched: false };
  }

  // Heuristic: if the last message to this thread was < 2 minutes ago, keep
  // the thread hot to avoid burning tokens on every message in a rapid chat.
  const lastActive = active.lastActiveAt ? new Date(active.lastActiveAt) : null;
  const hotMinutes = config.threadHotMinutes ?? 2;
  if (lastActive && Date.now() - lastActive.getTime() < hotMinutes * 60_000) {
    log?.debug?.(`[router] thread "${active.name}" still hot (${hotMinutes}m); skipping classification`);
    return { threadId: active.id, paths, switched: false };
  }

  const text = envelope.text || '';
  const otherThreads = db.threads.filter((t) => t.id !== active.id);

  const decision = await classifyMessage({
    message: text,
    activeThread: active,
    otherThreads,
    config,
    log,
    fetchImpl,
  });

  if (decision.action === 'continue') {
    return { threadId: active.id, paths, switched: false };
  }

  if (decision.action === 'switch') {
    const target = db.threads.find((t) => t.id === decision.threadId);
    if (!target) {
      log?.warn?.(`[router] asked to switch to unknown thread "${decision.threadId}"; staying on active`);
      return { threadId: active.id, paths, switched: false };
    }
    await setActiveThread(paths.root, target.id);
    log?.info?.(`[router] switched to thread "${target.name}" (${target.id})`);
    return {
      threadId: target.id,
      paths: { ...paths, sessions: paths.sessions.replace(/sessions\/[^/]+$/, `sessions/${target.id}`) },
      switched: true,
    };
  }

  // action === 'new'
  const { threadId } = await createThread(paths.root, {
    name: decision.name || 'New topic',
    summary: decision.summary || '',
  });
  await setActiveThread(paths.root, threadId);
  log?.info?.(`[router] created thread "${decision.name || threadId}" (${threadId})`);
  return {
    threadId,
    paths: { ...paths, sessions: paths.sessions.replace(/sessions\/[^/]+$/, `sessions/${threadId}`) },
    switched: true,
  };
}
