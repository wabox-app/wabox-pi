// Web access for the agent, running in the daemon process (which has the
// network) instead of the sandboxed shell. Two tools:
//
//   wabox_fetch   fetch a URL and return readable text
//   wabox_search  web search (DuckDuckGo by default, no API key)
//
// Because the model supplies the URL, `wabox_fetch` guards against SSRF: only
// http(s), the host must resolve to public addresses, redirects are followed
// manually and re-checked, and responses are size-capped. An explicit
// `web.fetch.allow` list opts hosts in (and, when set, is also the only way in).

import fs from 'node:fs/promises';
import dns from 'node:dns/promises';
import net from 'node:net';
import { Type } from 'typebox';

const DEFAULT_UA = 'wabox-pi/0.1 (+https://github.com/wabox-app/wabox-pi)';
const MAX_REDIRECTS = 5;
const MAX_BYTES = 2_000_000;
const MAX_CHARS = 20_000;

const ENTITIES = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  mdash: '—',
  ndash: '–',
  hellip: '…',
  rsquo: '’',
  lsquo: '‘',
  ldquo: '“',
  rdquo: '”',
};

export function decodeEntities(value) {
  return String(value).replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (match, ref) => {
    if (ref[0] === '#') {
      const code = ref[1] === 'x' || ref[1] === 'X' ? Number.parseInt(ref.slice(2), 16) : Number.parseInt(ref.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : match;
    }
    const key = ref.toLowerCase();
    return Object.prototype.hasOwnProperty.call(ENTITIES, key) ? ENTITIES[key] : match;
  });
}

export function stripTags(html) {
  return decodeEntities(String(html).replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
}

export function htmlToText(html) {
  let text = String(html);
  text = text.replace(/<!--[\s\S]*?-->/g, ' ');
  text = text.replace(/<(script|style|noscript|template|svg|head)[^>]*>[\s\S]*?<\/\1>/gi, ' ');
  text = text.replace(/<br\s*\/?>/gi, '\n');
  text = text.replace(/<\/(p|div|section|article|li|tr|h[1-6]|blockquote|pre)>/gi, '\n');
  text = text.replace(/<li[^>]*>/gi, '\n- ');
  text = text.replace(/<[^>]*>/g, ' ');
  text = decodeEntities(text);
  text = text.replace(/[ \t\f\v\u00a0]+/g, ' ');
  text = text.replace(/ *\n */g, '\n');
  text = text.replace(/\n{3,}/g, '\n\n');
  return text.trim();
}

// ---- URL safety ----

export function isPrivateAddress(ip) {
  const type = net.isIP(ip);
  if (type === 4) {
    const [a, b] = ip.split('.').map(Number);
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 169 && b === 254) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    if (a === 192 && b === 0) return true;
    if (a === 198 && (b === 18 || b === 19)) return true;
    if (a >= 224) return true;
    return false;
  }
  if (type === 6) {
    const lower = ip.toLowerCase();
    if (lower === '::' || lower === '::1') return true;
    if (/^f[cd]/.test(lower)) return true; // fc00::/7
    if (/^fe[89ab]/.test(lower)) return true; // fe80::/10
    const mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isPrivateAddress(mapped[1]);
    return false;
  }
  return true;
}

export function hostMatches(host, patterns) {
  const h = String(host).toLowerCase();
  return (patterns ?? []).some((pattern) => {
    let p = String(pattern).trim().toLowerCase();
    if (!p) return false;
    if (p.startsWith('*.')) p = p.slice(1);
    if (p.includes('*')) {
      const re = new RegExp(
        `^${p.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`,
      );
      return re.test(h);
    }
    if (p.startsWith('.')) return h === p.slice(1) || h.endsWith(p);
    return h === p || h.endsWith(`.${p}`);
  });
}

