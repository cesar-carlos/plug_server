import moment from "moment";

export type DateInput = string | number | Date | moment.Moment;

/**
 * ISO 8601 timestamp in UTC — use for API responses and logs.
 * Example: "2026-03-16T18:00:00.000Z"
 */
export const toUtcIso = (date?: DateInput): string => {
  return moment(date).utc().toISOString();
};

/**
 * Current UTC timestamp in ISO 8601 format.
 */
export const nowUtcIso = (): string => {
  return moment.utc().toISOString();
};

/**
 * Human-readable UTC timestamp for log lines.
 * Example: "2026-03-16 18:00:00 UTC"
 */
export const toLogTimestamp = (date?: DateInput): string => {
  return moment(date).utc().format("YYYY-MM-DD HH:mm:ss [UTC]");
};

/**
 * Current log timestamp.
 */
export const nowLogTimestamp = (): string => {
  return toLogTimestamp();
};

/**
 * Date only in ISO format.
 * Example: "2026-03-16"
 */
export const toDateOnly = (date?: DateInput): string => {
  return moment(date).utc().format("YYYY-MM-DD");
};

/**
 * Time only in UTC.
 * Example: "18:00:00"
 */
export const toTimeOnly = (date?: DateInput): string => {
  return moment(date).utc().format("HH:mm:ss");
};

/**
 * Parses a date string and returns whether it is valid.
 */
export const isValidDate = (value: string): boolean => {
  return moment(value, moment.ISO_8601, true).isValid();
};

/**
 * Adds a duration to a date and returns the result as a UTC ISO string.
 * Example: addToDate(new Date(), 1, "hours") → "2026-03-16T19:00:00.000Z"
 */
export const addToDate = (
  date: DateInput,
  amount: number,
  unit: moment.DurationInputArg2,
): string => {
  return moment(date).utc().add(amount, unit).toISOString();
};

/**
 * Returns the difference between two dates in the given unit.
 * Example: diffInUnit("2026-03-16T18:00:00Z", "2026-03-16T17:00:00Z", "minutes") → 60
 */
export const diffInUnit = (
  dateA: DateInput,
  dateB: DateInput,
  unit: moment.unitOfTime.Diff,
): number => {
  return moment(dateA).diff(moment(dateB), unit);
};

/**
 * Returns whether a date is before another date.
 */
export const isBefore = (date: DateInput, reference: DateInput): boolean => {
  return moment(date).isBefore(moment(reference));
};

/**
 * Returns whether a date is after another date.
 */
export const isAfter = (date: DateInput, reference: DateInput): boolean => {
  return moment(date).isAfter(moment(reference));
};

/**
 * Returns whether a date has already expired relative to now.
 */
export const isExpired = (date: DateInput): boolean => {
  return moment(date).isBefore(moment.utc());
};

/**
 * Parses a shorthand expiry string (e.g. "7d", "15m", "1h") into a future Date.
 * Supported units: s (seconds), m (minutes), h (hours), d (days), w (weeks).
 *
 * @example parseExpiryToDate("7d") → Date 7 days from now
 */
export const parseExpiryToDate = (expiry: string): Date => {
  const match = /^(\d+)([smhdw])$/.exec(expiry);
  if (!match) {
    throw new Error(`Invalid expiry format: "${expiry}". Use formats like "7d", "1h", "30m".`);
  }

  const amount = parseInt(match[1] as string, 10);
  const unitKey = match[2] as string;

  const unitMap: Record<string, moment.DurationInputArg2> = {
    s: "seconds",
    m: "minutes",
    h: "hours",
    d: "days",
    w: "weeks",
  };

  return moment().utc().add(amount, unitMap[unitKey]).toDate();
};
