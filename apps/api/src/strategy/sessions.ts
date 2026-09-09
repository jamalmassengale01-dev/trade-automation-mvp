/**
 * Session windows and broker-day boundaries, all in America/New_York.
 * Uses Intl so DST is handled without a timezone library.
 */
export type Session = 'london' | 'nyam' | 'nypm';

export const SESSION_WINDOWS: Record<Session, { startMin: number; endMin: number; label: string }> = {
  london: { startMin: 3 * 60,  endMin: 3 * 60 + 30,  label: 'London 3:00–3:30 ET' },
  nyam:   { startMin: 10 * 60, endMin: 10 * 60 + 30, label: 'NY AM 10:00–10:30 ET' },
  nypm:   { startMin: 14 * 60, endMin: 14 * 60 + 30, label: 'NY PM 2:00–2:30 ET' },
};

/** Broker day rolls at 6:00 PM ET. */
export const BROKER_DAY_ROLL_HOUR_ET = 18;

const ET_FMT = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York',
  hour12: false,
  year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit',
});

export interface EtParts { year: number; month: number; day: number; hour: number; minute: number; second: number }

export function etParts(date: Date): EtParts {
  const parts = Object.fromEntries(
    ET_FMT.formatToParts(date).filter((p) => p.type !== 'literal').map((p) => [p.type, Number(p.value)])
  ) as Record<string, number>;
  // Some runtimes render midnight as "24"
  const hour = parts.hour === 24 ? 0 : parts.hour;
  return { year: parts.year, month: parts.month, day: parts.day, hour, minute: parts.minute, second: parts.second };
}

/** Minutes since ET midnight — the unit the session windows are expressed in. */
export function etMinutesOfDay(date: Date): number {
  const { hour, minute } = etParts(date);
  return hour * 60 + minute;
}

/**
 * Development-only session override.
 *
 * The strategy trades three 30-minute windows a day. That makes the execution
 * path untestable for 23 hours out of 24, and a path you can only exercise
 * during three narrow windows is a path that goes under-tested — which is how
 * a bug like the advisory-lock failure survived to production in the first
 * place.
 *
 * Setting GB_TEST_SESSION to a session name widens THAT session to the whole
 * day, so a test alert resolves to a real session and every downstream
 * behaviour — the used-flag column, the daily trade counter, the ladder — is
 * exercised exactly as it would be at 10:00 AM ET. Nothing about the gate
 * logic changes; only the window this one session occupies.
 *
 * Refuses to activate when NODE_ENV is production. That check lives here
 * rather than at the call site so there is exactly one place it can be got
 * wrong.
 */
const TEST_SESSION_ENV = 'GB_TEST_SESSION';

export function testSessionOverride(): Session | null {
  if (process.env.NODE_ENV === 'production') return null;
  const raw = (process.env[TEST_SESSION_ENV] ?? '').trim().toLowerCase();
  if (raw === 'london' || raw === 'nyam' || raw === 'nypm') return raw;
  return null;
}

/**
 * Session windows in effect, honouring the development override.
 * Exported so startup can log exactly what is active.
 */
export function effectiveSessionWindows(): typeof SESSION_WINDOWS {
  const override = testSessionOverride();
  if (!override) return SESSION_WINDOWS;
  return {
    ...SESSION_WINDOWS,
    [override]: {
      startMin: 0,
      endMin: 24 * 60 - 1,
      label: `${SESSION_WINDOWS[override].label} — WIDENED TO ALL DAY (${TEST_SESSION_ENV})`,
    },
  };
}

/** Returns which session a timestamp falls in (inclusive of the closing minute), or null. */
export function getSession(date: Date): Session | null {
  const { hour, minute } = etParts(date);
  const min = hour * 60 + minute;
  const windows = effectiveSessionWindows();
  // Iterate the canonical order so a widened window never shadows a real one:
  // a timestamp inside the true NY AM window still resolves to nyam.
  const order: Session[] = ['london', 'nyam', 'nypm'];
  const override = testSessionOverride();
  for (const name of order) {
    const w = SESSION_WINDOWS[name];
    if (min >= w.startMin && min <= w.endMin) return name;
  }
  if (override) {
    const w = windows[override];
    if (min >= w.startMin && min <= w.endMin) return override;
  }
  return null;
}

function pad(n: number): string { return n < 10 ? `0${n}` : String(n); }

/**
 * When a firm's trading day rolls over.
 *
 * Apex rolls at 6:00 PM ET. It is not a universal convention: Phidias ends its
 * session at 10:00 PM UTC+2, which is roughly 4:00 PM ET — a different day
 * boundary AND an earlier one, so the same fill can belong to different broker
 * days at the two firms.
 *
 * The boundary is expressed as an hour in a named zone rather than a fixed UTC
 * offset so each firm's own DST is applied to its own rule. That matters most
 * in the weeks each autumn when EU and US clocks change on different dates and
 * a fixed offset would silently drift by an hour.
 */
export interface BrokerDayBoundary {
  /** IANA zone the hour is expressed in, e.g. 'America/New_York', 'Europe/Paris'. */
  timeZone: string;
  /** Hour (0-23) in that zone at or after which the day rolls to the next date. */
  hour: number;
}

export const APEX_DAY_BOUNDARY: BrokerDayBoundary = {
  timeZone: 'America/New_York',
  hour: BROKER_DAY_ROLL_HOUR_ET,
};

/** Calendar parts of `date` in an arbitrary zone. */
function zoneParts(date: Date, timeZone: string): { year: number; month: number; day: number; hour: number } {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23',
  });
  const parts = Object.fromEntries(fmt.formatToParts(date).map((p) => [p.type, p.value]));
  return {
    year: Number(parts.year), month: Number(parts.month),
    day: Number(parts.day), hour: Number(parts.hour),
  };
}

/**
 * Broker day key: YYYY-MM-DD. At or after the boundary hour the day belongs to
 * the NEXT calendar date.
 *
 * Defaults to Apex's 6:00 PM ET, so existing callers are unchanged:
 * 2026-09-15 18:30 ET → "2026-09-16"; 2026-09-15 17:59 ET → "2026-09-15".
 */
export function brokerDayKey(date: Date, boundary: BrokerDayBoundary = APEX_DAY_BOUNDARY): string {
  const p = boundary.timeZone === 'America/New_York'
    ? etParts(date)
    : zoneParts(date, boundary.timeZone);

  if (p.hour >= boundary.hour) {
    // Advance one calendar day using UTC arithmetic on the local calendar date
    const next = new Date(Date.UTC(p.year, p.month - 1, p.day + 1));
    return `${next.getUTCFullYear()}-${pad(next.getUTCMonth() + 1)}-${pad(next.getUTCDate())}`;
  }
  return `${p.year}-${pad(p.month)}-${pad(p.day)}`;
}

export function sessionFlagColumn(session: Session): 'london_used' | 'nyam_used' | 'nypm_used' {
  return `${session}_used` as const;
}

/** Normalise a DB DATE (Date object or 'YYYY-MM-DD' string) to a day-key string. */
export function toDayKey(value: Date | string | null | undefined): string | null {
  if (!value) return null;
  if (typeof value === 'string') return value.slice(0, 10);
  return `${value.getUTCFullYear()}-${pad(value.getUTCMonth() + 1)}-${pad(value.getUTCDate())}`;
}

/** Minutes past midnight in an arbitrary IANA zone. */
export function zoneMinutesOfDay(date: Date, timeZone: string): number {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  });
  const parts = Object.fromEntries(fmt.formatToParts(date).map((p) => [p.type, p.value]));
  return Number(parts.hour) * 60 + Number(parts.minute);
}
