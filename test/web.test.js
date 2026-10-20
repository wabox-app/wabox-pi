import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {
  assertSafeUrl,
  decodeEntities,
  fetchUrl,
  hostMatches,
  htmlToText,
  isPrivateAddress,
  parseBrave,
  parseDuckDuckGo,
  parseSearxng,
  searchWeb,
  stripTags,
} from '../src/web.js';

test('isPrivateAddress covers the usual SSRF ranges', () => {
  for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '192.168.1.1', '169.254.1.1', '100.64.0.1', '0.0.0.0', '::1', 'fd00::1', 'fe80::1']) {
    assert.equal(isPrivateAddress(ip), true, ip);
  }
  for (const ip of ['1.1.1.1', '93.184.216.34', '2606:4700:4700::1111']) {
    assert.equal(isPrivateAddress(ip), false, ip);
  }
});

test('hostMatches handles suffixes, wildcards and subdomains', () => {
  assert.equal(hostMatches('wttr.in', ['wttr.in']), true);
  assert.equal(hostMatches('a.wttr.in', ['wttr.in']), true);
  assert.equal(hostMatches('evil-wttr.in', ['wttr.in']), false);
  assert.equal(hostMatches('api.example.com', ['.example.com']), true);
  assert.equal(hostMatches('api.example.com', ['*.example.com']), true);
  assert.equal(hostMatches('example.com', ['.example.com']), true);
});

test('htmlToText strips tags and decodes entities', () => {
  const text = htmlToText('<h1>Hi</h1><script>bad()</script><p>a &amp; b</p><li>one</li>');
  assert.match(text, /Hi/);
  assert.match(text, /a & b/);
  assert.match(text, /one/);
  assert.doesNotMatch(text, /bad\(\)/);
  assert.equal(decodeEntities('&lt;x&gt; &#39;y&#39;'), "<x> 'y'");
  assert.equal(stripTags('<b>bold</b> text'), 'bold text');
});

test('parseDuckDuckGo extracts decoded result URLs', () => {
  const html = `
    <h2 class="result__title"><a rel="nofollow" class="result__a"
      href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fge.globo.com%2Fflamengo%2F&amp;rut=x">Flamengo | ge</a></h2>
    <a class="result__snippet" href="x">Últimas notícias do Flamengo.</a>
  `;
  const [result] = parseDuckDuckGo(html, 5);
  assert.equal(result.title, 'Flamengo | ge');
  assert.equal(result.url, 'https://ge.globo.com/flamengo/');
  assert.equal(result.snippet, 'Últimas notícias do Flamengo.');
});

test('parseSearxng and parseBrave map their shapes', () => {
  assert.deepEqual(parseSearxng({ results: [{ title: 'T', url: 'U', content: 'C' }] }), [
    { title: 'T', url: 'U', snippet: 'C' },
  ]);
  assert.deepEqual(parseBrave({ web: { results: [{ title: 'T', url: 'U', description: 'D' }] } }), [
    { title: 'T', url: 'U', snippet: 'D' },
  ]);
});

test('assertSafeUrl blocks private and disallowed hosts', async () => {
  await assert.rejects(assertSafeUrl('http://127.0.0.1/x', { fetch: {} }), /private/);
  await assert.rejects(assertSafeUrl('ftp://example.com', { fetch: {} }), /scheme/);
  await assert.rejects(assertSafeUrl('http://example.com', { fetch: { allow: ['other.com'] } }), /allowlist/);
  const publicLookup = async () => [{ address: '93.184.216.34' }];
  assert.ok(await assertSafeUrl('https://example.com', { fetch: {} }, { lookup: publicLookup }));
  await assert.rejects(
    assertSafeUrl('https://example.com', { fetch: {} }, { lookup: async () => [{ address: '10.0.0.1' }] }),
    /private/,
  );
  // An explicit allow entry opts the host in, even locally (for tests/local services).
  assert.ok(await assertSafeUrl('http://127.0.0.1:8080/x', { fetch: { allow: ['127.0.0.1'] } }));
});

test('fetchUrl reads a page, follows a redirect and converts HTML', async () => {
  const server = http.createServer((req, res) => {
    if (req.url === '/go') {
      res.writeHead(302, { location: '/page' });
      res.end();
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<html><body><h1>Hello</h1><p>world</p></body></html>');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const web = { fetch: { allow: ['127.0.0.1'] } };

  try {
    const result = await fetchUrl(`http://127.0.0.1:${port}/go`, { web });
    assert.equal(result.status, 200);
    assert.equal(result.url, `http://127.0.0.1:${port}/page`);
    assert.match(result.text, /Hello/);
    assert.match(result.text, /world/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('searchWeb duckduckgo parses the provider response', async () => {
  const html = `
    <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fa">A</a>
    <a class="result__snippet">about a</a>
  `;
  const fetchImpl = async () => ({ ok: true, status: 200, text: async () => html });
  const { provider, results } = await searchWeb('anything', {
    web: { search: { provider: 'duckduckgo', maxResults: 5 } },
    fetchImpl,
  });
  assert.equal(provider, 'duckduckgo');
  assert.deepEqual(results, [{ title: 'A', url: 'https://example.com/a', snippet: 'about a' }]);
});
