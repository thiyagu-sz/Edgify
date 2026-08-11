import { render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The analytics seam's runtime behaviour, in a browser-like environment.
 *
 * The property that matters most is the DEFAULT one: with no `NEXT_PUBLIC_POSTHOG_KEY` — which is
 * the current production state and the state of every test run — nothing may be initialised and
 * no event may be sent. An analytics layer that quietly fires against an uninitialised SDK is how
 * a "no-op until configured" design turns into console errors in production.
 *
 * posthog-js is mocked at the module boundary so "was anything sent?" is directly observable.
 */

const capture = vi.fn();
const init = vi.fn();
const identify = vi.fn();
const reset = vi.fn();

vi.mock("posthog-js", () => ({
  default: { init, capture, identify, reset },
}));

const { track, identifyUser, resetAnalytics, analyticsEnabled, fileKindOf } =
  await import("@/lib/analytics");
const { AnalyticsProvider } = await import("./analytics-provider");
const { AnalyticsIdentity } = await import("./analytics-identity");

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("with no key configured — the default, and production today", () => {
  it("reports itself disabled", () => {
    expect(process.env.NEXT_PUBLIC_POSTHOG_KEY).toBeFalsy();
    expect(analyticsEnabled()).toBe(false);
  });

  it("sends no event", () => {
    track({ name: "notes_generation_started", props: { format: "key_points", source: "paste" } });
    track("demo_opened");
    expect(capture).not.toHaveBeenCalled();
  });

  it("identifies and resets nobody", () => {
    identifyUser("user-123");
    resetAnalytics();
    expect(identify).not.toHaveBeenCalled();
    expect(reset).not.toHaveBeenCalled();
  });

  it("initialises nothing when the provider mounts", () => {
    render(<AnalyticsProvider />);
    expect(init).not.toHaveBeenCalled();
  });

  it("renders nothing at all, so it cannot affect layout", () => {
    const { container } = render(<AnalyticsProvider />);
    expect(container).toBeEmptyDOMElement();
  });

  it("the identity component is inert and invisible", () => {
    const { container } = render(<AnalyticsIdentity userId="user-123" />);
    expect(identify).not.toHaveBeenCalled();
    expect(container).toBeEmptyDOMElement();
  });
});

describe("fileKindOf maps a name to a bounded vocabulary", () => {
  it.each([
    ["lecture.pdf", "pdf"],
    ["Notes.DOCX", "docx"],
    ["scratch.txt", "txt"],
    ["readme.md", "md"],
    ["readme.markdown", "md"],
    ["archive.zip", "other"],
    ["no-extension", "other"],
  ])("%s → %s", (name, expected) => {
    expect(fileKindOf(name)).toBe(expected);
  });

  it("returns only the extension, never any part of the name", () => {
    // The whole point of the helper: the name is the thing that must not travel.
    const sensitive = "Sarah_Okonkwo_thesis_draft_confidential.pdf";
    expect(fileKindOf(sensitive)).toBe("pdf");
    expect(fileKindOf(sensitive)).not.toContain("Sarah");
  });
});
