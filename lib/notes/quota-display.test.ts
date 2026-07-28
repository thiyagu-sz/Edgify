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
});
