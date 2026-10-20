import test from 'node:test';
import assert from 'node:assert/strict';
import { conversationKey, slugFor, conversationLabel } from '../src/routing.js';

test('direct messages are keyed by the chat JID verbatim', () => {
  const lid = { from: '123456789012345@lid', participant: null };
  const pn = { from: '5511999998888@s.whatsapp.net', participant: null };
  assert.equal(conversationKey(lid), lid.from);
  assert.equal(conversationKey(pn), pn.from);
});

test('groups are keyed by the group JID by default', () => {
  const envelope = {
    from: '120363000000000000@g.us',
    participant: '5511999998888@s.whatsapp.net',
  };
  assert.equal(conversationKey(envelope), envelope.from);
  assert.equal(
    conversationKey(envelope, { groupPerParticipant: true }),
    `${envelope.from}|${envelope.participant}`,
  );
});

test('groupPerParticipant only affects groups', () => {
  const envelope = { from: '5511999998888@s.whatsapp.net', participant: null };
  assert.equal(conversationKey(envelope, { groupPerParticipant: true }), envelope.from);
});

test('slugs are stable, safe, and distinct', () => {
  const a = slugFor('5511999998888@s.whatsapp.net');
  const b = slugFor('123456789012345@lid');
  assert.match(a, /^[a-zA-Z0-9._-]+$/);
  assert.notEqual(a, b);
  assert.equal(a, slugFor('5511999998888@s.whatsapp.net'));
  assert.ok(a.startsWith('5511999998888-'));
});

test('labels prefer pushName', () => {
  assert.equal(
    conversationLabel({ from: '5511@s.whatsapp.net', number: '5511', pushName: 'Alice' }),
    'Alice',
  );
  assert.equal(
    conversationLabel({
      from: '120363@g.us',
      participant: '5511@s.whatsapp.net',
      number: '5511',
      pushName: 'Alice',
    }),
    'Alice (group)',
  );
});
