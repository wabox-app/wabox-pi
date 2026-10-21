// Token and cost accounting for the log.
//
// pi reports usage on assistant messages (`usage.input`, `usage.output`,
// `usage.cacheRead`, `usage.cacheWrite`, `usage.cost`). The context size is
// estimated from the session projection by pi itself
// (`session.getContextUsage()`), which knows about compaction.
//
// Pure helpers, so they are easy to test.

export function formatTokens(value) {
  const n = Number(value ?? 0);
  if (!Number.isFinite(n)) return '0';
  if (n < 1000) return String(Math.round(n));
  if (n < 10_000) return `${(n / 1000).toFixed(1)}k`;
  if (n < 1_000_000) return `${Math.round(n / 1000)}k`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}

export function formatCost(value) {
  const n = Number(value ?? 0);
  if (!Number.isFinite(n)) return '$0';
  if (n === 0) return '$0';
  if (n < 0.01) return `$${n.toFixed(5)}`;
  return `$${n.toFixed(4)}`;
}

// Sum the usage of the assistant messages at or after `fromIndex`.
export function summarizeUsage(messages, fromIndex = 0) {
  const sum = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    reasoning: 0,
    total: 0,
    cost: 0,
    requests: 0,
  };
  const list = messages ?? [];
  for (let i = Math.max(0, fromIndex); i < list.length; i += 1) {
    const message = list[i];
    if (message?.role !== 'assistant' || !message.usage) continue;
    const usage = message.usage;
    sum.requests += 1;
    sum.input += usage.input ?? 0;
    sum.output += usage.output ?? 0;
    sum.cacheRead += usage.cacheRead ?? 0;
    sum.cacheWrite += usage.cacheWrite ?? 0;
    sum.reasoning += usage.reasoning ?? 0;
    sum.total += usage.totalTokens ?? 0;
    sum.cost += usage.cost?.total ?? 0;
  }
  return sum;
}

// A compact, log-friendly line: "tokens in 1.2k out 340 cache 0.0k | $0.00012".
export function formatUsage(usage) {
  if (!usage || !usage.requests) return 'tokens none';
  const parts = [`in ${formatTokens(usage.input)}`, `out ${formatTokens(usage.output)}`];
  if (usage.cacheRead) parts.push(`cacheRead ${formatTokens(usage.cacheRead)}`);
  if (usage.cacheWrite) parts.push(`cacheWrite ${formatTokens(usage.cacheWrite)}`);
  if (usage.reasoning) parts.push(`reasoning ${formatTokens(usage.reasoning)}`);
  parts.push(`total ${formatTokens(usage.total)}`);
  parts.push(formatCost(usage.cost));
  return `tokens ${parts.join(' ')}`;
}

// "ctx 45.2k/262.1k (17%)".
export function formatContext(contextUsage) {
  if (!contextUsage) return 'ctx unknown';
  const { tokens, contextWindow, percent } = contextUsage;
  if (tokens === null || tokens === undefined) {
    return `ctx unknown/${formatTokens(contextWindow)}`;
  }
  const share = percent === null || percent === undefined
    ? ''
    : ` (${percent.toFixed(1)}%)`;
  return `ctx ${formatTokens(tokens)}/${formatTokens(contextWindow)}${share}`;
}
