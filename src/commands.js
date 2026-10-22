// Chat commands handled by the harness itself. Anything else that starts with
// "/" is passed to pi, so pi slash commands and skills keep working.

export const LOCAL_COMMANDS = new Set([
  'help',
  'ping',
  'status',
  'model',
  'jobs',
  'tasks',
  'schedule',
  'unschedule',
  'cancel',
  'new',
  'reset',
  'clear',
  'memory',
]);

export const HELP = [
  '*wabox-pi*',
  '/help — this message',
  '/status — session and workspace info',
  '/model — configured and active chat model',
  '/jobs — list scheduled jobs (alias /tasks)',
  '/schedule <cron> <prompt> — schedule a job for this chat',
  '/unschedule <name> — remove a job you scheduled from chat',
  '/new — start a fresh conversation session',
  '/memory — show or clear durable notes (memory.md)',
  '/ping — check that the harness is alive',
].join('\n');

// Parse `/schedule`. The cron is either a single @alias or exactly five
// whitespace-separated fields; the rest is the prompt. Returns `{ cron, prompt }`
// or `{ error }`.
export function parseScheduleCommand(args) {
  const text = (args || '').trim();
  if (!text) {
    return { error: 'Usage: /schedule <minute hour day month weekday> <prompt>' };
  }
  const tokens = text.split(/\s+/);
  if (tokens[0].startsWith('@')) {
    const prompt = tokens.slice(1).join(' ').trim();
    if (!prompt) return { error: 'Missing prompt. Usage: /schedule @daily <prompt>' };
    return { cron: tokens[0], prompt };
  }
  if (tokens.length < 6) {
    return {
      error:
        'Usage: /schedule <minute hour day month weekday> <prompt>\n' +
        'Example: /schedule 0 9 * * * Lembrar de tomar o remédio',
    };
  }
  return { cron: tokens.slice(0, 5).join(' '), prompt: tokens.slice(5).join(' ') };
}

export function parseLocalCommand(text) {
  const match = /^\/([a-zA-Z0-9_-]+)\s*([\s\S]*)$/.exec((text || '').trim());
  if (!match) return null;
  const name = match[1].toLowerCase();
  if (!LOCAL_COMMANDS.has(name)) return null;
  return { name, args: match[2].trim() };
}
