import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCron, cronMatches, nextCronDate, zonedParts } from '../src/cron.js';

test('parses aliases and numeric fields', () => {
  assert.deepEqual([...parseCron('@daily').sets.hour], [0]);
  assert.deepEqual([...parseCron('@hourly').sets.minute], [0]);
  assert.deepEqual([...parseCron('*/15 * * * *').sets.minute], [0, 15, 30, 45]);
  assert.deepEqual([...parseCron('1-5 * * * *').sets.minute], [1, 2, 3, 4, 5]);
  assert.deepEqual([...parseCron('1,10,20 * * * *').sets.minute], [1, 10, 20]);
});

test('normalizes Sunday 7 to 0', () => {
  const parsed = parseCron('0 0 * * 7');
  assert.ok(parsed.sets.dow.has(0));
  assert.ok(!parsed.sets.dow.has(7));
});

test('rejects malformed expressions', () => {
  assert.throws(() => parseCron(''), /empty/);
  assert.throws(() => parseCron('* * *'), /5 fields/);
  assert.throws(() => parseCron('60 * * * *'), /out of range/);
  assert.throws(() => parseCron('*/0 * * * *'), /step/);
  assert.throws(() => parseCron('5-1 * * * *'), /out of range/);
});

test('matches in the configured time zone', () => {
  // 08:00 America/Sao_Paulo is 11:00 UTC (no DST since 2019).
  const parsed = parseCron('0 8 * * *');
  assert.equal(cronMatches(parsed, new Date('2026-10-20T11:00:00Z'), 'America/Sao_Paulo'), true);
  assert.equal(cronMatches(parsed, new Date('2026-10-20T12:00:00Z'), 'America/Sao_Paulo'), false);
});

test('day-of-month and day-of-week combine with OR when both are restricted', () => {
  // The 10th OR any Monday at 09:00.
  const parsed = parseCron('0 9 10 * 1');
  // 2026-11-10 is a Tuesday -> dom match.
  assert.equal(cronMatches(parsed, new Date('2026-11-10T12:00:00Z'), 'America/Sao_Paulo'), true);
  // 2026-10-19 is a Monday -> dow match.
  assert.equal(cronMatches(parsed, new Date('2026-10-19T12:00:00Z'), 'America/Sao_Paulo'), true);
  // 2026-10-20 is a Tuesday and not the 10th.
  assert.equal(cronMatches(parsed, new Date('2026-10-20T12:00:00Z'), 'America/Sao_Paulo'), false);
});

test('nextCronDate finds the next weekday morning without skipping', () => {
  const parsed = parseCron('0 8 * * 1-5');
  const tz = 'America/Sao_Paulo';
  // Tuesday 09:00 local -> Wednesday 08:00 local.
  assert.equal(
    nextCronDate(parsed, new Date('2026-10-20T12:00:00Z'), tz)?.toISOString(),
    '2026-10-21T11:00:00.000Z',
  );
  // Tuesday 08:00 local, one minute before -> still Tuesday.
  assert.equal(
    nextCronDate(parsed, new Date('2026-10-20T10:59:00Z'), tz)?.toISOString(),
    '2026-10-20T11:00:00.000Z',
  );
});

test('nextCronDate skips to a yearly occurrence', () => {
  const parsed = parseCron('0 0 1 1 *');
  assert.equal(
    nextCronDate(parsed, new Date('2026-10-20T00:00:00Z'), 'America/Sao_Paulo')?.toISOString(),
    '2027-01-01T03:00:00.000Z',
  );
});

test('zonedParts reports the wall clock and weekday', () => {
  const parts = zonedParts(new Date('2026-10-20T03:05:00Z'), 'America/Sao_Paulo');
  assert.deepEqual(
    { month: parts.month, day: parts.day, hour: parts.hour, minute: parts.minute, dow: parts.dow },
    { month: 10, day: 20, hour: 0, minute: 5, dow: 2 },
  );
});
