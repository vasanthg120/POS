/**
 * Reporting-period presets shared by the Super Admin pages.
 *
 * Those pages used to offer only "Month + Year", defaulting to the current
 * month — so with 108 CRM quotations synced, the dashboard showed the 11
 * created this month and looked like data was missing. "All time" is now the
 * default and the other presets are one click away.
 */

export type PeriodPreset =
  | 'all' | 'this_month' | 'last_month' | 'last_30' | 'last_90'
  | 'this_quarter' | 'this_year' | 'month';

export interface PeriodState {
  preset: PeriodPreset;
  /** 1-12, used when preset === 'month' */
  month: number;
  year: number;
}

/** Query params understood by the backend's resolvePeriod(). */
export interface PeriodParams {
  period?: 'all';
  month?: number;
  year?: number;
  dateFrom?: string;
  dateTo?: string;
}

export const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

export const PERIOD_PRESETS: { value: PeriodPreset; label: string }[] = [
  { value: 'all', label: 'All time' },
  { value: 'this_month', label: 'This month' },
  { value: 'last_month', label: 'Last month' },
  { value: 'last_30', label: 'Last 30 days' },
  { value: 'last_90', label: 'Last 90 days' },
  { value: 'this_quarter', label: 'This quarter' },
  { value: 'this_year', label: 'This year' },
  { value: 'month', label: 'Pick a month…' },
];

export const defaultPeriod = (): PeriodState => {
  const now = new Date();
  return { preset: 'all', month: now.getMonth() + 1, year: now.getFullYear() };
};

/** yyyy-mm-dd in local time (toISOString() would shift the day in IST). */
const ymd = (d: Date): string =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

export function periodParams(s: PeriodState): PeriodParams {
  const now = new Date();
  const today = ymd(now);
  const daysAgo = (n: number) => ymd(new Date(now.getFullYear(), now.getMonth(), now.getDate() - n));

  switch (s.preset) {
    case 'all':          return { period: 'all' };
    case 'this_month':   return { month: now.getMonth() + 1, year: now.getFullYear() };
    case 'last_month': {
      const d = new Date(now.getFullYear(), now.getMonth() - 1, 1);
      return { month: d.getMonth() + 1, year: d.getFullYear() };
    }
    case 'last_30':      return { dateFrom: daysAgo(29), dateTo: today };
    case 'last_90':      return { dateFrom: daysAgo(89), dateTo: today };
    case 'this_quarter': {
      const qStart = new Date(now.getFullYear(), Math.floor(now.getMonth() / 3) * 3, 1);
      return { dateFrom: ymd(qStart), dateTo: today };
    }
    case 'this_year':    return { dateFrom: `${now.getFullYear()}-01-01`, dateTo: today };
    case 'month':        return { month: s.month, year: s.year };
  }
}

export function periodLabel(s: PeriodState): string {
  if (s.preset === 'month') return `${MONTH_NAMES[s.month - 1]} ${s.year}`;
  if (s.preset === 'this_month') {
    const now = new Date();
    return `${MONTH_NAMES[now.getMonth()]} ${now.getFullYear()}`;
  }
  if (s.preset === 'last_month') {
    const now = new Date();
    const d = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    return `${MONTH_NAMES[d.getMonth()]} ${d.getFullYear()}`;
  }
  return PERIOD_PRESETS.find(p => p.value === s.preset)?.label ?? 'All time';
}

export function yearOptions(): number[] {
  const y = new Date().getFullYear();
  return [y - 3, y - 2, y - 1, y];
}