// Returns the parsed URL after checking the scheme, the allow/deny lists and,
// unless the host was explicitly allowed, that it resolves to public addresses.
export async function assertSafeUrl(raw, web, { lookup = dns.lookup } = {}) {
  let url;
  try {
    url = new URL(String(raw));
  } catch {
    throw new Error(`invalid URL: ${raw}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`unsupported scheme: ${url.protocol}`);
  }

  const allow = web?.fetch?.allow ?? [];
  const deny = web?.fetch?.deny ?? [];
  const host = url.hostname;
  if (deny.length && hostMatches(host, deny)) throw new Error(`host denied: ${host}`);
  if (allow.length && !hostMatches(host, allow)) throw new Error(`host not in allowlist: ${host}`);
  if (allow.length && hostMatches(host, allow)) return url; // operator opted this host in

  if (net.isIP(host)) {
    if (isPrivateAddress(host)) throw new Error(`refusing to fetch a private address: ${host}`);
    return url;
  }

  let addresses;
  try {
    addresses = await lookup(host, { all: true });
  } catch (err) {
    throw new Error(`cannot resolve ${host}: ${err.code || err.message}`);
  }
  for (const entry of addresses) {
    if (isPrivateAddress(entry.address)) {
      throw new Error(`refusing to fetch ${host}: resolves to private address ${entry.address}`);
    }
  }
  return url;
}

async function readCapped(res, maxBytes) {
  if (res.body?.getReader) {
    const reader = res.body.getReader();
    const chunks = [];
    let size = 0;
    let truncated = false;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = Buffer.from(value);
      chunks.push(chunk);
      size += chunk.length;
      if (size >= maxBytes) {
        truncated = true;
        await reader.cancel().catch(() => {});
        break;
      }
    }
    return { text: Buffer.concat(chunks).subarray(0, maxBytes).toString('utf8'), truncated };
  }
  const buffer = Buffer.from(await res.arrayBuffer());
  return { text: buffer.subarray(0, maxBytes).toString('utf8'), truncated: buffer.length > maxBytes };
}

async function request(url, { fetchImpl, headers = {}, timeoutMs = 20_000, redirect = 'manual' }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();
  try {
    return await fetchImpl(url.toString(), { redirect, headers, signal: controller.signal });
  } catch (err) {
    if (err.name === 'AbortError') throw new Error(`request timed out after ${timeoutMs}ms: ${url}`);
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

function headersFor(fetch) {
  return {
    'User-Agent': fetch?.userAgent || DEFAULT_UA,
    Accept: 'text/html,application/xhtml+xml,application/json;q=0.9,text/plain;q=0.8,*/*;q=0.5',
    'Accept-Language': 'pt-BR,pt;q=0.9,en;q=0.8',
  };
}

export async function fetchUrl(raw, { web, fetchImpl = fetch, lookup } = {}) {
  const config = web?.fetch ?? {};
  const maxBytes = config.maxBytes ?? MAX_BYTES;
  const timeoutMs = config.timeoutMs ?? 20_000;

  let current = String(raw);
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    const url = await assertSafeUrl(current, web, { lookup });
    const res = await request(url, { fetchImpl, headers: headersFor(config), timeoutMs });
    if ([301, 302, 303, 307, 308].includes(res.status)) {
      const location = res.headers.get('location');
      if (!location) throw new Error(`redirect without a location from ${url}`);
      current = new URL(location, url).toString();
      continue;
    }

    const contentType = res.headers.get('content-type') || '';
    const { text: body, truncated } = await readCapped(res, maxBytes);
    let text = body;
    if (/html/i.test(contentType)) text = htmlToText(body);
    else if (/json/i.test(contentType)) {
      try {
        text = JSON.stringify(JSON.parse(body), null, 2);
      } catch {
        // leave the raw body
      }
    }
    return {
      url: url.toString(),
      status: res.status,
      contentType,
      text: text.trim(),
      truncated,
    };
  }
  throw new Error(`too many redirects from ${raw}`);
}

// ---- search ----

function resolveDdgHref(href) {
  let value = decodeEntities(href);
  if (value.startsWith('//')) value = `https:${value}`;
  try {
    const url = new URL(value);
    const target = url.searchParams.get('uddg');
    return target || url.toString();
  } catch {
    return value;
  }
}

export function parseDuckDuckGo(html, limit = 5) {
  const snippets = [];
  const snippetRe = /<a[^>]*class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/gi;
  let match;
  while ((match = snippetRe.exec(html))) snippets.push(stripTags(match[1]));

  const results = [];
  const titleRe = /<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi;
  let index = 0;
  while ((match = titleRe.exec(html)) && results.length < limit) {
    results.push({
      title: stripTags(match[2]),
      url: resolveDdgHref(match[1]),
      snippet: snippets[index] || '',
    });
    index += 1;
  }
  return results;
}

export function parseSearxng(json, limit = 5) {
  return (json?.results ?? []).slice(0, limit).map((r) => ({
    title: r.title || '',
    url: r.url || '',
    snippet: r.content || '',
  }));
}

export function parseBrave(json, limit = 5) {
  return (json?.web?.results ?? []).slice(0, limit).map((r) => ({
    title: r.title || '',
    url: r.url || '',
    snippet: r.description || '',
  }));
}

async function resolveSearchKey(config) {
  const env = process.env;
  if (config.apiKey) return String(config.apiKey);
  if (config.apiKeyEnv && env[config.apiKeyEnv]) return String(env[config.apiKeyEnv]);
  if (config.apiKeyFile) {
    try {
      const text = await fs.readFile(config.apiKeyFile, 'utf8');
      return text.split(/\r?\n/).map((l) => l.trim()).find(Boolean) || null;
    } catch {
      return null;
    }
  }
  return null;
}

// Provider endpoints are configured by the operator, so they bypass the fetch
// allowlist and the private-address guard (a self-hosted SearXNG can be local).
async function providerGet(url, { headers = {}, timeoutMs = 20_000 } = {}, fetchImpl = fetch) {
  const res = await request(new URL(url), { fetchImpl, headers, timeoutMs, redirect: 'follow' });
  const body = await res.text();
  if (!res.ok) throw new Error(`search provider ${res.status}: ${body.trim().slice(0, 200)}`);
  return body;
}

export async function searchWeb(query, { web, fetchImpl = fetch } = {}) {
  const config = web?.search ?? {};
  const provider = config.provider || 'duckduckgo';
  const limit = config.maxResults ?? 5;
  const timeoutMs = config.timeoutMs ?? 20_000;

  if (provider === 'duckduckgo') {
    const html = await providerGet(
      `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`,
      { headers: { ...headersFor(config), Accept: 'text/html' }, timeoutMs },
      fetchImpl,
    );
    return { provider, results: parseDuckDuckGo(html, limit) };
  }

  if (provider === 'searxng') {
    const base = config.baseUrl || 'http://localhost:8080';
    const body = await providerGet(
      `${base.replace(/\/$/, '')}/search?q=${encodeURIComponent(query)}&format=json`,
      { headers: { Accept: 'application/json' }, timeoutMs },
      fetchImpl,
    );
    return { provider, results: parseSearxng(JSON.parse(body), limit) };
  }

  if (provider === 'brave') {
    const key = await resolveSearchKey(config);
    if (!key) throw new Error('brave search needs an API key (web.search.apiKey/apiKeyEnv/apiKeyFile)');
    const body = await providerGet(
      `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${limit}`,
      { headers: { Accept: 'application/json', 'X-Subscription-Token': key }, timeoutMs },
      fetchImpl,
    );
    return { provider, results: parseBrave(JSON.parse(body), limit) };
  }

  throw new Error(`unknown search provider: ${provider}`);
}

// ---- tools ----

function formatResults(query, provider, results) {
  if (!results.length) return `No results for "${query}" (${provider}).`;
  const lines = [`Search: ${query} (${provider})`, ''];
  results.forEach((result, index) => {
    lines.push(`${index + 1}. ${result.title}`);
    lines.push(`   ${result.url}`);
    if (result.snippet) lines.push(`   ${result.snippet}`);
  });
  return lines.join('\n');
}

export function createFetchTool({ config, log }) {
  return {
    name: 'wabox_fetch',
    label: 'Fetch a URL',
    description:
      'Fetch a web page or API over http(s) and return its readable text. Use this for the web: the shell has no network access.',
    promptSnippet: 'Fetch a URL and return readable text',
    promptGuidelines: [
      'Use wabox_fetch for web pages and APIs; the bash tool has no network access.',
      'Prefer wabox_fetch for a known URL and wabox_search when you need to find one.',
    ],
    parameters: Type.Object({
      url: Type.String({ description: 'Absolute http(s) URL to fetch' }),
      maxChars: Type.Optional(
        Type.Number({ description: `Truncate the returned text (default ${MAX_CHARS} chars)` }),
      ),
    }),
    async execute(_id, params) {
      const result = await fetchUrl(params.url, { web: config.web });
      const maxChars = Number.isFinite(params.maxChars) ? Math.max(0, params.maxChars) : MAX_CHARS;
      let text = result.text;
      if (text.length > maxChars) text = `${text.slice(0, maxChars)}\n…[truncated]`;
      const head = `URL: ${result.url}\nStatus: ${result.status}\nContent-Type: ${result.contentType || '(none)'}`;
      log?.debug?.(`[web] fetched ${result.url} (${result.status}, ${text.length} chars)`);
      return {
        content: [{ type: 'text', text: `${head}\n\n${text || '(empty response)'}` }],
        details: { url: result.url, status: result.status, contentType: result.contentType },
      };
    },
  };
}

export function createSearchTool({ config, log }) {
  return {
    name: 'wabox_search',
    label: 'Web search',
    description:
      'Search the web and return result titles, URLs and snippets. Use this to find pages when you do not have a URL.',
    promptSnippet: 'Search the web for a query',
    promptGuidelines: [
      'Use wabox_search to find pages, then wabox_fetch to read one.',
      'The bash tool has no network access; use these tools for the web.',
    ],
    parameters: Type.Object({
      query: Type.String({ description: 'Search query' }),
      count: Type.Optional(Type.Number({ description: 'Maximum number of results' })),
    }),
    async execute(_id, params) {
      const max = Number.isFinite(params.count)
        ? Math.max(1, Math.min(10, params.count))
        : undefined;
      const web = max
        ? { ...config.web, search: { ...config.web?.search, maxResults: max } }
        : config.web;
      const { provider, results } = await searchWeb(params.query, { web });
      log?.debug?.(`[web] searched "${params.query}" via ${provider} (${results.length})`);
      return {
        content: [{ type: 'text', text: formatResults(params.query, provider, results) }],
        details: { provider, results },
      };
    },
  };
}
