// Small dependency-free logger. Every line goes to stderr and the state log.
// Agent stdout is never ours to use, but this daemon has no stdout contract.

import fs from 'node:fs';
import path from 'node:path';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

function formatValue(value) {
  if (value instanceof Error) return value.stack || value.message;
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export function createLogger({ level = 'info', file = null } = {}) {
  const threshold = LEVELS[level] ?? LEVELS.info;
  let stream = null;

  if (file) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    stream = fs.createWriteStream(file, { flags: 'a' });
    // A logging failure must never take the daemon down.
    stream.on('error', (err) => {
      process.stderr.write(`logger: cannot write ${file}: ${err.message}\n`);
      stream = null;
    });
  }

  const write = (name, args) => {
    if (LEVELS[name] < threshold) return;
    const message = args.map(formatValue).join(' ');
    const line = `${new Date().toISOString()} ${name.toUpperCase().padEnd(5)} ${message}`;
    process.stderr.write(`${line}\n`);
    stream?.write(`${line}\n`);
  };

  return {
    debug: (...args) => write('debug', args),
    info: (...args) => write('info', args),
    warn: (...args) => write('warn', args),
    error: (...args) => write('error', args),
    close: () => stream?.end(),
  };
}
