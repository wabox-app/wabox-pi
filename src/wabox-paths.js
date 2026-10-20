// Resolve the folders wabox-core uses. Precedence:
//   WABOX_INBOX / WABOX_OUTBOX env  >  `wabox status`  >  XDG default.
//
// We deliberately ask the CLI instead of reading wabox's config.json: its
// internal layout is core's business, and `wabox status` is the documented
// surface (see wabox README / INTEGRATION.md).

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { xdg } from './paths.js';

function fromWaboxStatus() {
  // `wabox status --json` exists in newer cores; fall back to the human output.
  const json = spawnSync('wabox', ['status', '--json'], {
    encoding: 'utf8',
    timeout: 3_000,
  });
  if (json.status === 0 && json.stdout) {
    try {
      const parsed = JSON.parse(json.stdout);
      if (parsed?.inbox && parsed?.outbox) {
        return { inboxDir: parsed.inbox, outboxDir: parsed.outbox };
      }
    } catch {
      // Older cores treat `--json` as an unknown argument; try plain status.
    }
  }

  const plain = spawnSync('wabox', ['status'], { encoding: 'utf8', timeout: 3_000 });
  if (plain.status === 0 && plain.stdout) {
    const pick = (label) => {
      const re = new RegExp(`^\\s*${label}\\s*:\\s*(.+?)\\s*$`, 'mi');
      return plain.stdout.match(re)?.[1] || null;
    };
    return { inboxDir: pick('inbox'), outboxDir: pick('outbox') };
  }
  return {};
}

export function resolveWaboxPaths() {
  const defaults = {
    inboxDir: path.join(xdg.data(), 'wabox', 'inbox'),
    outboxDir: path.join(xdg.data(), 'wabox', 'outbox'),
  };
  const discovered = fromWaboxStatus();
  return {
    inboxDir: process.env.WABOX_INBOX || discovered.inboxDir || defaults.inboxDir,
    outboxDir: process.env.WABOX_OUTBOX || discovered.outboxDir || defaults.outboxDir,
  };
}
