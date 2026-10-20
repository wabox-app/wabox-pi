// Keep a conversation's pi session inside its workspace.
//
// Two layers, because pi itself has no sandbox (see pi's docs/security.md):
//
//   1. File tools (`read`, `edit`, `write`, `grep`, `find`, `ls`) and the file
//      attachments of `wabox_send` are path-jailed by a `tool_call` extension
//      handler. A path that resolves outside the allowed roots is blocked
//      before the tool runs, including through symlinks.
//   2. `bash` cannot be path-jailed in-process (a shell can `cd /` or
//      `cat /etc/shadow`), so it is wrapped with bubblewrap: the host root is
//      read-only, the workspace is the only writable path, `$HOME` and the XDG
//      dirs are redirected into the workspace, and sensitive dirs are hidden.
//
// Layer 2 needs bubblewrap (`bwrap`). Without it, `sandboxBash: "bwrap"` makes
// session creation fail rather than fall back to an unsandboxed shell.

import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createBashTool } from '@earendil-works/pi-coding-agent';

// Which tool argument holds a path. A string is a single path; an array is a
// list of paths (only `wabox_send` uses that).
const PATH_ARGS = {
  read: 'path',
  edit: 'path',
  write: 'path',
  grep: 'path',
  find: 'path',
  ls: 'path',
};

// Read-only tools may also reach roots that are not writable (the conversation
// media folder), so the model can read inbound attachments.
const READ_TOOLS = new Set(['read', 'grep', 'find', 'ls']);

export function expandHome(value) {
  if (typeof value !== 'string' || !value.startsWith('~')) return value;
  return path.join(os.homedir(), value.slice(1));
}

// Resolve `candidate` against `workspace`, following symlinks, and report
// whether the result stays inside any of `roots`. Missing paths are checked
// through their nearest existing ancestor, so writes to new files are allowed
// while a symlinked parent that leaves the roots is not.
export async function resolveInside(roots, candidate, base) {
  const list = Array.isArray(roots) ? roots : [roots];
  const realRoots = await Promise.all(
    list
      .filter(Boolean)
      .map(async (root) => realpathOr(path.resolve(root), path.resolve(root))),
  );

  const raw = String(candidate ?? '.');
  const abs = path.isAbsolute(raw) ? path.normalize(raw) : path.resolve(base, raw);

  const resolved = await realpathNearest(abs);
  const inside = realRoots.some(
    (root) => resolved === root || resolved.startsWith(root + path.sep),
  );
  return { inside, requested: raw, path: abs, resolved };
}

// The raw path arguments of a tool call, resolved against `base`, as
// `{ key, value }` pairs. Empty/inapplicable values are skipped.
export function toolPathArgs(toolName, input, base) {
  if (toolName === 'wabox_send') {
    const files = Array.isArray(input?.files) ? input.files : [];
    return files
      .filter((file) => typeof file === 'string' && file.trim())
      .map((value) => ({ key: 'files', value, base }));
  }
  const key = PATH_ARGS[toolName];
  if (!key) return [];
  const value = input?.[key];
  if (typeof value !== 'string' || !value.trim()) return [];
  return [{ key, value, base }];
}

// The inline extension that enforces layer 1. Pass it through
// DefaultResourceLoader's `extensionFactories`.
export function workspaceJailExtension({ workspace, readRoots = [], log }) {
  const writeRoots = [workspace];
  const allReadRoots = [workspace, ...readRoots];

  return (pi) => {
    pi.on('tool_call', async (event) => {
      const readOnly = READ_TOOLS.has(event.toolName);
      const roots = readOnly ? allReadRoots : writeRoots;
      for (const arg of toolPathArgs(event.toolName, event.input, workspace)) {
        const check = await resolveInside(roots, arg.value, workspace);
        if (!check.inside) {
          log?.warn(`[jail] blocked ${event.toolName} ${arg.key}=${arg.value} (${check.resolved})`);
          return {
            block: true,
            reason: `\`${event.toolName}\` cannot access \`${check.requested}\`: it is outside your workspace. Work only inside ${workspace}.`,
          };
        }
      }
      return undefined;
    });
  };
}

export function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

let bwrapProbe;

export function bwrapAvailable(bin = 'bwrap') {
  const key = bin;
  if (bwrapProbe && bwrapProbe.key === key) return bwrapProbe.ok;
  let ok = false;
  try {
    ok = spawnSync(key, ['--version'], { stdio: 'ignore' }).status === 0;
  } catch {
    ok = false;
  }
  bwrapProbe = { key, ok };
  return ok;
}

