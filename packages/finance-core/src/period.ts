// Port of app/services/finance/dashboard_period.rb.
import type { IsoDate, Period, PeriodPreset } from "@billie/shared-types";

export const PRESETS: PeriodPreset[] = ["all_time", "this_month", "last_month", "last_30_days", "this_year", "last_year", "custom"];

export class InvalidPeriod extends Error {}

const iso = (date: Date) =>
  `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(date.getUTCDate()).padStart(2, "0")}`;
const utc = (year: number, month: number, day: number) => new Date(Date.UTC(year, month, day));

/** Today's date on this device, as YYYY-MM-DD. */
export function localToday(now = new Date()): IsoDate {
  return iso(utc(now.getFullYear(), now.getMonth(), now.getDate()));
}

export function resolvePeriod(preset: PeriodPreset, options: { today: IsoDate; startDate?: string; endDate?: string }): Period {
  const [year, month, day] = options.today.split("-").map(Number);
  const m = month - 1;
  let startDate: IsoDate | null = null;
  let endDate: IsoDate | null = null;
  switch (preset) {
    case "all_time":
      break;
    case "this_month":
      [startDate, endDate] = [iso(utc(year, m, 1)), iso(utc(year, m + 1, 0))];
      break;
    case "last_month":
      [startDate, endDate] = [iso(utc(year, m - 1, 1)), iso(utc(year, m, 0))];
      break;
    case "last_30_days":
      [startDate, endDate] = [iso(utc(year, m, day - 29)), options.today];
      break;
    case "this_year":
      [startDate, endDate] = [`${year}-01-01`, `${year}-12-31`];
      break;
    case "last_year":
      [startDate, endDate] = [`${year - 1}-01-01`, `${year - 1}-12-31`];
      break;
    case "custom": {
      if (!options.startDate || !options.endDate) throw new InvalidPeriod("Choose both a start and an end date.");
      startDate = parseIso(options.startDate);
      endDate = parseIso(options.endDate);
      break;
    }
    default:
      throw new InvalidPeriod("Unknown date range.");
  }
  if (startDate && endDate && startDate > endDate) throw new InvalidPeriod("The start date must be on or before the end date.");
  return { preset, startDate, endDate };
}

function parseIso(value: string): IsoDate {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) throw new InvalidPeriod("Use dates in YYYY-MM-DD format.");
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const date = utc(year, month - 1, day);
  if (date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day || year < 1900 || year > 2100) {
    throw new InvalidPeriod("Use dates in YYYY-MM-DD format.");
  }
  return value;
}
