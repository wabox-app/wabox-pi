// Chat commands handled by the harness itself. Anything else that starts with
// "/" is passed to pi, so pi slash commands and skills keep working.

export const LOCAL_COMMANDS = new Set(['help', 'ping', 'status', 'tasks', 'new', 'reset', 'clear']);

export const HELP = [
  '*wabox-pi*',
  '/help — this message',
  '/status — session and workspace info',
  '/tasks — list scheduled tasks and their next run',
  '/new — start a fresh conversation session',
  '/ping — check that the harness is alive',
].join('\n');

export function parseLocalCommand(text) {
  const match = /^\/([a-zA-Z0-9_-]+)\s*([\s\S]*)$/.exec((text || '').trim());
  if (!match) return null;
  const name = match[1].toLowerCase();
  if (!LOCAL_COMMANDS.has(name)) return null;
  return { name, args: match[2].trim() };
}
