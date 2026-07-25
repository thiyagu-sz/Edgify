import { describe, expect, it } from "vitest";
import { dayKey } from "./quota";

/**
 * The reset boundary, proven in isolation (no DB). Default QUOTA_TIMEZONE is UTC — a deliberate
 * choice (docs/09 §3.4). The DB-level "a new day gets a fresh row" half is in
 * quota.integration.test.ts.
 */
describe("dayKey — UTC calendar-day boundary", () => {
  it("formats as YYYY-MM-DD in UTC", () => {
    expect(dayKey(new Date("2026-07-25T12:00:00Z"))).toBe("2026-07-25");
  });

  it("rolls over at UTC midnight, not the machine's local midnight", () => {
    expect(dayKey(new Date("2026-07-25T23:59:59Z"))).toBe("2026-07-25");
    expect(dayKey(new Date("2026-07-26T00:00:01Z"))).toBe("2026-07-26");
  });

  it("puts 23:30Z and 00:30Z (61 minutes apart) in different days", () => {
    expect(dayKey(new Date("2026-07-25T23:30:00Z"))).not.toBe(
      dayKey(new Date("2026-07-26T00:30:00Z")),
    );
  });
});
