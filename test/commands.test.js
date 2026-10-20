import test from 'node:test';
import assert from 'node:assert/strict';
import { parseLocalCommand, parseScheduleCommand } from '../src/commands.js';

test('parses known local commands case-insensitively', () => {
  assert.deepEqual(parseLocalCommand('/new'), { name: 'new', args: '' });
  assert.deepEqual(parseLocalCommand('/Help'), { name: 'help', args: '' });
  assert.deepEqual(parseLocalCommand('  /status now '), { name: 'status', args: 'now' });
});

test('leaves unknown and non-commands for pi', () => {
  assert.equal(parseLocalCommand('/compact'), null);
  assert.equal(parseLocalCommand('hello /help'), null);
  assert.equal(parseLocalCommand(''), null);
});

test('recognises job commands', () => {
  assert.deepEqual(parseLocalCommand('/jobs'), { name: 'jobs', args: '' });
  assert.deepEqual(parseLocalCommand('/schedule 0 9 * * * oi'), {
    name: 'schedule',
    args: '0 9 * * * oi',
  });
  assert.deepEqual(parseLocalCommand('/unschedule tomar-remedio'), {
    name: 'unschedule',
    args: 'tomar-remedio',
  });
});

test('parseScheduleCommand splits the five cron fields from the prompt', () => {
  assert.deepEqual(parseScheduleCommand('0 9 * * * Lembrar de tomar remédio'), {
    cron: '0 9 * * *',
    prompt: 'Lembrar de tomar remédio',
  });
  assert.deepEqual(parseScheduleCommand('*/30 * * * * checar email'), {
    cron: '*/30 * * * *',
    prompt: 'checar email',
  });
  assert.deepEqual(parseScheduleCommand('@daily regar plantas'), {
    cron: '@daily',
    prompt: 'regar plantas',
  });
});

test('parseScheduleCommand reports usage errors', () => {
  assert.match(parseScheduleCommand('').error, /Usage/);
  assert.match(parseScheduleCommand('0 9 * *').error, /Usage/);
  assert.match(parseScheduleCommand('@daily').error, /prompt/i);
});
