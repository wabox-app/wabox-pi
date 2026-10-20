import test from 'node:test';
import assert from 'node:assert/strict';
import { parseLocalCommand } from '../src/commands.js';

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
