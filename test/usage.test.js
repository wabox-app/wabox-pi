import test from 'node:test';
import assert from 'node:assert/strict';
import { formatContext, formatCost, formatTokens, formatUsage, summarizeUsage } from '../src/usage.js';

test('formatTokens scales the number', () => {
  assert.equal(formatTokens(0), '0');
  assert.equal(formatTokens(999), '999');
  assert.equal(formatTokens(1500), '1.5k');
  assert.equal(formatTokens(45_200), '45k');
  assert.equal(formatTokens(1_600_000), '1.60M');
  assert.equal(formatTokens(undefined), '0');
});

test('formatCost keeps small amounts readable', () => {
  assert.equal(formatCost(0), '$0');
  assert.equal(formatCost(0.000123), '$0.00012');
  assert.equal(formatCost(1.2345), '$1.2345');
});

test('summarizeUsage sums the assistant messages from an index', () => {
  const messages = [
    { role: 'user', content: 'oi' },
    {
      role: 'assistant',
      usage: { input: 100, output: 20, cacheRead: 5, cacheWrite: 1, reasoning: 7, totalTokens: 126, cost: { total: 0.001 } },
    },
    { role: 'toolResult', content: 'x' },
    {
      role: 'assistant',
      usage: { input: 200, output: 30, cacheRead: 0, cacheWrite: 0, totalTokens: 230, cost: { total: 0.002 } },
    },
  ];

  const all = summarizeUsage(messages, 0);
  assert.equal(all.requests, 2);
  assert.equal(all.input, 300);
  assert.equal(all.output, 50);
  assert.equal(all.cacheRead, 5);
  assert.equal(all.reasoning, 7);
  assert.equal(all.total, 356);
  assert.equal(Math.round(all.cost * 10000), 30);

  const lastOnly = summarizeUsage(messages, 3);
  assert.equal(lastOnly.requests, 1);
  assert.equal(lastOnly.input, 200);
});

test('summarizeUsage ignores messages without usage', () => {
  const usage = summarizeUsage([{ role: 'assistant' }, { role: 'user' }], 0);
  assert.equal(usage.requests, 0);
  assert.equal(usage.input, 0);
});

test('formatUsage renders a compact line', () => {
  const usage = summarizeUsage([
    {
      role: 'assistant',
      usage: { input: 1200, output: 340, cacheRead: 0, cacheWrite: 0, totalTokens: 1540, cost: { total: 0.0002 } },
    },
  ], 0);
  const line = formatUsage(usage);
  assert.match(line, /tokens in 1\.2k out 340/);
  assert.match(line, /total 2k|total 1\.5k/);
  assert.equal(formatUsage(summarizeUsage([], 0)), 'tokens none');
});

test('formatContext shows the share of the window', () => {
  assert.equal(formatContext({ tokens: 45_200, contextWindow: 262_144, percent: 17.2 }), 'ctx 45k/262k (17.2%)');
  assert.equal(formatContext({ tokens: null, contextWindow: 262_144, percent: null }), 'ctx unknown/262k');
  assert.equal(formatContext(null), 'ctx unknown');
});
