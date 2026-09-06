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

/** Returns which session a timestamp falls in (inclusive of the closing minute), or null. */
export function getSession(date: Date): Session | null {
  const { hour, minute } = etParts(date);
  const min = hour * 60 + minute;
  for (const [name, w] of Object.entries(SESSION_WINDOWS) as Array<[Session, typeof SESSION_WINDOWS[Session]]>) {
    if (min >= w.startMin && min <= w.endMin) return name;
  }
  return null;
}

function pad(n: number): string { return n < 10 ? `0${n}` : String(n); }

/**
 * Broker day key: YYYY-MM-DD. At or after 6:00 PM ET the day belongs to the NEXT calendar date.
 * e.g. 2026-09-15 18:30 ET → "2026-09-16"; 2026-09-15 17:59 ET → "2026-09-15".
 */
export function brokerDayKey(date: Date): string {
  const p = etParts(date);
  if (p.hour >= BROKER_DAY_ROLL_HOUR_ET) {
    // Advance one calendar day using UTC arithmetic on the ET calendar date
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
