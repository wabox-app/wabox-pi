// Minimal, dependency-free cron. Five fields (minute hour day-of-month month
// day-of-week) plus the common @aliases. Matching is time-zone aware: the box
// often runs UTC while the conversation lives elsewhere, so a schedule must be
// evaluated in the wall clock the operator means.
//
// Standard semantics: when both day-of-month and day-of-week are restricted the
// match is OR; if either is `*` the match is AND.

const FIELDS = [
  { name: 'minute', min: 0, max: 59 },
  { name: 'hour', min: 0, max: 23 },
  { name: 'dom', min: 1, max: 31 },
  { name: 'month', min: 1, max: 12 },
  { name: 'dow', min: 0, max: 7 },
];

const ALIASES = {
  '@yearly': '0 0 1 1 *',
  '@annually': '0 0 1 1 *',
  '@monthly': '0 0 1 * *',
  '@weekly': '0 0 * * 0',
  '@daily': '0 0 * * *',
  '@midnight': '0 0 * * *',
  '@hourly': '0 * * * *',
};

const formatters = new Map();

function formatterFor(timezone) {
  const key = timezone || '';
  let formatter = formatters.get(key);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone || undefined,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });
    formatters.set(key, formatter);
  }
  return formatter;
}

function parseField(part, { name, min, max }) {
  const values = new Set();
  for (const chunk of part.split(',')) {
    const [range, stepText] = chunk.split('/');
    const step = stepText === undefined ? 1 : Number.parseInt(stepText, 10);
    if (!Number.isInteger(step) || step <= 0) {
      throw new Error(`invalid step in ${name}: ${chunk}`);
    }

    let lo = min;
    let hi = max;
    if (range !== '*') {
      const bounds = range.split('-');
      lo = Number.parseInt(bounds[0], 10);
      hi = bounds.length > 1 ? Number.parseInt(bounds[1], 10) : lo;
      if (!Number.isInteger(lo) || !Number.isInteger(hi)) {
        throw new Error(`invalid value in ${name}: ${chunk}`);
      }
      if (lo < min || hi > max || lo > hi) {
        throw new Error(`out of range in ${name}: ${chunk} (${min}-${max})`);
      }
    }

    for (let value = lo; value <= hi; value += step) values.add(value);
  }
  if (!values.size) throw new Error(`empty field ${name}`);
  return values;
}

export function parseCron(expression) {
  const raw = String(expression ?? '').trim();
  if (!raw) throw new Error('empty cron expression');
  const normalized = ALIASES[raw.toLowerCase()] ?? raw;
  const parts = normalized.split(/\s+/);
  if (parts.length !== 5) {
    throw new Error(`expected 5 fields, got ${parts.length}: ${raw}`);
  }

  const sets = {};
  parts.forEach((part, index) => {
    sets[FIELDS[index].name] = parseField(part, FIELDS[index]);
  });
  // Sunday is 0 or 7.
  if (sets.dow.has(7)) {
    sets.dow.add(0);
    sets.dow.delete(7);
  }

  return {
    expression: raw,
    sets,
    domRestricted: parts[2] !== '*',
    dowRestricted: parts[4] !== '*',
  };
}

export function zonedParts(date, timezone) {
  const parts = formatterFor(timezone).formatToParts(date);
  const get = (type) => Number.parseInt(parts.find((p) => p.type === type)?.value ?? '', 10);
  const year = get('year');
  const month = get('month');
  const day = get('day');
  return {
    year,
    month,
    day,
    hour: get('hour'),
    minute: get('minute'),
    dow: new Date(Date.UTC(year, month - 1, day)).getUTCDay(),
  };
}

function dateMatches(parsed, parts) {
  const { sets, domRestricted, dowRestricted } = parsed;
  if (!sets.month.has(parts.month)) return false;
  const domMatch = sets.dom.has(parts.day);
  const dowMatch = sets.dow.has(parts.dow);
  if (domRestricted && dowRestricted) return domMatch || dowMatch;
  return domMatch && dowMatch;
}

export function cronMatches(parsed, date, timezone) {
  const parts = zonedParts(date, timezone);
  return (
    dateMatches(parsed, parts) &&
    parsed.sets.hour.has(parts.hour) &&
    parsed.sets.minute.has(parts.minute)
  );
}

// The next occurrence strictly after `from`. Only used for display (status,
// /tasks), so a day-at-a-time search is fast enough even for a yearly cron.
export function nextCronDate(parsed, from = new Date(), timezone, { maxDays = 370 } = {}) {
  const afterMs = from.getTime();
  const end = afterMs + maxDays * 24 * 3600 * 1000;
  let cursor = new Date((Math.floor(afterMs / 60000) + 1) * 60000);

  while (cursor.getTime() <= end) {
    const parts = zonedParts(cursor, timezone);
    if (!dateMatches(parsed, parts)) {
      // Jump to the next local midnight and re-evaluate there.
      cursor = new Date(
        cursor.getTime() + ((23 - parts.hour) * 3600 + (59 - parts.minute) * 60) * 1000 + 60000,
      );
      continue;
    }

    // Scan the whole local day from midnight so an earlier hour (before the
    // current cursor) is not skipped. Ignore matches at or before `from`.
    const midnight = new Date(
      cursor.getTime() - (parts.hour * 3600 + parts.minute * 60) * 1000,
    );
    const dayEnd = midnight.getTime() + 24 * 3600 * 1000;
    let probe = midnight;
    while (probe.getTime() < dayEnd) {
      const p = zonedParts(probe, timezone);
      if (p.day !== parts.day) break; // crossed into the next local day
      if (
        probe.getTime() > afterMs &&
        parsed.sets.hour.has(p.hour) &&
        parsed.sets.minute.has(p.minute)
      ) {
        return probe;
      }
      probe = new Date(probe.getTime() + 60000);
    }
    cursor = new Date(dayEnd);
  }
  return null;
}
