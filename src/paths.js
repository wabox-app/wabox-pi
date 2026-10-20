// Cross-platform path helpers. Pure: no directory creation, no config reads.

import os from 'node:os';
import path from 'node:path';

export function expandHome(p) {
  if (!p) return p;
  if (p === '~') return os.homedir();
  if (p.startsWith('~/') || p.startsWith('~\\')) {
    return path.join(os.homedir(), p.slice(2));
  }
  return p;
}

export function resolveFrom(base, p) {
  if (!p) return p;
  const expanded = expandHome(String(p));
  return path.isAbsolute(expanded) ? path.normalize(expanded) : path.resolve(base, expanded);
}

export const xdg = {
  config: () => process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'),
  data: () => process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'),
  state: () => process.env.XDG_STATE_HOME || path.join(os.homedir(), '.local', 'state'),
};
