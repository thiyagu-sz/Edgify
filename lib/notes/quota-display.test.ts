import { describe, expect, it } from "vitest";
import { quotaState } from "./quota-display";

/**
 * Quota is a product surface, not an error (docs/04 §5). The counter is hidden below 80% used,
 * quiet at/above 80%, and friendly (never alarming) at 0. Copy must never read as a failure.
 */

describe("quotaState", () => {
  it("shows nothing when usage is unknown", () => {
    expect(quotaState(null, null)).toEqual({ show: false });
    expect(quotaState(5, null)).toEqual({ show: false });
    expect(quotaState(null, 30)).toEqual({ show: false });
  });

  it("shows nothing below 80% used", () => {
    expect(quotaState(30, 30).show).toBe(false); // 0% used
    expect(quotaState(20, 30).show).toBe(false); // 33% used
    expect(quotaState(7, 30).show).toBe(false); // ~77% used
  });

  it("shows a quiet counter from 80% used", () => {
    expect(quotaState(6, 30)).toEqual({ show: true, exhausted: false, text: "6 generations left today" });
  });

  it("uses the singular at one generation left", () => {
    expect(quotaState(1, 30)).toEqual({ show: true, exhausted: false, text: "1 generation left today" });
  });

  it("shows a friendly, non-error message when exhausted", () => {
    const state = quotaState(0, 30);
    expect(state.show).toBe(true);
    expect(state).toMatchObject({ exhausted: true });
    if (state.show) {
      expect(state.text).toMatch(/used today's generations/i);
      expect(state.text).toMatch(/resets at midnight/i);
      expect(state.text).not.toMatch(/error|quota exceeded|limit reached/i);
    }
  });

  /** The 80% line is the whole behaviour, so pin both sides of it exactly. */
  it("switches on at exactly 80% used, not before", () => {
    // limit 10: 2 remaining is exactly 80% used → show; 3 remaining is 70% → hide.
    expect(quotaState(3, 10).show).toBe(false);
    expect(quotaState(2, 10).show).toBe(true);

    // limit 30: 6 remaining is exactly 80% → show; 7 remaining is ~76.7% → hide.
    expect(quotaState(7, 30).show).toBe(false);
    expect(quotaState(6, 30).show).toBe(true);
  });

  it("treats a nonsensical limit as unknown rather than guessing", () => {
    expect(quotaState(5, 0).show).toBe(false);
    expect(quotaState(5, -1).show).toBe(false);
  });

  it("stays in the exhausted state if remaining goes negative", () => {
    // A race between two in-flight generations can overshoot; it must not read as "-1 left".
    const state = quotaState(-1, 30);
    expect(state).toMatchObject({ show: true, exhausted: true });
    if (state.show) expect(state.text).not.toContain("-1");
  });

  it("handles a limit of one", () => {
    expect(quotaState(1, 1).show).toBe(false); // 0% used
    expect(quotaState(0, 1)).toMatchObject({ show: true, exhausted: true });
  });

  it("never phrases any state as an error, at any level", () => {
    for (let remaining = -2; remaining <= 30; remaining++) {
      const state = quotaState(remaining, 30);
      if (!state.show) continue;
      expect(state.text, `remaining=${remaining}`).not.toMatch(
        /error|exceeded|denied|forbidden|limit reached|too many/i,
      );
    }
  });
});