export function existingPaths(values) {
  return values
    .map(expandHome)
    .filter((value) => typeof value === 'string' && value.trim())
    .filter((value) => {
      try {
        return fs.existsSync(value);
      } catch {
        return false;
      }
    });
}

// A bubblewrap invocation that runs `command` with the host read-only and only
// `workspace` writable. `denyRead` entries are overlaid with an empty tmpfs;
// `allowRead` re-exposes paths (read-only) inside a denied parent, and the
// workspace bind comes last so it always wins.
export function buildBwrapCommand({
  workspace,
  command,
  bin = 'bwrap',
  network = true,
  denyRead = [],
  allowRead = [],
}) {
  const args = [
    bin,
    '--ro-bind',
    '/',
    '/',
    '--dev-bind',
    '/dev',
    '/dev',
    '--proc',
    '/proc',
    '--tmpfs',
    '/tmp',
  ];
  for (const dir of denyRead) args.push('--tmpfs', dir);
  for (const dir of allowRead) args.push('--ro-bind', dir, dir);
  args.push(
    '--bind',
    workspace,
    workspace,
    '--chdir',
    workspace,
    '--unshare-pid',
    '--unshare-ipc',
    '--unshare-uts',
    '--unshare-cgroup',
    '--die-with-parent',
  );
  if (!network) args.push('--unshare-net');
  args.push('--', '/bin/bash', '-c', command);
  return args.map(shellQuote).join(' ');
}

// A drop-in replacement for pi's built-in `bash` that runs every command under
// bubblewrap. `ensureSession` passes it through `customTools`, which overrides
// the built-in of the same name.
export function createSandboxedBashTool({
  workspace,
  bin = 'bwrap',
  network = true,
  denyRead = [],
  allowRead = [],
}) {
  // Ordering in buildBwrapCommand() re-exposes the workspace after any hidden
  // ancestor, so the default workspace (which lives under stateDir) stays
  // visible even though stateDir is hidden. `allowRead` brings back toolchains
  // under a denied `$HOME`.
  const hidden = existingPaths(denyRead);
  const visible = existingPaths(allowRead);

  return createBashTool(workspace, {
    spawnHook: ({ command, cwd, env }) => ({
      command: buildBwrapCommand({
        workspace,
        command,
        bin,
        network,
        denyRead: hidden,
        allowRead: visible,
      }),
      cwd,
      env: {
        ...env,
        HOME: workspace,
        XDG_CONFIG_HOME: path.join(workspace, '.config'),
        XDG_CACHE_HOME: path.join(workspace, '.cache'),
        XDG_DATA_HOME: path.join(workspace, '.local', 'share'),
        XDG_STATE_HOME: path.join(workspace, '.local', 'state'),
      },
    }),
  });
}

// Decide whether/how to sandbox bash, based on `sandboxBash`:
//   "off"   - no sandbox
//   "auto"  - bubblewrap when available, otherwise warn and run unsandboxed
//   "bwrap" - bubblewrap required; throw if it is missing
//
// Returns a tool to add to `customTools`, or null to keep pi's built-in bash.
export function resolveBashTool({ config, workspace, log }) {
  const mode = config.sandboxBash ?? 'auto';
  if (mode === 'off') return null;

  const bin = config.sandboxBashBin || 'bwrap';
  if (!bwrapAvailable(bin)) {
    const message = `bash sandbox requested (sandboxBash=${mode}) but ${bin} is not available`;
    if (mode === 'bwrap') throw new Error(message);
    log?.warn(`${message}; bash will run unsandboxed`);
    return null;
  }

  const denyRead = [
    ...(config.sandboxDenyRead ?? []),
    config.stateDir,
    config.inboxDir,
    config.outboxDir,
  ].filter(Boolean);
  log?.info(`sandboxing bash with ${bin} (workspace ${workspace})`);
  return createSandboxedBashTool({
    workspace,
    bin,
    network: config.sandboxNetwork !== false,
    denyRead,
    allowRead: config.sandboxAllowRead ?? [],
  });
}

async function realpathOr(target, fallback) {
  try {
    return await fs.promises.realpath(target);
  } catch {
    return fallback;
  }
}

// realpath the nearest existing ancestor of `target`. A path that does not
// exist yet is placed under that ancestor, which is what makes symlink escapes
// through a parent directory detectable.
async function realpathNearest(target) {
  let probe = target;
  for (;;) {
    const real = await realpathOr(probe, null);
    if (real) return real;
    const parent = path.dirname(probe);
    if (parent === probe) return target;
    probe = parent;
  }
}
