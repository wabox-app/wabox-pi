// Dashboard HTTP server: a JSON API over the harness state plus a small static
// SPA. It never touches the inbox or the outbox; the daemon keeps owning the
// WhatsApp loop. It can run inside `wabox-pi run` (with a live `control` handle
// to reload sessions) or standalone via `wabox-pi dashboard`.

import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApi } from './api.js';

const WEBUI_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'webui');

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function json(res, status, body) {
  const payload = JSON.stringify(body, null, 2);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

async function readBody(req, limit = 2 * 1024 * 1024) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) {
      const err = new Error('request body too large');
      err.statusCode = 413;
      throw err;
    }
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  const text = Buffer.concat(chunks).toString('utf8');
  try {
    return JSON.parse(text);
  } catch {
    const err = new Error('invalid JSON body');
    err.statusCode = 400;
    throw err;
  }
}

function loopback(host) {
  return ['127.0.0.1', '::1', 'localhost'].includes(host);
}

// `GET /api/conversations/<slug>/file?path=AGENTS.md`
async function route(api, req, url) {
  const segments = url.pathname
    .replace(/^\/api\/?/, '')
    .split('/')
    .filter(Boolean)
    .map((segment) => decodeURIComponent(segment));
  const method = req.method ?? 'GET';
  const [head, slug, tail] = segments;

  if (head === 'status' && segments.length === 1 && method === 'GET') return api.getStatus();
  if (head === 'models' && segments.length === 1 && method === 'GET') return api.listModels();
  if (head === 'tasks' && segments.length === 1 && method === 'GET') return api.getTasks();
  if (head === 'log' && segments.length === 1 && method === 'GET') {
    return { log: await api.tailLog(url.searchParams.get('lines')) };
  }
  if (head === 'conversations' && segments.length === 1 && method === 'GET') {
    return { conversations: await api.listConversations() };
  }

  if (head !== 'conversations' || !slug) return null;

  if (segments.length === 2 && method === 'GET') {
    const conversation = await api.getConversation(slug);
    if (!conversation) {
      const err = new Error('conversation not found');
      err.statusCode = 404;
      throw err;
    }
    return conversation;
  }

  if (tail === 'settings' && segments.length === 3) {
    if (method === 'GET') return api.getSettings(slug);
    if (method === 'PUT') return api.saveSettings(slug, await readBody(req));
  }

  if (tail === 'system-prompt' && segments.length === 3) {
    if (method === 'GET') return api.getSystemPrompt(slug);
    if (method === 'PUT') return api.saveSystemPrompt(slug, await readBody(req));
  }

  if (tail === 'reset' && segments.length === 3 && method === 'POST') {
    return api.resetSession(slug);
  }

  if (tail === 'reload' && segments.length === 3 && method === 'POST') {
    return api.reloadSession(slug);
  }

  if (tail === 'messages' && segments.length === 3 && method === 'GET') {
    return { messages: await api.getMessages(slug, url.searchParams.get('limit')) };
  }

  if (tail === 'files' && segments.length === 3 && method === 'GET') {
    const conversation = await api.getConversation(slug);
    if (!conversation) {
      const err = new Error('conversation not found');
      err.statusCode = 404;
      throw err;
    }
    return { files: conversation.files };
  }

  if (tail === 'transcript' && segments.length === 3 && method === 'GET') {
    return api.getTranscript(slug, url.searchParams.get('session'));
  }

  if (tail === 'file' && segments.length === 3) {
    const relative = url.searchParams.get('path');
    if (method === 'GET') return api.readFile(slug, relative);
    if (method === 'PUT') {
      const body = await readBody(req);
      return api.writeFile(slug, relative, body.content ?? '');
    }
  }

  return null;
}

async function serveStatic(res, url) {
  const name = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
  const full = path.resolve(WEBUI_DIR, name);
  if (!full.startsWith(WEBUI_DIR)) {
    json(res, 403, { error: 'forbidden' });
    return;
  }
  let stat = await fs.stat(full).catch(() => null);
  // Single-page app: unknown paths fall back to index.html.
  if (!stat?.isFile()) {
    stat = await fs.stat(path.join(WEBUI_DIR, 'index.html')).catch(() => null);
    if (!stat) {
      json(res, 404, { error: 'webui not found' });
      return;
    }
    res.writeHead(200, { 'Content-Type': CONTENT_TYPES['.html'] });
    createReadStream(path.join(WEBUI_DIR, 'index.html')).pipe(res);
    return;
  }
  res.writeHead(200, {
    'Content-Type': CONTENT_TYPES[path.extname(full)] ?? 'application/octet-stream',
    'Content-Length': stat.size,
    'Cache-Control': 'no-cache',
  });
  createReadStream(full).pipe(res);
}

export async function startDashboard({ config, log, control = null, port, host } = {}) {
  // An explicit `port` (even 0, for an ephemeral port) always starts the
  // server. Without one, the dashboard is only started when the config sets a
  // non-zero port, so `dashboardPort: 0` means "disabled".
  const explicit = port !== undefined && port !== null;
  const listenPort = explicit ? port : config.dashboardPort ?? 0;
  const listenHost = host ?? config.dashboardHost ?? '127.0.0.1';
  if (!explicit && !listenPort) return null;

  const token = process.env.WABOX_PI_DASHBOARD_TOKEN || '';
  if (!loopback(listenHost) && !token) {
    throw new Error(
      `refusing to expose the dashboard on ${listenHost} without WABOX_PI_DASHBOARD_TOKEN`,
    );
  }

  const api = createApi({ config, log, control });

  const server = (await import('node:http')).createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? listenHost}`);
    try {
      if (url.pathname.startsWith('/api/')) {
        if (token) {
          const given = req.headers.authorization?.replace(/^Bearer\s+/i, '');
          if (given !== token) {
            json(res, 401, { error: 'unauthorized' });
            return;
          }
        }
        if (req.method === 'OPTIONS') {
          res.writeHead(204, {
            'Access-Control-Allow-Origin': req.headers.origin ?? '*',
            'Access-Control-Allow-Methods': 'GET, PUT, POST',
            'Access-Control-Allow-Headers': 'Content-Type, Authorization',
          });
          res.end();
          return;
        }
        const result = await route(api, req, url);
        if (result === null) {
          json(res, 404, { error: 'not found' });
          return;
        }
        json(res, 200, result);
        return;
      }
      await serveStatic(res, url);
    } catch (err) {
      const status = err.statusCode ?? (err.code === 'ENOENT' ? 404 : 500);
      if (status >= 500) log?.warn(`[dashboard] ${req.method} ${url.pathname}: ${err.message}`);
      json(res, status, { error: err.message });
    }
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(listenPort, listenHost, () => {
      server.off('error', reject);
      resolve();
    });
  });

  const address = server.address();
  const displayHost = typeof address === 'object' && address ? address.address : listenHost;
  const displayPort = typeof address === 'object' && address ? address.port : listenPort;
  log?.info(`[dashboard] listening on http://${displayHost}:${displayPort}`);

  return {
    server,
    url: `http://${displayHost}:${displayPort}`,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
