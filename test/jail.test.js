import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  buildBwrapCommand,
  resolveBashTool,
  resolveInside,
  shellQuote,
  toolPathArgs,
  workspaceJailExtension,
} from '../src/jail.js';

async function scratch() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wabox-jail-'));
  const workspace = path.join(root, 'workspace');
  const state = path.join(root, 'state');
  const media = path.join(state, 'conversations', 'slug', 'media');
  const outside = path.join(root, 'outside');
  await fs.mkdir(workspace, { recursive: true });
  await fs.mkdir(media, { recursive: true });
  await fs.mkdir(outside, { recursive: true });
  await fs.writeFile(path.join(media, 'note.txt'), 'hello\n');
  return { root, workspace, state, media, outside };
}

test('resolveInside allows paths under a root', async () => {
  const { workspace } = await scratch();
  const check = await resolveInside([workspace], 'notes/todo.txt', workspace);
  assert.equal(check.inside, true);
  assert.equal(check.path, path.join(workspace, 'notes/todo.txt'));
});

test('resolveInside blocks paths outside every root', async () => {
  const { workspace, outside } = await scratch();
  const check = await resolveInside([workspace], path.join(outside, 'secret'), workspace);
  assert.equal(check.inside, false);
});

test('resolveInside allows an extra read root', async () => {
  const { workspace, media, outside } = await scratch();
  const attachment = path.join(media, 'photo.jpg');
  await fs.writeFile(attachment, 'x');
  const allowed = await resolveInside([workspace, media], attachment, workspace);
  assert.equal(allowed.inside, true);
  const denied = await resolveInside([workspace, media], path.join(outside, 'x'), workspace);
  assert.equal(denied.inside, false);
});

test('resolveInside catches a symlink escape', async () => {
  const { workspace } = await scratch();
  await fs.symlink(os.tmpdir(), path.join(workspace, 'sneaky'));
  const check = await resolveInside([workspace], 'sneaky/passwd', workspace);
  assert.equal(check.inside, false);
});

test('resolveInside checks a not-yet-existing file through its parent', async () => {
  const { workspace } = await scratch();
  const check = await resolveInside([workspace], 'brand/new/file.txt', workspace);
  assert.equal(check.inside, true);
});

test('toolPathArgs maps tools to their path arguments', () => {
  assert.deepEqual(toolPathArgs('read', { path: 'a.txt' }, '/w'), [
    { key: 'path', value: 'a.txt', base: '/w' },
  ]);
  assert.deepEqual(toolPathArgs('ls', {}, '/w'), []);
  assert.deepEqual(toolPathArgs('wabox_send', { files: ['a', '', 'b'] }, '/w'), [
    { key: 'files', value: 'a', base: '/w' },
    { key: 'files', value: 'b', base: '/w' },
  ]);
  assert.deepEqual(toolPathArgs('bash', { command: 'ls' }, '/w'), []);
});

test('the extension blocks path escapes and allows in-workspace reads', async () => {
  const { workspace, outside } = await scratch();
  const handlers = [];
  const pi = { on: (event, handler) => handlers.push([event, handler]) };
  workspaceJailExtension({ workspace })(pi);

  const [, handler] = handlers.find(([event]) => event === 'tool_call');
  const blocked = await handler({ toolName: 'read', input: { path: path.join(outside, 'x') } });
  assert.equal(blocked.block, true);
  assert.match(blocked.reason, /outside your workspace/);

  const allowed = await handler({ toolName: 'read', input: { path: 'notes.txt' } });
  assert.equal(allowed, undefined);
});

test('buildBwrapCommand makes the host read-only and the workspace writable', () => {
  const command = buildBwrapCommand({ workspace: '/home/me/ws', command: 'echo hi' });
  assert.ok(command.includes("'--ro-bind' '/' '/'"));
  assert.ok(command.includes("'--bind' '/home/me/ws' '/home/me/ws'"));
  assert.ok(command.includes("'--tmpfs' '/tmp'"));
  assert.ok(command.includes("'--die-with-parent'"));
  assert.ok(!command.includes('--unshare-net'));
  assert.ok(command.endsWith("'/bin/bash' '-c' 'echo hi'"));
});

test('buildBwrapCommand can isolate the network and hide directories', () => {
  const command = buildBwrapCommand({
    workspace: '/ws',
    command: 'curl x',
    network: false,
    denyRead: ['/home/me/.ssh'],
  });
  assert.ok(command.includes("'--unshare-net'"));
  assert.ok(command.includes("'--tmpfs' '/home/me/.ssh'"));
});

test('buildBwrapCommand re-exposes allowed paths read-only after a deny', () => {
  const command = buildBwrapCommand({
    workspace: '/ws',
    command: 'node -v',
    denyRead: ['/home/me'],
    allowRead: ['/home/me/.local/share/mise'],
  });
  const hide = command.indexOf("'--tmpfs' '/home/me'");
  const show = command.indexOf("'--ro-bind' '/home/me/.local/share/mise' '/home/me/.local/share/mise'");
  const bind = command.indexOf("'--bind' '/ws' '/ws'");
  assert.ok(hide !== -1 && show > hide && bind > show);
});

test('shellQuote survives embedded single quotes', () => {
  assert.equal(shellQuote(`it's fine`), `'it'\\''s fine'`);
});

test('resolveBashTool exposes read roots read-only inside the sandbox', async () => {
  const { workspace, state, media } = await scratch();
  const tool = resolveBashTool({
    config: {
      sandboxBash: 'bwrap',
      sandboxNetwork: false,
      sandboxDenyRead: [],
      stateDir: state,
    },
    workspace,
    readRoots: [media],
    log: { info() {}, warn() {} },
  });
  assert.ok(tool, 'expected a sandboxed bash tool');

  // The media folder is visible and readable, but not writable.
  const res = await tool.execute(
    'id',
    { command: `cat "${media}/note.txt"; echo x > "${media}/new.txt" 2>&1 || echo MEDIA-READONLY` },
    undefined,
    () => {},
  );
  const output = res.content.map((c) => c.text).join('\n');
  assert.match(output, /hello/);
  assert.match(output, /MEDIA-READONLY/);
});

test('resolveBashTool returns null when the sandbox is off', async () => {
  const { workspace } = await scratch();
  const tool = resolveBashTool({
    config: { sandboxBash: 'off' },
    workspace,
    log: { info() {}, warn() {} },
  });
  assert.equal(tool, null);
});
