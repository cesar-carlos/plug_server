import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";

import {
  toUtcIso,
  nowUtcIso,
  toLogTimestamp,
  nowLogTimestamp,
  toDateOnly,
  toTimeOnly,
  isValidDate,
  addToDate,
  diffInUnit,
  isBefore,
  isAfter,
  isExpired,
} from "../../../../src/shared/utils/date";

const FIXED_DATE = "2026-03-16T18:00:00.000Z";

describe("date helpers", () => {
  describe("toUtcIso", () => {
    it("should convert a Date to UTC ISO string", () => {
      const result = toUtcIso(new Date(FIXED_DATE));
      expect(result).toBe(FIXED_DATE);
    });

    it("should convert a timestamp number to UTC ISO string", () => {
      const ts = new Date(FIXED_DATE).getTime();
      const result = toUtcIso(ts);
      expect(result).toBe(FIXED_DATE);
    });

    it("should convert an ISO string to UTC ISO string", () => {
      const result = toUtcIso(FIXED_DATE);
      expect(result).toBe(FIXED_DATE);
    });
  });

  describe("nowUtcIso", () => {
    beforeEach(() => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date(FIXED_DATE));
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("should return the current UTC ISO string", () => {
      expect(nowUtcIso()).toBe(FIXED_DATE);
    });
  });

  describe("toLogTimestamp", () => {
    it("should format a date as a human-readable log timestamp", () => {
      const result = toLogTimestamp(new Date(FIXED_DATE));
      expect(result).toBe("2026-03-16 18:00:00 UTC");
    });
  });

  describe("nowLogTimestamp", () => {
    beforeEach(() => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date(FIXED_DATE));
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("should return the current time as a log timestamp", () => {
      expect(nowLogTimestamp()).toBe("2026-03-16 18:00:00 UTC");
    });
  });

  describe("toDateOnly", () => {
    it("should return only the date portion in YYYY-MM-DD format", () => {
      expect(toDateOnly(FIXED_DATE)).toBe("2026-03-16");
    });
  });

  describe("toTimeOnly", () => {
    it("should return only the time portion in HH:mm:ss format", () => {
      expect(toTimeOnly(FIXED_DATE)).toBe("18:00:00");
    });
  });

  describe("isValidDate", () => {
    it("should return true for a valid ISO 8601 date string", () => {
      expect(isValidDate("2026-03-16T18:00:00.000Z")).toBe(true);
    });

    it("should return false for an invalid date string", () => {
      expect(isValidDate("not-a-date")).toBe(false);
    });

    it("should return false for a partial date without strict ISO format", () => {
      expect(isValidDate("2026-13-01")).toBe(false);
    });
  });

  describe("addToDate", () => {
    it("should add hours to a date", () => {
      const result = addToDate(FIXED_DATE, 2, "hours");
      expect(result).toBe("2026-03-16T20:00:00.000Z");
    });

    it("should add days to a date", () => {
      const result = addToDate(FIXED_DATE, 1, "days");
      expect(result).toBe("2026-03-17T18:00:00.000Z");
    });

    it("should add minutes to a date", () => {
      const result = addToDate(FIXED_DATE, 30, "minutes");
      expect(result).toBe("2026-03-16T18:30:00.000Z");
    });
  });

  describe("diffInUnit", () => {
    it("should return the difference in hours between two dates", () => {
      const later = "2026-03-16T20:00:00.000Z";
      expect(diffInUnit(later, FIXED_DATE, "hours")).toBe(2);
    });

    it("should return the difference in minutes", () => {
      const later = "2026-03-16T18:45:00.000Z";
      expect(diffInUnit(later, FIXED_DATE, "minutes")).toBe(45);
    });

    it("should return a negative value when dateA is before dateB", () => {
      const earlier = "2026-03-16T16:00:00.000Z";
      expect(diffInUnit(earlier, FIXED_DATE, "hours")).toBe(-2);
    });
  });

  describe("isBefore", () => {
    it("should return true when date is before reference", () => {
      expect(isBefore("2026-03-16T17:00:00.000Z", FIXED_DATE)).toBe(true);
    });

    it("should return false when date is after reference", () => {
      expect(isBefore("2026-03-16T19:00:00.000Z", FIXED_DATE)).toBe(false);
    });
  });

  describe("isAfter", () => {
    it("should return true when date is after reference", () => {
      expect(isAfter("2026-03-16T19:00:00.000Z", FIXED_DATE)).toBe(true);
    });

    it("should return false when date is before reference", () => {
      expect(isAfter("2026-03-16T17:00:00.000Z", FIXED_DATE)).toBe(false);
    });
  });

  describe("isExpired", () => {
    beforeEach(() => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date(FIXED_DATE));
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("should return true for a date in the past", () => {
      expect(isExpired("2026-03-16T17:00:00.000Z")).toBe(true);
    });

    it("should return false for a date in the future", () => {
      expect(isExpired("2026-03-16T19:00:00.000Z")).toBe(false);
    });
  });
});
